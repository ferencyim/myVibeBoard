import { useSyncExternalStore } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { SidebarWorkspaceClassification } from "./sidebar-workspace-classification";

// The sidebar classifies workspaces through a plugin request that needs the daemon and the plugin
// registry. Until it answers, the last result stands in so rows neither hide nor change icon.
const STORAGE_KEY = "@vibe/sidebar-classification/v1";

type CacheSnapshot = Readonly<Record<string, readonly SidebarWorkspaceClassification[]>>;

let snapshot: CacheSnapshot = {};
let hydrated = false;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

async function hydrate() {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const stored = JSON.parse(raw) as CacheSnapshot;
    // Anything learned from the server while reading storage wins.
    snapshot = { ...stored, ...snapshot };
    notify();
  } catch {
    // A missing or corrupt cache only costs the first paint.
  }
}

export function classificationCacheKey(serverId: string, projectId: string): string {
  return `${serverId}|${projectId}`;
}

export function rememberClassification(
  key: string,
  data: readonly SidebarWorkspaceClassification[],
) {
  if (JSON.stringify(snapshot[key]) === JSON.stringify(data)) return;
  snapshot = { ...snapshot, [key]: data };
  notify();
  AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot)).catch(() => {});
}

function subscribe(listener: () => void) {
  void hydrate();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useClassificationCache(): CacheSnapshot {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot,
  );
}
