import {
  getProjectDocumentCache,
  loadProjectDocumentCache,
  flushProjectDocuments,
} from "@/runtime/project-documents";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useHostRuntimeClient, useHostRuntimeSnapshot } from "@/runtime/host-runtime";

export function useProjectDocuments(serverId: string, projectId: string) {
  const cache = useMemo(() => getProjectDocumentCache(serverId, projectId), [serverId, projectId]);
  const state = useSyncExternalStore(cache.subscribe, cache.getSnapshot, cache.getSnapshot);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const client = useHostRuntimeClient(serverId);
  const host = useHostRuntimeSnapshot(serverId);
  const connected = host?.connectionStatus === "online";
  useEffect(() => {
    let alive = true;
    setLoaded(false);
    setError(null);
    void loadProjectDocumentCache(cache).then(
      () => {
        if (alive) setLoaded(true);
        return undefined;
      },
      (e) => {
        if (alive) {
          setError(String(e));
          setLoaded(true);
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [cache]);
  useEffect(() => {
    if (loaded && connected && client)
      void flushProjectDocuments().catch((e) => setError(String(e)));
  }, [loaded, connected, client]);
  return { cache, state, loaded, error, setError, connected };
}
