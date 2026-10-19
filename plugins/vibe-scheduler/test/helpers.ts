import { migrateOwner, openVibeDb } from "../server/vibe/db";
import {
  createSchedulerRuntime,
  DEFAULT_SETTINGS,
  type RuntimeSettings,
} from "../server/runtime";
import type { ProcInfo, SystemProbe } from "../server/resources";
import type { UsageProviderLike } from "../server/quota";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class FakeClock {
  constructor(private t = Date.parse("2026-01-01T00:00:00Z")) {}
  now = () => new Date(this.t);
  advance(ms: number) {
    this.t += ms;
  }
}

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

export function setup(opts: { settings?: Partial<RuntimeSettings>; usage?: UsageProviderLike[] } = {}) {
  const db = openVibeDb({ path: ":memory:" });
  migrateOwner(db, "scheduler");
  const clock = new FakeClock();
  const machine = fakeMachine();
  const state = { usage: opts.usage ?? usage(), nextPort: 4000 };
  const runtime = createSchedulerRuntime({
    db,
    dataDir: mkdtempSync(join(tmpdir(), "vibe-sched-")),
    now: clock.now,
    probe: machine,
    isPortFree: async () => true,
    fetchUsage: () => Promise.resolve(state.usage),
    settings: { ...DEFAULT_SETTINGS, ...opts.settings },
  });
  const { store } = runtime;
  const preset = (provider: string, runtimeEnv: string | null = null) =>
    store.presets.create({ name: `${provider}-${runtimeEnv ?? "x"}`, provider, model: "m", runtimeEnv });
  const project = store.projects.create({ name: "Demo", prefix: "DEMO", repoPath: "/repo/demo" });
  const card = (title: string, priority: "urgent" | "high" | "medium" | "low" | "none", presetId: string, extra = {}) => {
    clock.advance(1000);
    return store.cards.create({ projectId: project.id, title, column: "todo", priority, presetId, ...extra });
  };
  const events = (type: string) =>
    db
      .prepare<{ payload_json: string; card_id: string | null }>(
        "SELECT payload_json, card_id FROM vibe_event WHERE type = ? ORDER BY seq",
      )
      .all(type)
      .map((r) => ({ ...(JSON.parse(r.payload_json) as Record<string, unknown>), cardId: r.card_id }));
  return { db, clock, machine, runtime, store, project, preset, card, events, state };
}
