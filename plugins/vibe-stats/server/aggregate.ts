// Read-side statistics over usage_event (own table) plus read-only joins on core tables
// (card, project, agent_session, vibe_event) and the scheduler's resource_sample.

import type { Overview, Period, StatsGroup, TokenTotals } from "../shared/rpc";
import type { VibeDb } from "./vibe/db";

const DAY_MS = 86_400_000;
/** A call whose context shrinks below this fraction of the previous one is a compaction. */
const COMPACTION_RATIO = 0.5;
const COMPACTION_MIN_CONTEXT = 20_000;
const MAX_TASK_ROWS = 20;
const RESOURCE_HISTORY = 60;

export function periodStart(period: Period, now: Date): string | null {
  if (period === "all") return null;
  if (period === "today") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }
  return new Date(now.getTime() - (period === "7d" ? 7 : 30) * DAY_MS).toISOString();
}

interface GroupRow {
  k: string | null;
  label: string | null;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cost: number;
  events: number;
}

const SUMS = `SUM(e.tokens_in) AS input, SUM(e.tokens_out) AS output,
  SUM(e.tokens_cache_read) AS cache_read, SUM(e.tokens_cache_write) AS cache_write,
  SUM(COALESCE(e.cost, 0)) AS cost, COUNT(*) AS events`;

const toGroup = (r: GroupRow): StatsGroup => ({
  key: r.k ?? "",
  label: r.label ?? r.k ?? "(unlinked)",
  input: r.input,
  output: r.output,
  cacheRead: r.cache_read,
  cacheWrite: r.cache_write,
  cost: r.cost,
  events: r.events,
});

/** Nearest-rank percentile of an ascending array. */
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1] ?? null;
}

function tableExists(db: VibeDb, name: string): boolean {
  return !!db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function speedStats(provider: string, rates: number[]) {
  const sorted = [...rates].sort((a, b) => a - b);
  return {
    provider,
    median: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    samples: sorted.length,
  };
}

interface CallRow {
  session_id: string;
  card_id: string | null;
  ctx: number;
}

/** Context size before/after each compaction, detected as a sharp drop between consecutive calls. */
export function detectCompactions(rows: CallRow[]) {
  const found: Array<{ cardId: string | null; before: number; after: number }> = [];
  let prev: CallRow | null = null;
  for (const row of rows) {
    if (
      prev &&
      prev.session_id === row.session_id &&
      prev.ctx >= COMPACTION_MIN_CONTEXT &&
      row.ctx < prev.ctx * COMPACTION_RATIO
    ) {
      found.push({ cardId: row.card_id ?? prev.card_id, before: prev.ctx, after: row.ctx });
    }
    prev = row;
  }
  return found;
}

/** Total time sessions of each card spent between session.waiting and session.answered. */
function waitingByCard(db: VibeDb, since: string | null): Map<string, number> {
  const rows = db
    .prepare<{ ts: string; type: string; card_id: string | null; payload_json: string }>(
      `SELECT ts, type, card_id, payload_json FROM vibe_event
       WHERE type IN ('session.waiting', 'session.answered') AND card_id IS NOT NULL
         AND (? IS NULL OR ts >= ?) ORDER BY seq`,
    )
    .all(since, since);
  const open = new Map<string, number>();
  const total = new Map<string, number>();
  for (const r of rows) {
    let sessionId = "";
    try {
      sessionId = String((JSON.parse(r.payload_json) as { sessionId?: unknown }).sessionId ?? "");
    } catch {
      continue;
    }
    const ts = Date.parse(r.ts);
    if (r.type === "session.waiting") open.set(sessionId, ts);
    else {
      const start = open.get(sessionId);
      if (start === undefined || !r.card_id) continue;
      open.delete(sessionId);
      total.set(r.card_id, (total.get(r.card_id) ?? 0) + Math.max(0, ts - start));
    }
  }
  return total;
}

interface PoolShape {
  busy: number;
  total: number;
}

/** Scheduler format is not final: accept {busy,total} or a map of device -> leased flag/object. */
export function readPool(json: string): PoolShape {
  try {
    const v: unknown = JSON.parse(json);
    if (!v || typeof v !== "object") return { busy: 0, total: 0 };
    const o = v as Record<string, unknown>;
    if (typeof o.busy === "number" && typeof o.total === "number") {
      return { busy: o.busy, total: o.total };
    }
    const values = Object.values(o);
    const busy = values.filter((x) => {
      if (x === true) return true;
      if (typeof x === "string") return x !== "free" && x !== "idle" && x !== "";
      if (x && typeof x === "object") {
        const d = x as Record<string, unknown>;
        return !!(d.leased || d.busy || d.cardId || d.leaseId);
      }
      return false;
    }).length;
    return { busy, total: values.length };
  } catch {
    return { busy: 0, total: 0 };
  }
}

export function computeOverview(
  db: VibeDb,
  period: Period,
  now: Date = new Date(),
  index: { files: number; lastScanAt: string | null } = { files: 0, lastScanAt: null },
): Overview {
  const since = periodStart(period, now);
  const where = "WHERE (? IS NULL OR e.ts >= ?)";
  const args = [since, since];

  const group = (keyExpr: string, labelExpr: string, join = ""): StatsGroup[] =>
    db
      .prepare<GroupRow>(
        `SELECT ${keyExpr} AS k, ${labelExpr} AS label, ${SUMS} FROM usage_event e ${join}
         ${where} GROUP BY k ORDER BY (SUM(e.tokens_in) + SUM(e.tokens_out)
           + SUM(e.tokens_cache_read) + SUM(e.tokens_cache_write)) DESC`,
      )
      .all(...args)
      .map(toGroup);

  const byProvider = group("e.provider", "e.provider");
  const byModel = group("e.provider || '/' || e.model", "e.model");
  const byProject = group(
    "COALESCE(p.id, '')",
    "COALESCE(p.name, '(unlinked)')",
    "LEFT JOIN card c ON c.id = e.card_id LEFT JOIN project p ON p.id = c.project_id",
  );
  const byDay = group("date(e.ts, 'localtime')", "date(e.ts, 'localtime')").sort((a, b) =>
    a.key.localeCompare(b.key),
  );

  const totals: TokenTotals = byProvider.reduce(
    (t, g) => ({
      input: t.input + g.input,
      output: t.output + g.output,
      cacheRead: t.cacheRead + g.cacheRead,
      cacheWrite: t.cacheWrite + g.cacheWrite,
      cost: t.cost + g.cost,
      events: t.events + g.events,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, events: 0 },
  );

  // Output speed: tokens per second of each turn that has a measured duration.
  const speedRows = db
    .prepare<{ provider: string; out: number; ms: number }>(
      `SELECT e.provider, e.tokens_out AS out, e.duration_ms AS ms FROM usage_event e
       ${where} AND e.duration_ms > 0 AND e.tokens_out > 0`,
    )
    .all(...args);
  const rates = new Map<string, number[]>();
  for (const r of speedRows) {
    const list = rates.get(r.provider) ?? [];
    list.push(r.out / (r.ms / 1000));
    rates.set(r.provider, list);
  }
  const speed = {
    overall: speedStats("all", [...rates.values()].flat()),
    byProvider: [...rates].map(([p, l]) => speedStats(p, l)),
  };

  // Compactions, then per-task rows.
  const calls = db
    .prepare<CallRow>(
      `SELECT e.session_id, e.card_id, e.tokens_in + e.tokens_cache_read + e.tokens_cache_write AS ctx
       FROM usage_event e ${where} ORDER BY e.session_id, e.ts, e.id`,
    )
    .all(...args);
  const compactions = detectCompactions(calls);
  const sum = (f: (c: (typeof compactions)[number]) => number) =>
    compactions.length ? Math.round(compactions.reduce((s, c) => s + f(c), 0) / compactions.length) : 0;

  const waiting = waitingByCard(db, since);
  const taskRows = db
    .prepare<{ card_id: string; key: string; title: string; tokens: number; cost: number }>(
      `SELECT c.id AS card_id, c.key AS key, c.title AS title,
         SUM(e.tokens_in + e.tokens_out + e.tokens_cache_read + e.tokens_cache_write) AS tokens,
         SUM(COALESCE(e.cost, 0)) AS cost
       FROM usage_event e JOIN card c ON c.id = e.card_id ${where}
       GROUP BY c.id ORDER BY tokens DESC LIMIT ${MAX_TASK_ROWS}`,
    )
    .all(...args);
  const sessionSpan = db.prepare<{ ms: number | null }>(
    `SELECT SUM(MAX(0, (julianday(COALESCE(ended_at, last_activity_at)) - julianday(started_at))
       * 86400000)) AS ms FROM agent_session WHERE card_id = ?`,
  );
  const tasks = taskRows.map((r) => ({
    cardId: r.card_id,
    key: r.key,
    title: r.title,
    tokens: r.tokens,
    cost: r.cost,
    durationMs: Math.round(sessionSpan.get(r.card_id)?.ms ?? 0),
    waitingMs: Math.round(waiting.get(r.card_id) ?? 0),
    compactions: compactions
      .filter((c) => c.cardId === r.card_id)
      .map(({ before, after }) => ({ before, after })),
  }));

  // Resources: scheduler writes resource_sample; this plugin only reads it.
  const count = (states: string) =>
    db
      .prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM agent_session WHERE state IN (${states})`)
      .get()?.n ?? 0;
  let latest: Overview["resources"]["latest"] = null;
  let history: Overview["resources"]["history"] = [];
  if (tableExists(db, "resource_sample")) {
    const rows = db
      .prepare<{
        ts: string;
        cpu: number;
        mem: number;
        per_session_json: string;
        device_pool_json: string;
      }>(`SELECT ts, cpu, mem, per_session_json, device_pool_json FROM resource_sample
          ORDER BY ts DESC, id DESC LIMIT ${RESOURCE_HISTORY}`)
      .all();
    const head = rows[0];
    if (head) {
      let sessions = 0;
      try {
        sessions = Object.keys(JSON.parse(head.per_session_json) as object).length;
      } catch {
        sessions = 0;
      }
      const pool = readPool(head.device_pool_json);
      latest = {
        ts: head.ts,
        cpu: head.cpu,
        mem: head.mem,
        sessions,
        devicesBusy: pool.busy,
        devicesTotal: pool.total,
      };
    }
    history = rows.reverse().map((r) => ({ ts: r.ts, cpu: r.cpu, mem: r.mem }));
  }

  return {
    generatedAt: now.toISOString(),
    period,
    totals,
    byProvider,
    byModel,
    byProject,
    byDay,
    speed,
    tasks,
    compactions: { count: compactions.length, avgBefore: sum((c) => c.before), avgAfter: sum((c) => c.after) },
    resources: {
      runningSessions: count("'starting','working'"),
      waitingSessions: count("'waiting'"),
      latest,
      history,
    },
    index,
  };
}
