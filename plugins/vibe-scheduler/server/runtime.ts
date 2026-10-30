import { sampleRemoteHost } from "./remote-resources";
import { readResourceMeta, writeResourceMeta, type RemoteHost } from "./vibe/db";
// Wires the scheduler to the real world: timers, resource_sample persistence, the usage cache and
// the event consumer for native task resource requests. `index.server.ts` only adds Paseo plumbing.

import { existsSync } from "node:fs";
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
import { createHub } from "./hub";
import { startHubHttp, type HubHttp } from "./hub-http";
import { createHubStore } from "./hub-store";
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

const TAKEOVER_KEY = "hub.takeover";

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
  /** Hub: directory for hub.json (HTTP API is off when omitted) and the guard admission file to sync. */
  hubDir?: string;
  hubAdmissionFile?: string | null;
  isPidAlive?: (pid: number) => boolean;
  onError?: (error: unknown) => void;
  native?: (workspaceId: string) => Promise<NativeTaskWorkspace | null>;
  routineTick?: (input: {
    paused: boolean;
    running: ReturnType<ReturnType<typeof createTaskScheduler>["runningCounts"]>;
    globalLimit: number;
    providerLimits: Record<string, number>;
    projectLimits: Record<string, number>;
    quota: Record<string, ProviderQuota>;
  }) => Promise<unknown>;
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

  // The gate closure needs the hub, and the hub needs the scheduler.
  let hub: ReturnType<typeof createHub>;
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
    // Machine thresholds are tuned for heavy jobs; agent tasks only meet them once the hub
    // has taken over the machine. Explicit pauses apply either way.
    hubGate: ({ projectName }) => hub.agentGate(projectName, { machine: takeover }),
  });

  const hubStore = createHubStore(db, now);
  hub = createHub({
    store: hubStore,
    now,
    admissionFile: options.hubAdmissionFile ?? null,
    isPidAlive: options.isPidAlive,
    onError,
    agents: {
      queue: () => scheduler.status().queue,
      running: () => scheduler.runningCounts(),
      deferred: () => scheduler.status().deferred,
      reorder: (ids, reason) => scheduler.setQueueOrder(ids, reason),
    },
  });
  let hubHttp: HubHttp | null = null;
  let hubStarting: Promise<void> | null = null;
  // Default off: until the user turns this on the hub writes no hub.json and guards use local locks.
  let takeover = readResourceMeta<boolean>(db, TAKEOVER_KEY, false) === true;

  /** Make hub.json match the switch: start the HTTP API when taking over, stop (and remove hub.json) when not. */
  async function applyTakeover(): Promise<void> {
    if (stopped || !options.hubDir) return;
    if (takeover && !hubHttp && !hubStarting) {
      hubStarting = startHubHttp(hub, { dir: options.hubDir, onError })
        .then((http) => {
          if (stopped || !takeover) return http.stop();
          hubHttp = http;
        })
        .catch(onError)
        .finally(() => {
          hubStarting = null;
        });
    }
    await hubStarting;
    if (!takeover && hubHttp) {
      const http = hubHttp;
      hubHttp = null;
      await http.stop().catch(onError);
    }
  }

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
    await hub.tick().catch(onError);
    const result = await scheduler.tick();
    if (options.routineTick) await scheduler.withAdmissionLock(() => options.routineTick!({
      paused: result.paused || scheduler.status().recovering || !!scheduler.status().recoveryError,
      running: scheduler.runningCounts(),
      globalLimit: settings.globalLimit,
      providerLimits: settings.providerLimits,
      projectLimits: Object.fromEntries(store.projects.list(true)
        .filter((project) => project.paseoProjectId && project.concurrencyLimit != null)
        .map((project) => [project.paseoProjectId!, project.concurrencyLimit!])),
      quota,
    }));
    return result;
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
    hub,
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
    takeover: () => ({
      enabled: takeover,
      /** hub.json is currently published. */
      active: hubHttp !== null,
      available: !!options.hubDir,
      dir: options.hubDir ?? null,
      disabledFile: options.hubDir ? existsSync(join(options.hubDir, "hub.disabled")) : false,
    }),
    async setTakeover(enabled: boolean) {
      takeover = enabled;
      writeResourceMeta(db, TAKEOVER_KEY, enabled);
      await applyTakeover();
    },
    start() {
      stopped = false;
      void applyTakeover();
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
      await hubStarting;
      await hubHttp?.stop().catch(onError);
      hubHttp = null;
      if (remoteTimer) clearTimeout(remoteTimer);
      if (tickTimer) clearTimeout(tickTimer);
      if (sampleTimer) clearTimeout(sampleTimer);
      await consumer.stop();
    },
  };
}

export type SchedulerRuntime = ReturnType<typeof createSchedulerRuntime>;
