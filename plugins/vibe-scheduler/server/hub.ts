// The hub: one admission queue for shell heavy jobs (via the local HTTP API), shared-resource
// locks and pause rules. Agent task admission stays in task-scheduler; the hub reads its queue for
// the unified view and forwards agent reordering to it. All decisions are deterministic rules.

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHubMetrics, type HubMetrics } from "./hub-metrics";
import { mirrorJob, readLocalHolders, unmirrorJob } from "./hub-locks";
import type { CommandRunner } from "./resources";
import type { HubPause, HubResource, HubStore } from "./hub-store";

export interface HubSettings {
  hardLimit: number;
  minAvailableGb: number;
  deployMinAvailableGb: number;
  maxCommitPercent: number;
  maxCpuPercent: number;
  cpuWindowSeconds: number;
  maxProcesses: number;
  maxHandles: number;
  maxDiskQueueLength: number;
  admissionIntervalSeconds: number;
}

export const DEFAULT_HUB_SETTINGS: HubSettings = {
  hardLimit: 4,
  minAvailableGb: 12,
  deployMinAvailableGb: 4,
  maxCommitPercent: 80,
  maxCpuPercent: 70,
  cpuWindowSeconds: 10,
  maxProcesses: 1500,
  maxHandles: 400000,
  maxDiskQueueLength: 32,
  admissionIntervalSeconds: 120,
};

/** HubSettings key -> key in win-heavy-guard.admission.json. */
const FILE_KEYS: Record<keyof HubSettings, string> = {
  hardLimit: "hard_limit",
  minAvailableGb: "min_available_gb",
  deployMinAvailableGb: "deploy_min_available_gb",
  maxCommitPercent: "max_commit_percent",
  maxCpuPercent: "max_cpu_percent",
  cpuWindowSeconds: "cpu_window_seconds",
  maxProcesses: "max_processes",
  maxHandles: "max_handles",
  maxDiskQueueLength: "max_disk_queue_length",
  admissionIntervalSeconds: "admission_interval_seconds",
};

export function readAdmissionFile(path: string): Partial<HubSettings> {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [key, fileKey] of Object.entries(FILE_KEYS)) {
      const v = raw[fileKey];
      if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
    }
    return out as Partial<HubSettings>;
  } catch {
    return {};
  }
}

/** Atomic write; keys this file has that the hub does not model are preserved. */
export function writeAdmissionFile(path: string, settings: HubSettings): void {
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    // new file
  }
  for (const [key, fileKey] of Object.entries(FILE_KEYS))
    existing[fileKey] = settings[key as keyof HubSettings];
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + "." + process.pid + ".tmp";
  writeFileSync(tmp, JSON.stringify(existing, null, 2) + "\n");
  renameSync(tmp, path);
}

export interface JobRequest {
  owner: string;
  project?: string;
  command: string;
  commandSha256: string;
  /** 0 = deploy (reserved slot, bypasses the launch interval), 1 = normal, 2 = low. */
  priority: number;
  exclusive: boolean;
  /**
   * Slots this one job occupies (default 1; an exclusive job takes the whole machine). This is NOT
   * the machine's slot count: the guard's `--slots`/slots.txt is the capacity, see `guardSlots`.
   */
  units?: number;
  memGb?: number;
  resources?: Array<{ name: string; mode: "shared" | "exclusive" }>;
  /** Reported by the client (win-heavy-guard infers it locally); the command name is the fallback. */
  category?: JobCategory;
  pid: number;
}

type JobState = "queued" | "admitted";
interface Job extends JobRequest {
  units: number;
  id: string;
  state: JobState;
  queuedAt: string;
  admittedAt: string | null;
  lastSeen: number;
  manualOrder: number;
  waitReasons: string[];
}
export interface JobView {
  jobId: string;
  state: JobState;
  position?: number;
  waitReasons?: string[];
}

export type JobCategory = "build" | "test" | "deploy" | "db" | "other";
export const JOB_CATEGORIES: readonly JobCategory[] = ["build", "test", "deploy", "db", "other"];

export interface AgentQueueItem {
  workspaceId: string;
  goal: string;
  confirmedAt: string | null;
}
export interface HubAgents {
  queue(): AgentQueueItem[];
  running(): unknown;
  /** workspaceId -> why the task is still waiting (last admission pass). */
  deferred?(): Record<string, string>;
  reorder(workspaceIds: string[], reason: string): Promise<unknown>;
}

export interface HubDeps {
  store: HubStore;
  now?: () => Date;
  metrics?: () => Promise<HubMetrics>;
  run?: CommandRunner;
  isPidAlive?: (pid: number) => boolean;
  /** Lock directory shared with win-heavy-guard's local mode (hub.json lives there); null = no mirroring. */
  lockDir?: string | null;
  /** win-heavy-guard.admission.json; null disables the sync. */
  admissionFile?: string | null;
  agents?: HubAgents;
  onError?: (error: unknown) => void;
  /** Notable decisions (e.g. the no-holder escape); also appended to the lock directory's audit log. */
  onEvent?: (event: string, detail: Record<string, unknown>) => void;
}

const HEARTBEAT_TIMEOUT_MS = 60_000;
const MAX_WAIT_SECONDS = 45;
const AGENT_PRIORITY = 1;
const FINISHED_KEEP = 200;
const UNORDERED = Number.MAX_SAFE_INTEGER;

export function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Fallback category from the command name, for clients that do not report one. */
export function jobCategory(command: string): JobCategory {
  if (/\b(deploy|release|publish)\b/i.test(command)) return "deploy";
  if (/\b(psql|pg_dump|pg_restore|migrate)\b/i.test(command)) return "db";
  if (/\b(test|vitest|jest|pytest|playwright|maestro|e2e)\b/i.test(command)) return "test";
  if (
    /\b(build|gradle|gradlew|assemble|bundle|compile|tsc|hvigor|msbuild|cargo|xcodebuild|apk)\b/i.test(
      command,
    )
  )
    return "build";
  return "other";
}

function globMatch(pattern: string, value: string): boolean {
  const body = pattern
    .split("*")
    .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp("^" + body + "$", "i").test(value);
}

const CATEGORY_SCOPES = ["build", "test", "deploy", "db"];

export function pauseMatches(
  scope: string,
  job: Pick<JobRequest, "command" | "project" | "resources" | "category">,
): boolean {
  if (scope === "agents") return false;
  if (scope === "all-heavy") return true;
  if (CATEGORY_SCOPES.includes(scope)) return (job.category ?? jobCategory(job.command)) === scope;
  if (scope.startsWith("project:")) return job.project === scope.slice(8);
  return (job.resources ?? []).some((r) => globMatch(scope, r.name));
}

export function validatePauseScope(scope: string): string {
  const s = scope.trim();
  if (!s) throw new Error("暂停范围不能为空");
  if (["all-heavy", "agents", ...CATEGORY_SCOPES].includes(s) || s.startsWith("project:") || /[:*]/.test(s))
    return s;
  throw new Error(
    "暂停范围须为 all-heavy / build / test / deploy / db / agents / project:名称 / 资源名或通配（如 pg:*）",
  );
}

/**
 * Wait reasons are codes (same style as win-heavy-guard): memory_low, commit_high, cpu_high,
 * processes_high, handles_high, disk_queue_high, slots_full, exclusive_wait, exclusive_running,
 * interval:<seconds left>, resource_busy:<name>, resource_exclusive:<name>, resource_full:<name>,
 * pause:<scope>:<reason>[|until], behind_higher. `describeWaitReason` renders them for people.
 */
function describePause(arg: string): string {
  const [rest = "", until] = arg.split("|");
  const i = rest.indexOf(":");
  const scope = i < 0 ? rest : rest.slice(0, i);
  const reason = i < 0 ? "" : rest.slice(i + 1);
  return `暂停（${scope}）${reason ? "：" + reason : ""}${until ? "，到 " + until.slice(5, 16).replace("T", " ") : ""}`;
}

export function describeWaitReason(code: string): string {
  const [head, ...rest] = code.split(":");
  const arg = rest.join(":");
  const text: Record<string, string> = {
    memory_low: "可用内存不足",
    commit_high: "已提交内存过高",
    cpu_high: "CPU 过高",
    processes_high: "进程数过多",
    handles_high: "句柄数过多",
    disk_queue_high: "磁盘队列过长",
    slots_full: "重任务名额已满",
    exclusive_wait: "需要独占机器，等待其它任务结束",
    exclusive_running: "有独占任务在运行",
    interval: "距上次放行间隔不足，还需 " + arg + " 秒",
    resource_busy: "资源 " + arg + " 正被占用",
    resource_exclusive: "资源 " + arg + " 被独占",
    resource_full: "资源 " + arg + " 共享上限已满",
    pause: describePause(arg),
    behind_higher: "排在等待机器资源的更高顺位任务之后",
  };
  return text[head!] ?? code;
}

/** Reasons the machine cannot take another job right now; empty = fine. Unknown metrics never block. */
export function metricReasons(
  settings: HubSettings,
  metrics: HubMetrics,
  priority: number,
  memGb = 0,
): string[] {
  const out: string[] = [];
  const minGb = (priority === 0 ? settings.deployMinAvailableGb : settings.minAvailableGb) + memGb;
  if (metrics.availableGb !== undefined && metrics.availableGb < minGb) out.push("memory_low");
  if (metrics.commitPercent !== undefined && metrics.commitPercent > settings.maxCommitPercent)
    out.push("commit_high");
  if (metrics.cpuPercent !== undefined && metrics.cpuPercent > settings.maxCpuPercent)
    out.push("cpu_high");
  if (metrics.processes !== undefined && metrics.processes > settings.maxProcesses)
    out.push("processes_high");
  if (metrics.handles !== undefined && metrics.handles > settings.maxHandles) out.push("handles_high");
  if (metrics.diskQueue !== undefined && metrics.diskQueue > settings.maxDiskQueueLength)
    out.push("disk_queue_high");
  return out;
}

export function createHub(deps: HubDeps) {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());
  const onError = deps.onError ?? (() => undefined);
  const isPidAlive = deps.isPidAlive ?? defaultIsPidAlive;
  const admissionFile = deps.admissionFile ?? null;

  let settings: HubSettings = { ...DEFAULT_HUB_SETTINGS };
  if (store.hasSettings()) {
    settings = { ...settings, ...store.readSettings<Partial<HubSettings>>({}) };
    if (admissionFile) {
      try {
        writeAdmissionFile(admissionFile, settings);
      } catch (error) {
        onError(error);
      }
    }
  } else {
    if (admissionFile) settings = { ...settings, ...readAdmissionFile(admissionFile) };
    store.writeSettings(settings);
  }

  const lockDir = deps.lockDir ?? null;
  const sampleListeners: Array<(m: HubMetrics) => void> = [];
  const finishListeners: Array<(r: { owner: string; exitCode: number | null; outcome: "released" | "reaped" }) => void> = [];
  const sampler = deps.metrics
    ? null
    : createHubMetrics({
        run: deps.run,
        now,
        cpuWindowSeconds: () => settings.cpuWindowSeconds,
        onSample: (m) => {
          for (const cb of sampleListeners) {
            try {
              cb(m);
            } catch (error) {
              onError(error);
            }
          }
        },
      });
  const readMetrics = deps.metrics ?? (() => sampler!.read());

  const jobs = new Map<string, Job>();
  const finished = new Map<string, "released" | "reaped">();
  const waiters = new Map<string, Set<() => void>>();
  let lastAdmitAt: number | null = null;
  let serial: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T> | T): Promise<T> => {
    const run = serial.then(fn, fn);
    serial = run.catch(() => undefined);
    return run;
  };

  const notify = (id: string) => {
    for (const wake of [...(waiters.get(id) ?? [])]) wake();
  };
  const remember = (id: string, outcome: "released" | "reaped") => {
    finished.set(id, outcome);
    if (finished.size > FINISHED_KEEP) finished.delete(finished.keys().next().value!);
  };

  const holders = () => [...jobs.values()].filter((j) => j.state === "admitted");
  /** Local-mode guards' holders found in the lock directory (the hub's own jobs excluded). */
  const localHolders = () =>
    lockDir ? readLocalHolders(lockDir, jobs.keys(), isPidAlive) : { slots: 0, exclusive: false };
  const sortedQueued = () =>
    [...jobs.values()]
      .filter((j) => j.state === "queued")
      .sort(
        (a, b) =>
          a.priority - b.priority ||
          a.manualOrder - b.manualOrder ||
          a.queuedAt.localeCompare(b.queuedAt) ||
          a.id.localeCompare(b.id),
      );

  interface QueueRow {
    kind: "job" | "agent";
    id: string;
    priority: number;
    manualOrder: number;
    queuedAt: string;
  }
  /** Jobs and agent tasks in one order. Agent tasks keep the order task-scheduler reports. */
  function unifiedQueue(): QueueRow[] {
    const rows: QueueRow[] = sortedQueued().map((j) => ({
      kind: "job",
      id: j.id,
      priority: j.priority,
      manualOrder: j.manualOrder,
      queuedAt: j.queuedAt,
    }));
    (deps.agents?.queue() ?? []).forEach((a, index) =>
      rows.push({
        kind: "agent",
        id: a.workspaceId,
        priority: AGENT_PRIORITY,
        manualOrder: index,
        queuedAt: a.confirmedAt ?? "",
      }),
    );
    return rows.sort(
      (a, b) =>
        a.priority - b.priority ||
        a.manualOrder - b.manualOrder ||
        a.queuedAt.localeCompare(b.queuedAt),
    );
  }

  function resourceReasons(job: Job, registry: Map<string, HubResource>): string[] {
    const out: string[] = [];
    const held = holders();
    for (const want of job.resources ?? []) {
      const using = held.flatMap((h) => (h.resources ?? []).filter((r) => r.name === want.name));
      const max = registry.get(want.name)?.maxShared ?? 1;
      if (want.mode === "exclusive") {
        if (using.length > 0) out.push("resource_busy:" + want.name);
      } else if (using.some((r) => r.mode === "exclusive")) {
        out.push("resource_exclusive:" + want.name);
      } else if (using.length >= max) {
        out.push("resource_full:" + want.name);
      }
    }
    return out;
  }

  /**
   * The guard's machine slot count, read the way win-heavy-guard does: slots.txt (1-8, else the
   * hard limit); without admission-state.json the guard is still in legacy mode and uses min(2, n).
   */
  function guardSlots(): number {
    if (!lockDir) return settings.hardLimit;
    let slots = settings.hardLimit;
    try {
      const n = Number.parseInt(readFileSync(join(lockDir, "slots.txt"), "utf8").trim(), 10);
      if (n >= 1 && n <= 8) slots = n;
    } catch {
      // no slots.txt: the guard's default is its hard_limit
    }
    return existsSync(join(lockDir, "admission-state.json")) ? slots : Math.min(2, slots);
  }
  /** Machine capacity in slots: the smaller of the hub's hard limit and the guard's slot count. */
  const capacity = () => Math.max(1, Math.min(settings.hardLimit, guardSlots()));

  function machineReasons(job: Job, metrics: HubMetrics, local = localHolders()): string[] {
    const out: string[] = [];
    const held = holders();
    const used = held.reduce((n, h) => n + h.units, 0) + local.slots;
    // Same rule as the guard: deploy (priority 0) may take the last slot, others leave it free.
    const total = capacity();
    const cap = job.priority === 0 ? total : Math.max(1, total - 1);
    if (used + (job.exclusive ? 1 : job.units) > cap) out.push("slots_full");
    if (job.exclusive && held.length + local.slots > 0) out.push("exclusive_wait");
    if (local.exclusive || held.some((h) => h.exclusive)) out.push("exclusive_running");
    if (job.priority > 0 && lastAdmitAt !== null) {
      const wait = settings.admissionIntervalSeconds * 1000 - (now().getTime() - lastAdmitAt);
      if (wait > 0) out.push("interval:" + Math.ceil(wait / 1000));
    }
    out.push(...metricReasons(settings, metrics, job.priority, job.memGb));
    return out;
  }

  function finish(
    job: Job,
    outcome: "released" | "reaped",
    exitCode: number | null,
    durationMs: number | null,
  ) {
    jobs.delete(job.id);
    if (lockDir && job.state === "admitted") {
      try {
        unmirrorJob(lockDir, job.id);
      } catch (error) {
        onError(error);
      }
    }
    remember(job.id, outcome);
    try {
      store.logJob({
        id: job.id,
        owner: job.owner,
        project: job.project ?? null,
        command: job.command,
        priority: job.priority,
        queuedAt: job.queuedAt,
        admittedAt: job.admittedAt,
        finishedAt: now().toISOString(),
        exitCode,
        durationMs,
        outcome,
      });
    } catch (error) {
      onError(error);
    }
    for (const cb of finishListeners) {
      try {
        cb({ owner: job.owner, exitCode, outcome });
      } catch (error) {
        onError(error);
      }
    }
    notify(job.id);
  }

  function reap() {
    const t = now().getTime();
    for (const job of [...jobs.values()]) {
      if (t - job.lastSeen <= HEARTBEAT_TIMEOUT_MS) continue;
      if ((waiters.get(job.id)?.size ?? 0) > 0 || isPidAlive(job.pid)) continue;
      finish(job, "reaped", null, null);
    }
  }

  function audit(event: string, detail: Record<string, unknown>) {
    deps.onEvent?.(event, detail);
    if (!lockDir) return;
    try {
      const logs = join(lockDir, "logs");
      mkdirSync(logs, { recursive: true });
      const day = now().toISOString().slice(0, 10);
      appendFileSync(
        join(logs, day + ".jsonl"),
        JSON.stringify({ time: now().toISOString(), event, via: "hub", ...detail }) + "\n",
      );
    } catch (error) {
      onError(error);
    }
  }

  /** One admission pass: reap dead clients, then admit in queue order, re-checking everything. */
  async function pass(): Promise<void> {
    reap();
    if (![...jobs.values()].some((j) => j.state === "queued")) return;
    const metrics = await readMetrics();
    const pauses = store.listPauses(true);
    const local = localHolders();
    const registry = new Map(store.listResources().map((r) => [r.name, r]));
    let machineBlocked = false;
    for (const job of sortedQueued()) {
      const pause = pauses.find((p) => pauseMatches(p.scope, job));
      if (pause) {
        job.waitReasons = [
          `pause:${pause.scope}:${pause.reason || "无说明"}${pause.until ? "|" + pause.until : ""}`,
        ];
        continue;
      }
      const reasons = resourceReasons(job, registry);
      let machine = machineReasons(job, metrics, local);
      // Deadlock guard: nobody holds anything, so waiting cannot help. Let the first job that is
      // not paused and has no resource conflict in, whatever the slot count, interval or metrics say.
      if (machine.length > 0 && reasons.length === 0 && holders().length === 0 && local.slots === 0) {
        audit("hub_empty_machine_bypass", {
          jobId: job.id,
          owner: job.owner,
          priority: job.priority,
          ignoredReasons: machine,
          capacity: capacity(),
        });
        machine = [];
      }
      reasons.push(...machine);
      if (machine.length > 0) machineBlocked = true;
      // Do not let later jobs overtake one that waits for the machine.
      else if (machineBlocked && reasons.length === 0)
        reasons.push("behind_higher");
      job.waitReasons = reasons;
      if (reasons.length > 0) continue;
      if (lockDir) {
        try {
          mirrorJob(lockDir, job, now());
        } catch (error) {
          onError(error); // admission still stands; only the local mode's view is missing
        }
      }
      job.state = "admitted";
      job.admittedAt = now().toISOString();
      job.lastSeen = now().getTime();
      job.waitReasons = [];
      lastAdmitAt = now().getTime();
      notify(job.id);
    }
  }

  function view(job: Job): JobView {
    if (job.state === "admitted") return { jobId: job.id, state: "admitted" };
    const position = unifiedQueue().findIndex((r) => r.kind === "job" && r.id === job.id) + 1;
    return {
      jobId: job.id,
      state: "queued",
      ...(position ? { position } : {}),
      waitReasons: job.waitReasons,
    };
  }

  const touch = (job: Job) => void (job.lastSeen = now().getTime());

  return {
    settings: () => ({ ...settings }),

    /** History hooks: every background sample, and every finished job. */
    onSample: (cb: (m: HubMetrics) => void) => void sampleListeners.push(cb),
    onJobFinished: (cb: (r: { owner: string; exitCode: number | null; outcome: "released" | "reaped" }) => void) =>
      void finishListeners.push(cb),
    /** Cheap load snapshot for history: running heavy jobs and the longest current queue wait. */
    load: () => {
      const t = now().getTime();
      let wait = 0;
      for (const j of jobs.values()) if (j.state === "queued") wait = Math.max(wait, t - Date.parse(j.queuedAt));
      return { running: holders().length, maxQueueWaitMs: wait };
    },

    /** Start / stop the background machine sampling (no-op when metrics are injected). */
    startSampling: () => sampler?.start(),
    stopSampling: () => sampler?.stop(),

    submit: (request: JobRequest): Promise<JobView> =>
      exclusive(async () => {
        const job: Job = {
          ...request,
          units: Math.max(1, Math.floor(request.units ?? 1)),
          resources: request.resources ?? [],
          id: randomUUID(),
          state: "queued",
          queuedAt: now().toISOString(),
          admittedAt: null,
          lastSeen: now().getTime(),
          manualOrder: UNORDERED,
          waitReasons: [],
        };
        jobs.set(job.id, job);
        await pass();
        return view(job);
      }),

    /** Long poll: returns once admitted, after `seconds`, or undefined when the job is gone. */
    async wait(id: string, seconds: number): Promise<JobView | undefined> {
      const job = jobs.get(id);
      if (!job) return undefined;
      touch(job);
      if (job.state !== "queued" || seconds <= 0) return view(job);
      await new Promise<void>((resolve) => {
        const set = waiters.get(id) ?? new Set<() => void>();
        waiters.set(id, set);
        const wake = () => {
          clearTimeout(timer);
          set.delete(wake);
          if (set.size === 0) waiters.delete(id);
          resolve();
        };
        const timer = setTimeout(wake, Math.min(seconds, MAX_WAIT_SECONDS) * 1000);
        set.add(wake);
      });
      const again = jobs.get(id);
      if (!again) return undefined;
      touch(again);
      return view(again);
    },

    heartbeat(id: string): "ok" | "gone" {
      const job = jobs.get(id);
      if (!job) return "gone";
      touch(job);
      return "ok";
    },

    release: (id: string, result: { exitCode?: number; durationMs?: number }) =>
      exclusive(async () => {
        const job = jobs.get(id);
        if (!job) return finished.has(id);
        finish(job, "released", result.exitCode ?? null, result.durationMs ?? null);
        await pass();
        return true;
      }),

    /** Periodic: reap, expire pauses, admit. */
    tick: () => exclusive(pass),

    /** Machine-level reasons a new unit of work should wait (agent tasks use the same thresholds). */
    machineReasons: async (priority = 1, memGb = 0) =>
      metricReasons(settings, await readMetrics(), priority, memGb),

    /**
     * Why a new agent task must wait, or null. Only the `agents` and `project:<name>` pauses apply
     * (`all-heavy` is shell jobs only), plus the shared machine thresholds when `machine` is set.
     */
    async agentGate(
      projectName: string | null,
      options: { machine?: boolean } = {},
    ): Promise<string | null> {
      const pause = store
        .listPauses(true)
        .find(
          (p) =>
            p.scope === "agents" ||
            (!!projectName && p.scope.toLowerCase() === "project:" + projectName.toLowerCase()),
        );
      if (pause)
        return (
          "中枢：" +
          describeWaitReason(
            `pause:${pause.scope}:${pause.reason || "无说明"}${pause.until ? "|" + pause.until : ""}`,
          )
        );
      if (options.machine === false) return null;
      const reasons = metricReasons(settings, await readMetrics(), 1);
      return reasons.length ? "中枢：" + reasons.map(describeWaitReason).join("、") : null;
    },

    /** Latest metrics (cached a few seconds), for the event watcher. */
    metrics: () => readMetrics(),

    async status() {
      const metrics = await readMetrics();
      const registry = store.listResources();
      const held = holders();
      const agentItems = new Map((deps.agents?.queue() ?? []).map((a) => [a.workspaceId, a]));
      const deferred = deps.agents?.deferred?.() ?? {};
      return {
        machine: {
          metrics,
          settings: { ...settings },
          blockedBy: metricReasons(settings, metrics, 1),
          localHolders: localHolders().slots,
        },
        holders: held.map((j) => ({
          jobId: j.id,
          owner: j.owner,
          project: j.project ?? null,
          command: j.command.slice(0, 300),
          priority: j.priority,
          units: j.units,
          exclusive: j.exclusive,
          resources: j.resources ?? [],
          pid: j.pid,
          admittedAt: j.admittedAt,
        })),
        queue: unifiedQueue().map((row, index) => {
          if (row.kind === "agent") {
            const a = agentItems.get(row.id);
            return {
              kind: "agent" as const,
              id: row.id,
              position: index + 1,
              priority: row.priority,
              owner: "agent",
              project: null as string | null,
              summary: a?.goal ?? "",
              resources: [] as Array<{ name: string; mode: string }>,
              queuedAt: a?.confirmedAt ?? null,
              waitReasons: deferred[row.id] ? [deferred[row.id]!] : ([] as string[]),
            };
          }
          const j = jobs.get(row.id)!;
          return {
            kind: "job" as const,
            id: j.id,
            position: index + 1,
            priority: j.priority,
            owner: j.owner,
            project: j.project ?? null,
            summary: j.command.slice(0, 300),
            resources: j.resources ?? [],
            queuedAt: j.queuedAt as string | null,
            waitReasons: j.waitReasons,
          };
        }),
        agents: { running: deps.agents?.running() ?? null },
        resources: registry.map((r) => ({
          ...r,
          holders: held.flatMap((j) =>
            (j.resources ?? [])
              .filter((x) => x.name === r.name)
              .map((x) => ({ jobId: j.id, owner: j.owner, mode: x.mode })),
          ),
        })),
        unregisteredResources: [
          ...new Set(
            held
              .flatMap((j) => (j.resources ?? []).map((r) => r.name))
              .filter((n) => !registry.some((r) => r.name === n)),
          ),
        ],
        pauses: store.listPauses(true),
        recentJobs: store.recentJobs(20),
      };
    },

    // --- pause rules -------------------------------------------------------------------
    createPause: (input: {
      scope: string;
      until?: string | null;
      reason?: string;
      issuedBy?: string;
    }) =>
      exclusive(async () => {
        const until = input.until ?? null;
        if (until !== null && Number.isNaN(Date.parse(until))) throw new Error("until 不是有效时间");
        const pause = store.createPause({
          scope: validatePauseScope(input.scope),
          until: until === null ? null : new Date(until).toISOString(),
          reason: input.reason ?? "",
          issuedBy: input.issuedBy ?? "user",
        });
        await pass();
        return pause;
      }),
    listPauses: (activeOnly = true): HubPause[] => store.listPauses(activeOnly),
    revokePause: (id: string) =>
      exclusive(async () => {
        const ok = store.revokePause(id);
        await pass();
        return ok;
      }),

    // --- shared resources --------------------------------------------------------------
    listResources: () => store.listResources(),
    upsertResource: (input: { name: string; maxShared?: number; note?: string }) => {
      const name = input.name.trim();
      if (!name) throw new Error("资源名不能为空");
      const existing = store.listResources().find((r) => r.name === name);
      store.upsertResource({
        name,
        maxShared: Math.max(1, Math.floor(input.maxShared ?? existing?.maxShared ?? 1)),
        note: input.note ?? existing?.note ?? "",
      });
      void exclusive(pass).catch(onError);
      return store.listResources().find((r) => r.name === name)!;
    },
    removeResource: (name: string) => store.removeResource(name),

    // --- settings ----------------------------------------------------------------------
    updateSettings: (patch: Partial<HubSettings>) =>
      exclusive(async () => {
        const next = { ...settings };
        for (const key of Object.keys(FILE_KEYS) as Array<keyof HubSettings>) {
          const v = patch[key];
          if (v === undefined) continue;
          if (!Number.isFinite(v) || v < 0) throw new Error(`设置 ${key} 无效`);
          next[key] = v;
        }
        if (next.hardLimit < 1) throw new Error("hardLimit 至少为 1");
        settings = next;
        store.writeSettings(settings);
        let fileError: string | undefined;
        if (admissionFile) {
          try {
            writeAdmissionFile(admissionFile, settings);
          } catch (error) {
            fileError = error instanceof Error ? error.message : String(error);
            onError(error);
          }
        }
        await pass();
        return { settings: { ...settings }, fileError };
      }),

    // --- queue ordering ----------------------------------------------------------------
    /**
     * `order` lists queue entries in the wanted order (jobs and agent tasks keep their own
     * relative order; unlisted jobs fall behind). `priorities` is job id -> 0-9.
     */
    reorder: (input: {
      order: Array<{ kind: "job" | "agent"; id: string }>;
      priorities?: Record<string, number>;
      reason: string;
    }) =>
      exclusive(async () => {
        const ids = input.order.map((o) => o.id);
        if (new Set(ids).size !== ids.length) throw new Error("队列中不能重复指定");
        const jobIds = input.order.filter((o) => o.kind === "job").map((o) => o.id);
        const agentIds = input.order.filter((o) => o.kind === "agent").map((o) => o.id);
        const priorities = Object.entries(input.priorities ?? {});
        for (const id of [...jobIds, ...priorities.map(([id]) => id)])
          if (jobs.get(id)?.state !== "queued") throw new Error("只能调整排队中的重任务：" + id);
        for (const [, priority] of priorities)
          if (!Number.isInteger(priority) || priority < 0 || priority > 9)
            throw new Error("优先级须为 0-9");
        if (agentIds.length > 0 && !deps.agents) throw new Error("agent 队列不可用");
        // Agent ordering can still throw (task-scheduler validates), so do it first.
        if (agentIds.length > 0) await deps.agents!.reorder(agentIds, input.reason);
        for (const [id, priority] of priorities) jobs.get(id)!.priority = priority;
        for (const job of jobs.values()) job.manualOrder = UNORDERED;
        jobIds.forEach((id, index) => (jobs.get(id)!.manualOrder = index));
        await pass();
        return { order: unifiedQueue().map((r) => ({ kind: r.kind, id: r.id })) };
      }),
  };
}

export type Hub = ReturnType<typeof createHub>;
