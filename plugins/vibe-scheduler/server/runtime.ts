// Wires the scheduler to the real world: timers, resource_sample persistence, the usage cache and
// the event consumer that hears back from vibe-board. `index.server.ts` only adds Paseo plumbing.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { normalizeUsage, type UsageProviderLike } from "./quota";
import { createPortAllocator, type PortAllocator } from "./ports";
import {
  createResourceSampler,
  createSystemProbe,
  type ResourceSnapshot,
  type SessionTarget,
  type SystemProbe,
} from "./resources";
import { createScheduler, DEFAULT_CONFIG, type SchedulerConfig } from "./scheduler";
import {
  mergeProfiles,
  presetModels,
  parseWorkerHistory,
  selectAgent,
  type AgentProfile,
  type ProviderQuota,
  type TaskNeeds,
} from "./vibe/contract";
import {
  createDeviceLeases,
  createEventConsumer,
  createVibeStore,
  type VibeDb,
} from "./vibe/db";

export interface RuntimeSettings extends SchedulerConfig {
  quotaTightPct: number;
  quotaExhaustedPct: number;
  devPortBase: number;
  devPortSpan: number;
  tickSeconds: number;
  sampleSeconds: number;
  sampleRetentionDays: number;
  agentProfiles: AgentProfile[];
}

export const DEFAULT_SETTINGS: RuntimeSettings = {
  ...DEFAULT_CONFIG,
  quotaTightPct: 25,
  quotaExhaustedPct: 5,
  devPortBase: 3100,
  devPortSpan: 900,
  tickSeconds: 5,
  sampleSeconds: 15,
  sampleRetentionDays: 7,
  agentProfiles: [],
};

export interface RuntimeOptions {
  db: VibeDb;
  /** Directory for scheduler files (ports.json). */
  dataDir: string;
  probe?: SystemProbe;
  now?: () => Date;
  isPortFree?: (port: number) => Promise<boolean>;
  /** Fetch provider usage (providers.listUsage); null when no daemon handle is known yet. */
  fetchUsage?: () => Promise<readonly UsageProviderLike[]> | null;
  settings?: RuntimeSettings;
  onError?: (error: unknown) => void;
}

export function createSchedulerRuntime(options: RuntimeOptions) {
  const { db } = options;
  const now = options.now ?? (() => new Date());
  const onError = options.onError ?? (() => undefined);
  let settings = options.settings ?? DEFAULT_SETTINGS;

  const store = createVibeStore(db, { now });
  const leases = createDeviceLeases(db, { now });
  const ports: PortAllocator = createPortAllocator({
    file: join(options.dataDir, "ports.json"),
    base: settings.devPortBase,
    span: settings.devPortSpan,
    isFree: options.isPortFree,
  });
  const sampler = createResourceSampler({
    probe: options.probe ?? createSystemProbe(),
    now,
    diskPath: dirname(db.path),
  });

  let latest: ResourceSnapshot | null = null;
  let quota: Record<string, ProviderQuota> = {};
  let usageAt = 0;
  let usageBusy = false;
  let lastPrune = 0;

  /** WP-106: the board checks sub-agent starts against the same limits (vibe_meta, see contract/subtasks.ts). */
  const publishLimits = () => {
    try {
      store.limits.publish({ globalLimit: settings.globalLimit, providerLimits: settings.providerLimits });
    } catch (error) {
      onError(error);
    }
  };
  publishLimits();

  const scheduler = createScheduler({
    db,
    store,
    leases,
    ports,
    now,
    config: () => settings,
    resources: () => latest,
    quota: () => quota,
  });

  const consumer = createEventConsumer({
    db,
    consumer: "vibe-scheduler",
    types: ["scheduler.dispatch_failed", "master.dispatch_chosen", "master.dispatch_failed"],
    startAt: "now",
    now,
    handler: (event) => {
      if (event.type === "scheduler.dispatch_failed") {
        scheduler.handleDispatchFailed((event.payload as { cardId: string }).cardId);
      } else if (event.type === "master.dispatch_chosen") {
        scheduler.handleMasterChosen(event.payload as Parameters<typeof scheduler.handleMasterChosen>[0]);
      } else if (event.type === "master.dispatch_failed") {
        scheduler.handleMasterFailed(event.payload as Parameters<typeof scheduler.handleMasterFailed>[0]);
      }
    },
    onError: (e) => onError(e),
  });

  function targets(): SessionTarget[] {
    return store.sessions.list({ states: ["starting", "working", "waiting", "idle"] }).map((s) => {
      const card = s.cardId ? store.cards.get(s.cardId) : undefined;
      const project = card ? store.projects.get(card.projectId) : undefined;
      return {
        sessionId: s.id,
        cardKey: card?.key ?? null,
        path: card?.worktree ?? project?.repoPath ?? null,
      };
    });
  }

  /** Take one sample and persist it as resource_sample (cpu/mem 0-1, per-session and pool JSON). */
  async function sampleNow(): Promise<ResourceSnapshot> {
    const snap = await sampler.sample(targets());
    latest = snap;
    const perSession: Record<string, unknown> = {};
    for (const [id, u] of Object.entries(snap.perSession)) perSession[id] = u;
    db.prepare(
      "INSERT INTO resource_sample (ts, cpu, mem, per_session_json, device_pool_json) VALUES (?, ?, ?, ?, ?)",
    ).run(snap.ts, snap.cpu, snap.mem, JSON.stringify(perSession), JSON.stringify(leases.poolStatus()));
    if (now().getTime() - lastPrune > 3_600_000) {
      lastPrune = now().getTime();
      const cutoff = new Date(now().getTime() - settings.sampleRetentionDays * 86_400_000);
      db.prepare("DELETE FROM resource_sample WHERE ts < ?").run(cutoff.toISOString());
    }
    return snap;
  }

  /** Refresh the quota cache at most once a minute; failures keep the previous values. */
  async function refreshUsage(force = false): Promise<void> {
    if (usageBusy || (!force && now().getTime() - usageAt < 60_000)) return;
    const pending = options.fetchUsage?.();
    if (!pending) return;
    usageBusy = true;
    try {
      quota = normalizeUsage(await pending, {
        tightPct: settings.quotaTightPct,
        exhaustedPct: settings.quotaExhaustedPct,
      });
      usageAt = now().getTime();
    } catch (error) {
      onError(error);
    } finally {
      usageBusy = false;
    }
  }

  async function tickOnce() {
    await consumer.poll();
    await refreshUsage();
    return scheduler.tick();
  }

  async function loadHistory(repoPath: string | undefined, profiles: readonly AgentProfile[]) {
    const history: Record<string, Record<string, number>> = {};
    if (!repoPath) return history;
    for (const p of profiles) {
      try {
        const md = await readFile(join(repoPath, ".vibe", "workers", p.id, "MEMORY.md"), "utf8");
        history[p.id] = parseWorkerHistory(md);
      } catch {
        // No memory file yet: no track record.
      }
    }
    return history;
  }

  /** Entry for the master agent (WP-32) through the `scheduler.selectAgent` RPC. */
  async function select(task: TaskNeeds, repoPath?: string) {
    // Providers come from what exists: the usage catalog and the presets in use.
    const providerIds = [...Object.keys(quota), ...store.presets.list().flatMap((p) => presetModels(p).map((m) => m.provider))];
    const profiles = mergeProfiles(settings.agentProfiles, providerIds);
    const running = scheduler.status().running.byProvider;
    const devicesFree: Record<string, number> = {};
    const busy = new Set(leases.activeLeases().map((l) => l.device_id));
    for (const d of leases.listDevices()) {
      devicesFree[d.kind] = (devicesFree[d.kind] ?? 0) + (busy.has(d.id) ? 0 : 1);
    }
    return selectAgent(profiles, task, {
      quota,
      devicesFree,
      memoryPaused: scheduler.isPaused(),
      history: await loadHistory(repoPath, profiles),
      running,
      tightMinPriority: settings.tightMinPriority,
    });
  }

  let tickTimer: ReturnType<typeof setTimeout> | null = null;
  let sampleTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = true;

  const loop = (run: () => Promise<unknown>, seconds: () => number, set: (t: ReturnType<typeof setTimeout>) => void) => {
    const next = () => {
      if (stopped) return;
      const t = setTimeout(() => {
        run()
          .catch(onError)
          .finally(next);
      }, seconds() * 1000);
      (t as unknown as { unref?: () => void }).unref?.();
      set(t);
    };
    next();
  };

  return {
    store,
    leases,
    ports,
    scheduler,
    sampleNow,
    tickOnce,
    select,
    refreshUsage,
    latest: () => latest,
    quota: () => quota,
    setSettings(next: RuntimeSettings) {
      settings = next;
      publishLimits();
    },
    start() {
      stopped = false;
      void sampleNow().catch(onError);
      loop(sampleNow, () => settings.sampleSeconds, (t) => (sampleTimer = t));
      loop(tickOnce, () => settings.tickSeconds, (t) => (tickTimer = t));
    },
    async stop() {
      stopped = true;
      if (tickTimer) clearTimeout(tickTimer);
      if (sampleTimer) clearTimeout(sampleTimer);
      await consumer.stop();
    },
  };
}

export type SchedulerRuntime = ReturnType<typeof createSchedulerRuntime>;
