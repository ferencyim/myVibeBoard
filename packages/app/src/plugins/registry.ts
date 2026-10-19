import type { AudioEngine } from "@/audio";
import { useMemo, useSyncExternalStore } from "react";
import { QueryClient } from "@tanstack/react-query";
import { createPaseoApi, type PaseoApi } from "@getpaseo/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { assertPluginCompatibility } from "@getpaseo/protocol/plugin-requirements";
import { getHostRuntimeStore, isHostRuntimeConnected } from "@/runtime/host-runtime";
import { resolveAppVersion } from "@/utils/app-version";
import { invokeOfflineVibeRpc } from "@/vibe/rpc/provider";
import { createPluginClientRuntime } from "./client-runtime";
import { runPluginClientBundle } from "./evaluate";
import type { InstalledPlugin } from "./types";

export type CatalogPlugin = Awaited<ReturnType<DaemonClient["getPluginCatalog"]>>[number];

/** Stands in for the daemon-bound Paseo API while a host is offline: every call fails loudly. */
function createOfflinePaseoApi(): PaseoApi {
  const offline = (): never => {
    throw new Error("[offline] Paseo is not reachable right now");
  };
  const node = (): unknown =>
    new Proxy(offline, {
      get: (_target, property) => {
        if (property === "then") return undefined;
        if (property === "dispose") return async () => undefined;
        return node();
      },
    });
  return node() as PaseoApi;
}

export class PluginRegistry {
  private readonly byHost = new Map<string, InstalledPlugin[]>();
  private readonly listeners = new Set<() => void>();
  private snapshot: InstalledPlugin[] = [];
  private readonly disposed = new WeakSet<InstalledPlugin>();
  private readonly evaluationErrors = new Map<string, string>();
  /** The client each installation was created with (null = restored from the offline cache). */
  private readonly installedWith = new WeakMap<InstalledPlugin, DaemonClient | null>();

  constructor(
    private readonly dependencies: {
      version: string | null;
      createRuntime: typeof createPluginClientRuntime;
      /** The host's client while it is connected; null = offline. Default: the install-time client. */
      getLiveClient?: (serverId: string) => DaemonClient | null;
      /** Answers a plugin RPC while the host is offline (local replica); default: reject. */
      invokeOffline?: (
        serverId: string,
        pluginId: string,
        method: string,
        input: unknown,
      ) => Promise<unknown>;
    },
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): InstalledPlugin[] => this.snapshot;

  getEvaluationError(serverId: string, pluginId: string): string | undefined {
    return this.evaluationErrors.get(`${serverId}/${pluginId}`);
  }

  installCatalog(
    serverId: string,
    catalog: CatalogPlugin[],
    options: {
      replacePluginId?: string;
      /** null: install from the offline cache (no daemon behind the plugin's Paseo API). */
      client: DaemonClient | null;
      audio: Pick<AudioEngine, "play">;
    },
  ): boolean {
    const previous = this.byHost.get(serverId) ?? [];
    const previousTimelineBundles = previous
      .filter((plugin) => plugin.timelineTransformers.length > 0)
      .map((plugin) => `${plugin.id}\0${plugin.clientBundle}`);
    const preserved = catalog.flatMap((entry) => {
      const existing = previous.find(
        (plugin) =>
          plugin.id !== options.replacePluginId &&
          plugin.id === entry.id &&
          plugin.clientBundle === entry.clientBundle &&
          plugin.requirements?.paseo === entry.requirements?.paseo &&
          this.installedWith.get(plugin) === options.client,
      );
      return existing ? [existing] : [];
    });
    const removed = previous.filter((plugin) => !preserved.includes(plugin));
    if (removed.length > 0) {
      this.byHost.set(serverId, preserved);
      this.publish();
      for (const plugin of removed) this.dispose(plugin);
    }
    const installed = catalog.flatMap((entry) => {
      const key = `${serverId}/${entry.id}`;
      let installation: InstalledPlugin | undefined;
      try {
        if (!entry.clientBundle) return [];
        assertPluginCompatibility({ ...entry, version: this.dependencies.version, runtime: "app" });
        const existing = preserved.find((plugin) => plugin.id === entry.id);
        if (existing) {
          this.evaluationErrors.delete(key);
          return [existing];
        }
        const client = options.client;
        installation = {
          lifetime: new AbortController(),
          paseo: client ? createPaseoApi(client) : createOfflinePaseoApi(),
          invoke: (method, input) => this.invokeRpc(serverId, entry.id, client, method, input),
          id: entry.id,
          serverId,
          clientBundle: entry.clientBundle,
          requirements: entry.requirements,
          queryClient: new QueryClient(),
          cleanup: () => undefined,
          surfaces: [],
          settingsScreens: [],
          sidebarItems: { header: [], footer: [] },
          legacySidebarItems: [],
          workspacePanels: [],
          commandCenterItems: [],
          clientSlashCommands: [],
          attachmentSources: [],
          themes: [],
          timelineTransformers: [],
          timelineRenderers: [],
        };
        const runtime = this.dependencies.createRuntime(installation, options.audio);
        const evaluated = runPluginClientBundle(entry.id, entry.clientBundle, runtime, () =>
          this.publish(),
        );
        this.installedWith.set(installation, client);
        Object.assign(installation, evaluated);
        const paseo = installation.paseo;
        installation.cleanup = async () => {
          const results = await Promise.allSettled([paseo.dispose(), evaluated.cleanup()]);
          const failures = results.filter((result) => result.status === "rejected");
          if (failures.length)
            throw new AggregateError(
              failures.map((result) => result.reason),
              "Plugin cleanup failed",
            );
        };
        this.evaluationErrors.delete(key);
        return [installation];
      } catch (error) {
        installation?.lifetime.abort();
        void installation?.paseo
          .dispose()
          .catch((failure) => console.warn(`[Plugins] API cleanup failed for ${key}`, failure));
        this.evaluationErrors.set(key, error instanceof Error ? error.message : String(error));
        console.warn(`[Plugins] Failed to evaluate ${serverId}/${entry.id}`, error);
        return [];
      }
    });
    const configuredIds = new Set(catalog.map((entry) => entry.id));
    for (const key of this.evaluationErrors.keys()) {
      if (key.startsWith(`${serverId}/`) && !configuredIds.has(key.slice(serverId.length + 1))) {
        this.evaluationErrors.delete(key);
      }
    }
    this.byHost.set(serverId, installed);
    this.publish();
    const installedTimelineBundles = installed
      .filter((plugin) => plugin.timelineTransformers.length > 0)
      .map((plugin) => `${plugin.id}\0${plugin.clientBundle}`);
    return (
      previousTimelineBundles.length !== installedTimelineBundles.length ||
      previousTimelineBundles.some((bundle, index) => bundle !== installedTimelineBundles[index])
    );
  }

  /**
   * Cold start without a connection: evaluate the catalog cached from the last online session so
   * offline-capable plugins (vibe-board) open. A no-op once the host has any installation.
   */
  restoreFromCache(
    serverId: string,
    catalog: CatalogPlugin[],
    options: { audio: Pick<AudioEngine, "play"> },
  ): void {
    if ((this.byHost.get(serverId)?.length ?? 0) > 0) return;
    this.installCatalog(serverId, catalog, { client: null, audio: options.audio });
  }

  /** Drop installations of hosts that were removed from the app. */
  pruneHosts(serverIds: readonly string[]): void {
    for (const serverId of this.byHost.keys()) {
      if (!serverIds.includes(serverId)) this.removeHost(serverId);
    }
  }

  private invokeRpc(
    serverId: string,
    pluginId: string,
    installClient: DaemonClient | null,
    method: string,
    input: unknown,
  ): Promise<unknown> {
    const { getLiveClient, invokeOffline } = this.dependencies;
    const live = getLiveClient ? getLiveClient(serverId) : installClient;
    if (live) return live.invokePluginRpc(pluginId, method, input);
    if (invokeOffline) return invokeOffline(serverId, pluginId, method, input);
    return Promise.reject(new Error("[offline] Plugin host is offline"));
  }

  removeHost(serverId: string): void {
    const installed = this.byHost.get(serverId);
    if (!installed) return;
    for (const plugin of installed) this.dispose(plugin);
    for (const key of this.evaluationErrors.keys()) {
      if (key.startsWith(`${serverId}/`)) this.evaluationErrors.delete(key);
    }
    this.byHost.delete(serverId);
    this.publish();
  }

  private dispose(plugin: InstalledPlugin): void {
    if (this.disposed.has(plugin)) return;
    this.disposed.add(plugin);
    plugin.lifetime.abort();
    plugin.queryClient.clear();
    try {
      void Promise.resolve(plugin.cleanup()).catch((error) => {
        console.warn(`[Plugins] Cleanup failed for ${plugin.serverId}/${plugin.id}`, error);
      });
    } catch (error) {
      console.warn(`[Plugins] Cleanup failed for ${plugin.serverId}/${plugin.id}`, error);
    }
  }

  private publish(): void {
    this.snapshot = [...this.byHost.values()]
      .flat()
      .sort((left, right) =>
        `${left.serverId}/${left.id}`.localeCompare(`${right.serverId}/${right.id}`),
      );
    for (const listener of this.listeners) listener();
  }
}

export const pluginRegistry = new PluginRegistry({
  version: resolveAppVersion(),
  createRuntime: createPluginClientRuntime,
  getLiveClient: (serverId) => {
    const snapshot = getHostRuntimeStore().getSnapshot(serverId);
    return isHostRuntimeConnected(snapshot) ? (snapshot?.client ?? null) : null;
  },
  invokeOffline: invokeOfflineVibeRpc,
});

export function useInstalledPlugins(): InstalledPlugin[] {
  return useSyncExternalStore(
    pluginRegistry.subscribe,
    pluginRegistry.getSnapshot,
    pluginRegistry.getSnapshot,
  );
}

export function useInstalledPlugin(serverId: string, pluginId: string): InstalledPlugin | null {
  return (
    useInstalledPlugins().find(
      (plugin) => plugin.serverId === serverId && plugin.id === pluginId,
    ) ?? null
  );
}

export function usePluginInstallations(pluginId: string): InstalledPlugin[] {
  const installed = useInstalledPlugins();
  return useMemo(() => installed.filter((plugin) => plugin.id === pluginId), [installed, pluginId]);
}
