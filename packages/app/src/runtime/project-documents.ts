import AsyncStorage from "@react-native-async-storage/async-storage";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { botSnapshotCache, pluginRegistry } from "@/plugins/registry";
import { ProjectDocumentCache, projectDocumentCacheSchema } from "@/projects/document-cache";
const caches = new Map<string, ProjectDocumentCache>();
const loads = new WeakMap<ProjectDocumentCache, Promise<unknown>>();
const outboxIds = new WeakMap<ProjectDocumentCache, Set<string>>();
const outboxListeners = new Set<() => void>();
export function getProjectDocumentCache(serverId: string, projectId: string) {
  const key = JSON.stringify([serverId, projectId]);
  let cache = caches.get(key);
  if (!cache) {
    cache = new ProjectDocumentCache(AsyncStorage, serverId, projectId);
    const created = cache;
    outboxIds.set(created, new Set());
    created.subscribe(() => {
      const previous = outboxIds.get(created)!;
      const next = new Set(created.snapshot().outbox.map((change) => change.id));
      outboxIds.set(created, next);
      if ([...next].some((id) => !previous.has(id))) {
        for (const listener of outboxListeners) listener();
      }
    });
    caches.set(key, cache);
  }
  return cache;
}
export async function loadProjectDocumentCache(cache: ProjectDocumentCache) {
  let promise = loads.get(cache);
  if (!promise) {
    promise = cache.load();
    loads.set(cache, promise);
  }
  await promise;
  outboxIds.set(cache, new Set(cache.snapshot().outbox.map((change) => change.id)));
  return cache.snapshot();
}
let flushing: Promise<void> | null = null;
export function flushProjectDocuments() {
  if (flushing) return flushing;
  flushing = flush().finally(() => {
    flushing = null;
  });
  return flushing;
}
async function flush() {
  const store = getHostRuntimeStore();
  const keys = await AsyncStorage.getAllKeys();
  for (const host of store.getHosts()) {
    const snapshot = store.getSnapshot(host.serverId);
    const client = snapshot?.client;
    if (snapshot?.connectionStatus !== "online" || !client) continue;
    const plugins = pluginRegistry
      .getSnapshot()
      .filter((plugin) => plugin.serverId === host.serverId);
    if (plugins.some((plugin) => plugin.id === "vibe-bots")) {
      try {
        const filter = { includeArchived: true };
        const response = await client.invokePluginRpc("vibe-bots", "bots.list", filter);
        await botSnapshotCache.received(host.serverId, filter, response);
      } catch {
        /* Preserve the last bot and memory snapshot until the host can refresh it. */
      }
    }
    if (
      !pluginRegistry
        .getSnapshot()
        .some((p) => p.serverId === host.serverId && p.id === "vibe-board")
    )
      continue;
    const prefix = "project-documents:v1:" + encodeURIComponent(host.serverId) + ":";
    const projectIds = new Set(
      keys
        .filter((k) => k.startsWith(prefix))
        .map((k) => decodeURIComponent(k.slice(prefix.length))),
    );
    // Cache every native project while online, including projects whose settings have never been opened.
    try {
      const listed = await client.listProjects();
      for (const project of listed.projects) projectIds.add(project.projectId);
    } catch {
      /* Existing persisted projects can still drain; isolate this host discovery failure. */
    }
    for (const projectId of projectIds) {
      const cache = getProjectDocumentCache(host.serverId, projectId);
      try {
        await loadProjectDocumentCache(cache);
        for (const change of cache.snapshot().outbox) {
          const response = await client.invokePluginRpc("vibe-board", "vibe.project.brief.submit", {
            projectId,
            id: change.id,
            documents: change.documents,
          });
          await cache.acknowledge(change.id, projectDocumentCacheSchema.parse(response));
        }
        const response = await client.invokePluginRpc("vibe-board", "vibe.project.documents.get", {
          projectId,
        });
        await cache.received(projectDocumentCacheSchema.parse(response));
      } catch {
        await cache.syncFailed().catch(() => {});
      }
    }
  }
}
export function startProjectDocumentSync() {
  const store = getHostRuntimeStore();
  let stopped = false;
  let outboxPending = false;
  const refresh = () => {
    void flushProjectDocuments().catch(() => {});
  };
  const connections = new Map<string, { online: boolean; client: unknown }>();
  const onConnection = () => {
    let changed = false;
    for (const host of store.getHosts()) {
      const snapshot = store.getSnapshot(host.serverId);
      const next = { online: snapshot?.connectionStatus === "online", client: snapshot?.client };
      const previous = connections.get(host.serverId);
      if (!previous || previous.online !== next.online || previous.client !== next.client) {
        connections.set(host.serverId, next);
        if (next.online) changed = true;
      }
    }
    if (changed) refresh();
  };
  const stopRuntime = store.subscribeAll(onConnection);
  const stopHosts = store.subscribeHostList(refresh);
  const stopPlugins = pluginRegistry.subscribe(onConnection);
  const onOutbox = () => {
    if (flushing) {
      if (!outboxPending) {
        outboxPending = true;
        void flushing
          .finally(() => {
            outboxPending = false;
            if (!stopped) refresh();
          })
          .catch(() => {});
      }
    } else {
      refresh();
    }
  };
  outboxListeners.add(onOutbox);
  const timer = setInterval(refresh, 60000);
  onConnection();
  return () => {
    stopped = true;
    outboxListeners.delete(onOutbox);
    stopRuntime();
    stopHosts();
    stopPlugins();
    clearInterval(timer);
  };
}
