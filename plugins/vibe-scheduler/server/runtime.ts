import { sampleRemoteHost } from "./remote-resources";
import { readResourceMeta, writeResourceMeta, type RemoteHost } from "./vibe/db";
// Wires the scheduler to the real world: timers, resource_sample persistence, the usage cache and
// the event consumer for native task resource requests. `index.server.ts` only adds Paseo plumbing.

import { dirname, join } from "node:path";
import { normalizeUsage, type UsageProviderLike } from "./quota";
import { createPortAllocator, type PortAllocator } from "./ports";
import {
  createResourceSampler,
  createSystemProbe,
  type ResourceSnapshot,
  type CommandRunner,
  type SessionTarget,
  type SystemProbe,
} from "./resources";
import { DEFAULT_CONFIG, type SchedulerConfig } from "./scheduler";
import {
  createTaskScheduler,
  type NativeTaskWorkspace,
  type TaskResourceRequest,
} from "./task-scheduler";
import type { EventType, NewEvent } from "./vibe/contract";
import type { ProviderQuota } from "./vibe/contract";
import {
  createDeviceLeases,
  createEventConsumer,
  createVibeStore,
  createResourceSampleCommands,
  publishEvent,
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
  remoteSampleSeconds: number;
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
  remoteSampleSeconds: 60,
};

export interface RuntimeOptions {
  db: VibeDb;
  /** Directory for scheduler files (ports.json). */
  dataDir: string;
  probe?: SystemProbe;
  remoteRun?: CommandRunner;
  now?: () => Date;
  isPortFree?: (port: number) => Promise<boolean>;
  /** Fetch provider usage (providers.listUsage); null when no daemon handle is known yet. */
  fetchUsage?: () => Promise<readonly UsageProviderLike[]> | null;
  settings?: RuntimeSettings;
  onError?: (error: unknown) => void;
  native?: (workspaceId: string) => Promise<NativeTaskWorkspace | null>;
}

export function createSchedulerRuntime(options: RuntimeOptions) {
  const { db } = options;
  const now = options.now ?? (() => new Date());
  const onError = options.onError ?? (() => undefined);
  let settings = options.settings ?? DEFAULT_SETTINGS;

  const store = createVibeStore(db, { now });
  const leases = createDeviceLeases(db, { now });
  const resourceSamples = createResourceSampleCommands(db);
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

  /** Publish the limits shared by all task members. */
  const publishLimits = () => {
    try {
      store.limits.publish({
        globalLimit: settings.globalLimit,
        providerLimits: settings.providerLimits,
      });
    } catch (error) {
      onError(error);
    }
  };
  publishLimits();

  const scheduler = createTaskScheduler({
    store,
    leases,
    ports,
    now,
    file: join(options.dataDir, "task-resources.json"),
    config: () => settings,
    memory: () => latest?.mem ?? null,
    log: (message) => console.info("vibe-scheduler:", message),
    quota: () => quota,
    native:
      options.native ??
      (async () => {
        throw new Error("尚未连接原生宿主，暂停派发");
      }),
    emit: (type, payload) =>
      publishEvent(db, { type: type as EventType, payload } as NewEvent, now),
  });

  const consumer = createEventConsumer({
    db,
    consumer: "vibe-scheduler-tasks",
    types: ["scheduler.task_resource_request"],
    startAt: "now",
    now,
    handler: async (event) => {
      if (event.type === "scheduler.task_resource_request") {
        const output = await scheduler.requestResource(event.payload as TaskResourceRequest);
        publishEvent(
          db,
          {
            type: "scheduler.task_resource_result",
            payload: { ...output },
            dedupeKey: "task-resource-result:" + output.requestId,
          },
          now,
        );
      }
    },
    onError: (error) => onError(error),
  });

  function targets(): SessionTarget[] {
    return scheduler.targets();
  }

  /** Take one sample and persist it as resource_sample (cpu/mem 0-1, per-session and pool JSON). */
  async function sampleNow(): Promise<ResourceSnapshot> {
    const snap = await sampler.sample(targets());
    latest = snap;
    writeResourceMeta(db, "scheduler.local_resources", { name: "本机", ...snap });
    const perSession: Record<string, unknown> = {};
    for (const [id, u] of Object.entries(snap.perSession)) perSession[id] = u;
    resourceSamples.record({
      ts: snap.ts,
      cpu: snap.cpu,
      mem: snap.mem,
      perSession,
      devicePool: leases.poolStatus(),
    });
    if (now().getTime() - lastPrune > 3_600_000) {
      lastPrune = now().getTime();
      const cutoff = new Date(now().getTime() - settings.sampleRetentionDays * 86_400_000);
      resourceSamples.prune(cutoff.toISOString());
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

  async function sampleRemotesNow() {
    const hosts = readResourceMeta<RemoteHost[]>(db, "scheduler.remote_hosts", []);
    const samples = await Promise.all(
      hosts.map((host) => sampleRemoteHost(host, options.remoteRun, now())),
    );
    const active = new Set(
      readResourceMeta<RemoteHost[]>(db, "scheduler.remote_hosts", []).map((host) => host.target),
    );
    writeResourceMeta(
      db,
      "scheduler.remote_resources",
      samples.filter((host) => active.has(host.target!)),
    );
    return samples;
  }
  let remoteTimer: ReturnType<typeof setTimeout> | null = null;
  let tickTimer: ReturnType<typeof setTimeout> | null = null;
  let sampleTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = true;

  const loop = (
    run: () => Promise<unknown>,
    seconds: () => number,
    set: (t: ReturnType<typeof setTimeout>) => void,
  ) => {
    const next = () => {
      if (stopped) return;
      const t = setTimeout(() => {
        run().catch(onError).finally(next);
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
    sampleRemotesNow,
    tickOnce,
    refreshUsage,
    latest: () => latest,
    quota: () => quota,
    setSettings(next: RuntimeSettings) {
      settings = next;
      ports.configure({ base: settings.devPortBase, span: settings.devPortSpan });
      publishLimits();
    },
    start() {
      stopped = false;
      consumer.start();
      void sampleNow().catch(onError);
      void sampleRemotesNow().catch(onError);
      loop(
        sampleRemotesNow,
        () => settings.remoteSampleSeconds,
        (t) => (remoteTimer = t),
      );
      loop(
        sampleNow,
        () => settings.sampleSeconds,
        (t) => (sampleTimer = t),
      );
      loop(
        tickOnce,
        () => settings.tickSeconds,
        (t) => (tickTimer = t),
      );
    },
    async stop() {
      stopped = true;
      if (remoteTimer) clearTimeout(remoteTimer);
      if (tickTimer) clearTimeout(tickTimer);
      if (sampleTimer) clearTimeout(sampleTimer);
      await consumer.stop();
    },
  };
}

export type SchedulerRuntime = ReturnType<typeof createSchedulerRuntime>;
