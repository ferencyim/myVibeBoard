import type { UsageProviderLike } from "../server/quota";
import type { ProcInfo, SystemProbe } from "../server/resources";
export interface FakeMachine extends SystemProbe {
  memUsed: number;
  procs: ProcInfo[];
}

/** A machine whose memory use and process table the test controls. */
export function fakeMachine(): FakeMachine {
  let busy = 0;
  const m: FakeMachine = {
    memUsed: 0.3,
    procs: [],
    cpuTimes: () => {
      busy += 100;
      return { idle: 900 * (busy / 100), total: 1000 * (busy / 100) };
    },
    cpuCount: () => 4,
    totalMem: () => 16_000_000_000,
    freeMem: () => (1 - m.memUsed) * 16_000_000_000,
    disk: async () => ({ freeBytes: 1e11, totalBytes: 5e11 }),
    listProcesses: async () => m.procs,
  };
  return m;
}

export function usage(...rows: Array<[string, number | null]>): UsageProviderLike[] {
  return rows.map(([providerId, usedPct]) => ({
    providerId,
    status: usedPct === null ? "unavailable" : "available",
    windows: usedPct === null ? [] : [{ usedPct, resetsAt: "2026-01-01T05:00:00Z" }],
  }));
}
