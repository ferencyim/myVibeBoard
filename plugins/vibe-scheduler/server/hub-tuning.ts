// Threshold auto-tuning support (docs/vibe/HUB-DESIGN.md 4.1): minute-level metric history, events
// worth reacting to, and a guarded way for the coordinator bot to move the machine thresholds.
// The safety floors below are code constants; no tool can step past them.

import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { VibeDb } from "./vibe/db";
import type { HubMetrics } from "./hub-metrics";
import type { HubSettings } from "./hub";

type Tunable = "minAvailableGb" | "deployMinAvailableGb" | "maxCommitPercent" | "maxCpuPercent" | "hardLimit";

/** Hard bounds and the largest single move per adjustment. Not configurable on purpose. */
export const TUNE_LIMITS: Record<Tunable, { min: number; max: number; step: number; integer?: boolean }> = {
  minAvailableGb: { min: 2, max: 128, step: 3 },
  deployMinAvailableGb: { min: 2, max: 128, step: 3 },
  maxCommitPercent: { min: 50, max: 92, step: 5 },
  maxCpuPercent: { min: 30, max: 98, step: 5 },
  hardLimit: { min: 1, max: 8, step: 1, integer: true },
};
export const TUNE_MIN_INTERVAL_MS = 30 * 60_000;
export const USER_PROTECT_MS = 30 * 60_000;
export const HISTORY_KEEP_DAYS = 14;
const CHANGE_KEEP_DAYS = 90;
const EVENT_DEDUPE_MS = 10 * 60_000;
const MEMORY_EVENT_KINDS = ["memory_low", "commit_high", "job_oom", "job_commit_limit"];
/** Windows exit codes of a process that ran out of memory / commit (unsigned and signed forms). */
const OOM_EXIT_CODES = new Set([0xc0000017, 0xc000012d]);

export type TuneChanges = Partial<Record<Tunable, number>>;
export type TuneActor = "user" | "coordinator";
export interface TuneChangeRow {
  id: string;
  at: string;
  actor: TuneActor;
  old: Record<string, number>;
  new: Record<string, number>;
  reason: string;
}
export interface HubEventRow {
  id: string;
  at: string;
  kind: string;
  detail: Record<string, unknown>;
}

interface Acc {
  minute: string;
  samples: number;
  minAvail: number | null;
  maxCommit: number | null;
  cpuSum: number;
  cpuN: number;
  maxCpu: number | null;
  maxProc: number | null;
  maxHandles: number | null;
  maxDisk: number | null;
  maxRunning: number;
  maxWait: number;
}
const max = (a: number | null, b: number | undefined) => (b === undefined ? a : a === null ? b : Math.max(a, b));
const min = (a: number | null, b: number | undefined) => (b === undefined ? a : a === null ? b : Math.min(a, b));
const daysAgo = (now: Date, days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();

export function createHubHistory(options: {
  db: VibeDb;
  now?: () => Date;
  /** Cheap live load (running heavy jobs, longest queue wait). */
  load?: () => { running: number; maxQueueWaitMs: number };
  /** Guard lock directory; its audit log is scanned for job commit-limit hits. */
  lockDir?: string | null;
  /** A new event was recorded (after dedupe). */
  onEvent?: (event: HubEventRow) => void;
}) {
  const { db } = options;
  const now = options.now ?? (() => new Date());
  let acc: Acc | null = null;
  let lastEventAt = new Map<string, number>();
  let lastPrune = 0;
  const audit = { file: "", offset: 0 };

  function persist(a: Acc) {
    db.prepare(
      `INSERT OR REPLACE INTO hub_metric_minute
       (minute,samples,min_available_gb,max_commit_percent,avg_cpu_percent,max_cpu_percent,max_processes,max_handles,max_disk_queue,max_running,max_queue_wait_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      a.minute, a.samples, a.minAvail, a.maxCommit, a.cpuN ? a.cpuSum / a.cpuN : null, a.maxCpu,
      a.maxProc, a.maxHandles, a.maxDisk, a.maxRunning, Math.round(a.maxWait),
    );
  }

  function recordEvent(kind: string, detail: Record<string, unknown> = {}, dedupe = true): HubEventRow | null {
    const t = now().getTime();
    if (dedupe) {
      const last = lastEventAt.get(kind);
      if (last !== undefined && t - last < EVENT_DEDUPE_MS) return null;
      lastEventAt.set(kind, t);
    }
    const row: HubEventRow = { id: randomUUID(), at: new Date(t).toISOString(), kind, detail };
    db.prepare("INSERT INTO hub_event (id,at,kind,detail_json) VALUES (?,?,?,?)").run(
      row.id, row.at, kind, JSON.stringify(detail),
    );
    options.onEvent?.(row);
    return row;
  }

  function scanAudit() {
    if (!options.lockDir) return;
    const file = join(options.lockDir, "logs", now().toISOString().slice(0, 10) + ".jsonl");
    if (!existsSync(file)) return;
    const size = statSync(file).size;
    if (audit.file !== file) {
      // First sight of a file: do not replay what happened before the hub looked.
      audit.file = file;
      audit.offset = size;
      return;
    }
    if (size <= audit.offset) return;
    const buffer = Buffer.alloc(Math.min(size - audit.offset, 1_000_000));
    const fd = openSync(file, "r");
    try {
      readSync(fd, buffer, 0, buffer.length, audit.offset);
    } finally {
      closeSync(fd);
    }
    const text = buffer.toString("utf8");
    const end = text.lastIndexOf("\n");
    if (end < 0) return;
    audit.offset += Buffer.byteLength(text.slice(0, end + 1));
    for (const line of text.slice(0, end).split("\n")) {
      try {
        const e = JSON.parse(line) as Record<string, unknown>;
        if (e.event === "end" && e.job_commit_limit_exceeded === true)
          recordEvent("job_commit_limit", { owner: e.owner, exitCode: e.exit_code }, false);
      } catch {
        // partial or foreign line
      }
    }
  }

  function prune() {
    const t = now();
    if (t.getTime() - lastPrune < 3_600_000) return;
    lastPrune = t.getTime();
    db.prepare("DELETE FROM hub_metric_minute WHERE minute < ?").run(daysAgo(t, HISTORY_KEEP_DAYS).slice(0, 16));
    db.prepare("DELETE FROM hub_event WHERE at < ?").run(daysAgo(t, HISTORY_KEEP_DAYS));
    db.prepare("DELETE FROM hub_threshold_change WHERE at < ?").run(daysAgo(t, CHANGE_KEEP_DAYS));
  }

  function flush() {
    if (acc) persist(acc);
    try {
      scanAudit();
    } catch {
      // the audit log is best effort
    }
    prune();
  }

  return {
    /** One background sample (every few seconds); rolls the per-minute aggregate. */
    record(m: HubMetrics) {
      const minute = (m.ts || now().toISOString()).slice(0, 16);
      if (acc && acc.minute !== minute) {
        persist(acc);
        acc = null;
        try {
          scanAudit();
        } catch {
          // best effort
        }
        prune();
      }
      acc ??= {
        minute, samples: 0, minAvail: null, maxCommit: null, cpuSum: 0, cpuN: 0, maxCpu: null,
        maxProc: null, maxHandles: null, maxDisk: null, maxRunning: 0, maxWait: 0,
      };
      const load = options.load?.() ?? { running: 0, maxQueueWaitMs: 0 };
      acc.samples += 1;
      acc.minAvail = min(acc.minAvail, m.availableGb);
      acc.maxCommit = max(acc.maxCommit, m.commitPercent);
      if (m.cpuPercent !== undefined) {
        acc.cpuSum += m.cpuPercent;
        acc.cpuN += 1;
      }
      acc.maxCpu = max(acc.maxCpu, m.cpuPercent);
      acc.maxProc = max(acc.maxProc, m.processes);
      acc.maxHandles = max(acc.maxHandles, m.handles);
      acc.maxDisk = max(acc.maxDisk, m.diskQueue);
      acc.maxRunning = Math.max(acc.maxRunning, load.running);
      acc.maxWait = Math.max(acc.maxWait, load.maxQueueWaitMs);
      if (m.commitPercent !== undefined && m.commitPercent >= 95)
        recordEvent("commit_high", { commitPercent: m.commitPercent });
      if (m.availableGb !== undefined && m.availableGb < 2)
        recordEvent("memory_low", { availableGb: m.availableGb });
    },
    /** A heavy job ended; an out-of-memory style exit code counts as an event. */
    jobFinished(job: { owner: string; exitCode: number | null }) {
      if (job.exitCode !== null && OOM_EXIT_CODES.has(job.exitCode >>> 0))
        recordEvent("job_oom", { owner: job.owner, exitCode: job.exitCode >>> 0 }, false);
    },
    recordEvent,
    flush,

    events(sinceIso: string, limit = 100): HubEventRow[] {
      return db
        .prepare<{ id: string; at: string; kind: string; detail_json: string }>(
          "SELECT * FROM hub_event WHERE at >= ? ORDER BY at DESC LIMIT ?",
        )
        .all(sinceIso, limit)
        .map((r) => ({ id: r.id, at: r.at, kind: r.kind, detail: JSON.parse(r.detail_json) as Record<string, unknown> }));
    },
    countEventsSince(kinds: string[], sinceIso: string): number {
      const row = db
        .prepare<{ n: number }>(
          `SELECT COUNT(*) AS n FROM hub_event WHERE at >= ? AND kind IN (${kinds.map(() => "?").join(",")})`,
        )
        .get(sinceIso, ...kinds);
      return row?.n ?? 0;
    },

    /** Aggregates over the last `hours` (1-336): a summary, hourly buckets and recent events. */
    query(hours: number) {
      flush();
      const h = Math.min(Math.max(Math.floor(hours) || 24, 1), HISTORY_KEEP_DAYS * 24);
      const since = new Date(now().getTime() - h * 3_600_000).toISOString();
      const rows = db
        .prepare<Record<string, number | string | null>>(
          "SELECT * FROM hub_metric_minute WHERE minute >= ? ORDER BY minute",
        )
        .all(since.slice(0, 16));
      const buckets = new Map<string, Record<string, number | null>>();
      const total = { minutes: rows.length, cpuSum: 0, cpuN: 0 } as Record<string, number>;
      const sum: Record<string, number | null> = {
        minAvailableGb: null, maxCommitPercent: null, maxCpuPercent: null, maxProcesses: null,
        maxHandles: null, maxDiskQueue: null, maxRunning: 0, maxQueueWaitMin: 0,
      };
      let minutesQueuedOver15 = 0;
      let minutesIdleWithQueue = 0;
      for (const r of rows) {
        const key = (r.minute as string).slice(0, 13) + ":00";
        const b = buckets.get(key) ?? { cpuSum: 0, cpuN: 0 };
        const cpu = r.avg_cpu_percent as number | null;
        if (cpu !== null) {
          b.cpuSum! += cpu;
          b.cpuN! += 1;
          total.cpuSum += cpu;
          total.cpuN += 1;
        }
        b.minAvailableGb = min((b.minAvailableGb ?? null) as number | null, (r.min_available_gb as number | null) ?? undefined);
        b.maxCommitPercent = max((b.maxCommitPercent ?? null) as number | null, (r.max_commit_percent as number | null) ?? undefined);
        b.maxCpuPercent = max((b.maxCpuPercent ?? null) as number | null, (r.max_cpu_percent as number | null) ?? undefined);
        b.maxRunning = Math.max(b.maxRunning ?? 0, r.max_running as number);
        b.maxQueueWaitMin = Math.max(b.maxQueueWaitMin ?? 0, Math.round((r.max_queue_wait_ms as number) / 6000) / 10);
        buckets.set(key, b);
        sum.minAvailableGb = min(sum.minAvailableGb, (r.min_available_gb as number | null) ?? undefined);
        sum.maxCommitPercent = max(sum.maxCommitPercent, (r.max_commit_percent as number | null) ?? undefined);
        sum.maxCpuPercent = max(sum.maxCpuPercent, (r.max_cpu_percent as number | null) ?? undefined);
        sum.maxProcesses = max(sum.maxProcesses, (r.max_processes as number | null) ?? undefined);
        sum.maxHandles = max(sum.maxHandles, (r.max_handles as number | null) ?? undefined);
        sum.maxDiskQueue = max(sum.maxDiskQueue, (r.max_disk_queue as number | null) ?? undefined);
        sum.maxRunning = Math.max(sum.maxRunning as number, r.max_running as number);
        sum.maxQueueWaitMin = Math.max(sum.maxQueueWaitMin as number, Math.round((r.max_queue_wait_ms as number) / 6000) / 10);
        if ((r.max_queue_wait_ms as number) >= 15 * 60_000) minutesQueuedOver15 += 1;
        // Jobs waiting while the machine sat comfortably idle is the "too tight" signal.
        if ((r.max_queue_wait_ms as number) > 0 && ((r.max_cpu_percent as number | null) ?? 100) < 50)
          minutesIdleWithQueue += 1;
      }
      const events = this.events(since);
      const eventCounts: Record<string, number> = {};
      for (const e of events) eventCounts[e.kind] = (eventCounts[e.kind] ?? 0) + 1;
      return {
        windowHours: h,
        since,
        summary: {
          ...sum,
          avgCpuPercent: total.cpuN ? Math.round((total.cpuSum / total.cpuN) * 10) / 10 : null,
          minutesWithData: rows.length,
          minutesQueuedOver15,
          minutesIdleWithQueue,
        },
        hourly: [...buckets].map(([hour, b]) => ({
          hour,
          minAvailableGb: b.minAvailableGb ?? null,
          maxCommitPercent: b.maxCommitPercent ?? null,
          avgCpuPercent: b.cpuN ? Math.round((b.cpuSum! / b.cpuN!) * 10) / 10 : null,
          maxCpuPercent: b.maxCpuPercent ?? null,
          maxRunning: b.maxRunning ?? 0,
          maxQueueWaitMin: b.maxQueueWaitMin ?? 0,
        })),
        eventCounts,
        events: events.slice(0, 50),
      };
    },
  };
}
export type HubHistory = ReturnType<typeof createHubHistory>;

function validate(settings: HubSettings, changes: TuneChanges): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(changes)) {
    const rule = TUNE_LIMITS[key as Tunable];
    if (!rule) throw new Error(`阈值 ${key} 不能由总协调调整（可调：${Object.keys(TUNE_LIMITS).join("、")}）`);
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} 必须是数字`);
    if (rule.integer && !Number.isInteger(value)) throw new Error(`${key} 必须是整数`);
    if (value < rule.min || value > rule.max)
      throw new Error(`${key} 须在 ${rule.min}-${rule.max} 之间（安全底线）`);
    const current = settings[key as Tunable];
    if (Math.abs(value - current) > rule.step + 1e-9)
      throw new Error(`${key} 单次最多调整 ${rule.step}（当前 ${current}，请求 ${value}）`);
    if (value !== current) out[key] = value;
  }
  if (Object.keys(out).length === 0) throw new Error("没有需要调整的阈值");
  return out;
}

export function createHubTuning(options: {
  db: VibeDb;
  now?: () => Date;
  history: HubHistory;
  settings: () => HubSettings;
  update: (patch: Partial<HubSettings>) => Promise<{ settings: HubSettings; fileError?: string }>;
  /** Tell the user (server.notify). */
  notifyUser?: (title: string, body: string) => void;
  /** Write a system message to the coordinator bot. */
  tellCoordinator?: (key: string, text: string) => void;
}) {
  const { db } = options;
  const now = options.now ?? (() => new Date());

  function insert(actor: TuneActor, oldV: Record<string, number>, newV: Record<string, number>, reason: string) {
    const row: TuneChangeRow = { id: randomUUID(), at: now().toISOString(), actor, old: oldV, new: newV, reason };
    db.prepare("INSERT INTO hub_threshold_change (id,at,actor,old_json,new_json,reason) VALUES (?,?,?,?,?,?)").run(
      row.id, row.at, actor, JSON.stringify(oldV), JSON.stringify(newV), reason,
    );
    return row;
  }
  function last(actor: TuneActor): TuneChangeRow | null {
    return list(1, actor)[0] ?? null;
  }
  function list(limit: number, actor?: TuneActor): TuneChangeRow[] {
    return db
      .prepare<{ id: string; at: string; actor: TuneActor; old_json: string; new_json: string; reason: string }>(
        `SELECT * FROM hub_threshold_change ${actor ? "WHERE actor = ?" : ""} ORDER BY at DESC LIMIT ?`,
      )
      .all(...(actor ? [actor, limit] : [limit]))
      .map((r) => ({
        id: r.id, at: r.at, actor: r.actor, old: JSON.parse(r.old_json) as Record<string, number>,
        new: JSON.parse(r.new_json) as Record<string, number>, reason: r.reason,
      }));
  }
  const describe = (oldV: Record<string, number>, newV: Record<string, number>) =>
    Object.keys(newV).map((k) => `${k}: ${oldV[k]} -> ${newV[k]}`).join("；");

  return {
    limits: TUNE_LIMITS,
    history: (limit = 50) => list(Math.min(Math.max(limit, 1), 200)),

    /** Coordinator adjustment: floors, step size, 30 min spacing and the user-change guard apply. */
    async set(input: { changes: TuneChanges; reason: string }) {
      const reason = input.reason?.trim();
      if (!reason) throw new Error("必须写明调整理由");
      const t = now().getTime();
      const prev = last("coordinator");
      if (prev && t - Date.parse(prev.at) < TUNE_MIN_INTERVAL_MS)
        throw new Error(`距上次调整不足 30 分钟，${Math.ceil((TUNE_MIN_INTERVAL_MS - (t - Date.parse(prev.at))) / 60_000)} 分钟后再试`);
      const user = last("user");
      if (user && t - Date.parse(user.at) < USER_PROTECT_MS && options.history.countEventsSince(MEMORY_EVENT_KINDS, user.at) === 0)
        throw new Error("用户刚手动改过阈值（30 分钟内且没有内存事件），暂不覆盖");
      const current = options.settings();
      const changes = validate(current, input.changes);
      const oldV: Record<string, number> = {};
      for (const key of Object.keys(changes)) oldV[key] = current[key as Tunable];
      const result = await options.update(changes);
      const row = insert("coordinator", oldV, changes, reason);
      const text = `总协调调整了资源阈值：${describe(oldV, changes)}。理由：${reason}`;
      options.notifyUser?.("资源阈值已调整", text);
      options.tellCoordinator?.("threshold:" + row.id, text);
      return { change: row, settings: result.settings, fileError: result.fileError };
    },

    /** The user changed thresholds on the hub page. */
    recordUser(before: HubSettings, after: HubSettings) {
      const oldV: Record<string, number> = {};
      const newV: Record<string, number> = {};
      for (const key of Object.keys(after) as Array<keyof HubSettings>)
        if (before[key] !== after[key]) {
          oldV[key] = before[key];
          newV[key] = after[key];
        }
      if (Object.keys(newV).length === 0) return null;
      const row = insert("user", oldV, newV, "用户在中枢页手动修改");
      options.tellCoordinator?.("threshold:" + row.id, `用户手动修改了资源阈值：${describe(oldV, newV)}。30 分钟内不要覆盖。`);
      return row;
    },
  };
}
export type HubTuning = ReturnType<typeof createHubTuning>;
