import { useVoiceAudioEngineOptional } from "@/contexts/voice-context";
import { pluginSettingsKey } from "./settings/use-settings";
import { useEffect } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { saveFirstMessageOutboxOwner } from "./first-message-outbox";
import { pluginRegistry } from "./registry";

export function PluginCatalogSync({
  serverId,
  client,
}: {
  serverId: string;
  /** null while the host has no client yet (cold start without a connection). */
  client: DaemonClient | null;
}) {
  const audio = useVoiceAudioEngineOptional();
  const connected = useHostRuntimeIsConnected(serverId);
  const supported = useHostFeature(serverId, "plugins");

  useEffect(() => {
    let cancelled = false;
    let refreshQueue = Promise.resolve();
    pluginRegistry.markCatalogLoading(serverId);
    if (!audio || (client && connected && !supported)) {
      pluginRegistry.removeHost(serverId);
      return;
    }
    if (!client || !connected) return;
    const getPluginError = (pluginId: string) => pluginRegistry.getPluginError(serverId, pluginId);
    const refresh = (replacePluginId?: string) => {
      pluginRegistry.markCatalogLoading(serverId);
      refreshQueue = refreshQueue.then(() =>
        Promise.all([client.getPluginCatalog(), client.listPlugins()])
          .then(async ([catalog, configured]) => {
            if (!cancelled) {
              pluginRegistry.installCatalog(serverId, catalog, {
                replacePluginId,
                client,
                audio,
                configured,
              });
              if (pluginRegistry.hasLoadedCatalog(serverId)) {
                await saveFirstMessageOutboxOwner(
                  serverId,
                  pluginRegistry.getSnapshot(),
                  getPluginError,
                );
              }
            }
            return undefined;
          })
          .catch((error) => {
            if (!cancelled) {
              pluginRegistry.markCatalogFailed(
                serverId,
                error instanceof Error ? error.message : String(error),
              );
              console.warn(`[Plugins] Failed to load catalog for ${serverId}`, error);
            }
            return undefined;
          }),
      );
      return refreshQueue;
    };
    const observation = client.observeEvents([
      "status.plugin_catalog_changed",
      "status.plugin_settings_changed",
    ]);
    observation.subscribe({
      snapshot: () => {
        void refresh();
      },
      update: (message) => {
        if (message.type !== "status") return;
        if (message.payload.status === "plugin_settings_changed") {
          const { pluginId, settingsId } = message.payload;
          if (typeof settingsId === "string") {
            const plugin = pluginRegistry
              .getSnapshot()
              .find((item) => item.serverId === serverId && item.id === pluginId);
            void plugin?.queryClient.invalidateQueries({ queryKey: pluginSettingsKey(settingsId) });
          }
        }
        if (message.payload.status === "plugin_catalog_changed") {
          const pluginId = message.payload.pluginId;
          if (typeof pluginId === "string") void refresh(pluginId);
        }
      },
    });
    return () => {
      cancelled = true;
      pluginRegistry.markCatalogLoading(serverId);
      void observation
        .release()
        .catch((error) => console.warn("[Plugins] Failed to release catalog", error));
    };
  }, [audio, client, connected, serverId, supported]);

  return null;
}
