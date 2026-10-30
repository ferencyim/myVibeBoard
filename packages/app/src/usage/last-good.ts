import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useSyncExternalStore } from "react";
import type { RememberedUsage } from "./rings";
import type { UsageReportEntry } from "./types";

// Claude's login token lapses for hours at a time, and the usage source reports nothing then. The
// last good read of each account is kept so its ring can stay on screen, greyed, across restarts.
const STORAGE_KEY = "@vibe/usage-last-good/v1";

type HostMemory = Readonly<Record<string, RememberedUsage>>;
type Snapshot = Readonly<Record<string, HostMemory>>;

const EMPTY: HostMemory = {};
let snapshot: Snapshot = {};
const listeners = new Set<() => void>();
let hydrated = false;

function notify() {
  for (const listener of listeners) listener();
}

async function hydrate() {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const stored = JSON.parse(raw) as Snapshot;
    const merged: Record<string, HostMemory> = {};
    for (const serverId of new Set([...Object.keys(stored), ...Object.keys(snapshot)])) {
      merged[serverId] = { ...stored[serverId], ...snapshot[serverId] };
    }
    snapshot = merged;
    notify();
  } catch {
    // A missing or corrupt cache only costs the greyed ring.
  }
}

/** Remembers the available reports of a host. */
export function rememberAvailableReports(
  serverId: string,
  reports: readonly UsageReportEntry[],
): void {
  let next: Record<string, RememberedUsage> | null = null;
  for (const entry of reports) {
    if (entry.report.status !== "available") continue;
    const known = (next ?? snapshot[serverId])?.[entry.id];
    if (known?.fetchedAt === entry.fetchedAt && known.source) continue;
    next ??= { ...snapshot[serverId] };
    next[entry.id] = {
      fetchedAt: entry.fetchedAt,
      report: entry.report,
      source: {
        sourceId: entry.sourceId,
        sourceLabel: entry.sourceLabel,
        icon: entry.icon,
        accountLabel: entry.account.label,
      },
    };
  }
  if (!next) return;
  snapshot = { ...snapshot, [serverId]: next };
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

/** The remembered reads of a host, recording the host's available reports as they arrive. */
export function useRememberedUsage(
  serverId: string | null,
  reports: readonly UsageReportEntry[],
): HostMemory {
  useEffect(() => {
    if (serverId) rememberAvailableReports(serverId, reports);
  }, [serverId, reports]);
  const all = useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot,
  );
  return (serverId ? all[serverId] : undefined) ?? EMPTY;
}
