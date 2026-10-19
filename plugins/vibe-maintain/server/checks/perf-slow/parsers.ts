// Parsers for slow-record sources (WP-47). Each turns raw text into `SlowSample`s: one measurement of
// one call site (route, query fingerprint, benchmark name).
//
// Known limits (best effort): MySQL/PostgreSQL parsers cover the stock slow-log layouts only (no
// JSON/CSV log formats, no auto_explain plans); statements are fingerprinted by replacing literals,
// so differently shaped but equivalent queries stay separate call sites.

import { basename } from "node:path";

export interface SlowSample {
  site: string;
  ms: number;
  /** ISO timestamp when the record carries one. */
  ts?: string;
}

export type SourceKind = "jsonl" | "bench-json" | "mysql-slow" | "pg-log";
export const SOURCE_KINDS: readonly SourceKind[] = ["jsonl", "bench-json", "mysql-slow", "pg-log"];

export interface JsonlFields {
  site?: string;
  ms?: string;
  ts?: string;
  method?: string;
}

const SITE_KEYS = ["site", "route", "path", "url", "endpoint", "callsite", "call_site", "name", "operation"];
const MS_KEYS = ["duration_ms", "durationMs", "elapsed_ms", "latency_ms", "responseTime", "ms", "duration", "elapsed", "latency", "time_ms"];
const TS_KEYS = ["ts", "time", "timestamp", "@timestamp", "date", "at"];
const UNIT_FACTOR = { ms: 1, s: 1000, us: 0.001, ns: 0.000001 } as const;
export type TimeUnit = keyof typeof UNIT_FACTOR;
export const TIME_UNITS = Object.keys(UNIT_FACTOR) as TimeUnit[];

/** Makes HTTP-ish call sites comparable: no query string, numeric/uuid/hex path segments become `:id`. */
export function normalizeSite(site: string): string {
  const noQuery = site.split(/[?#]/)[0] ?? site;
  return (
    noQuery
      .replace(/\/(\d+|[0-9a-f]{8}-[0-9a-f-]{27,}|[0-9a-f]{16,})(?=\/|$)/gi, "/:id")
      .replace(/(?<=.)\/+$/, "")
      .trim() || "/"
  );
}

/** Collapses a SQL statement into a call-site key: literals and IN lists become `?`. */
export function fingerprintSql(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "?")
    .replace(/\b0x[0-9a-f]+\b/gi, "?")
    .replace(/\$\d+/g, "?")
    .replace(/(?<![\w.])-?\d+(?:\.\d+)?\b/g, "?")
    .replace(/\(\s*\?(?:\s*,\s*\?)+\s*\)/g, "(?)")
    .replace(/\s+/g, " ")
    .replace(/;\s*$/, "")
    .trim()
    .slice(0, 300);
}

const pick = (row: Record<string, unknown>, explicit: string | undefined, keys: string[]): unknown => {
  if (explicit) return row[explicit];
  for (const k of keys) if (row[k] !== undefined && row[k] !== null) return row[k];
  return undefined;
};

/** ISO string from epoch seconds/ms, a numeric string or any Date-parsable text. */
export function toIso(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  let n: number;
  if (typeof value === "number" || /^\d+(\.\d+)?$/.test(String(value))) {
    const v = Number(value);
    n = v < 1e12 ? v * 1000 : v;
  } else {
    n = Date.parse(String(value));
  }
  return Number.isFinite(n) ? new Date(n).toISOString() : undefined;
}

/** JSON Lines, one object per line. Field names are configurable; defaults cover common loggers. */
export function parseJsonl(text: string, fields: JsonlFields = {}, unit: TimeUnit = "ms"): SlowSample[] {
  const out: SlowSample[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const site = pick(row, fields.site, SITE_KEYS);
    const raw = pick(row, fields.ms, MS_KEYS);
    const ms = typeof raw === "number" ? raw : typeof raw === "string" ? Number.parseFloat(raw) : Number.NaN;
    if (typeof site !== "string" || !Number.isFinite(ms)) continue;
    const method = pick(row, fields.method ?? "method", []);
    const label = normalizeSite(site);
    out.push({
      site: typeof method === "string" && method && !label.startsWith(method) ? `${method.toUpperCase()} ${label}` : label,
      ms: ms * UNIT_FACTOR[unit],
      ts: toIso(pick(row, fields.ts, TS_KEYS)),
    });
  }
  return out;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * Benchmark result JSON. Understood: hyperfine `--export-json` (`results[].mean` seconds), vitest bench
 * `--outputJson` (`files[].groups[].benchmarks[].mean` ms) and a generic list of
 * `{name|site|command, ms|mean_ms|duration_ms|time_ms}` (bare array, or under `results`/`benchmarks`).
 */
export function parseBenchJson(text: string): SlowSample[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return [];
  }
  const out: SlowSample[] = [];
  const root = (doc ?? {}) as Record<string, unknown>;
  const files = Array.isArray(root.files) ? (root.files as Record<string, unknown>[]) : [];
  for (const file of files) {
    const groups = Array.isArray(file.groups) ? (file.groups as Record<string, unknown>[]) : [];
    for (const group of groups) {
      const benchmarks = Array.isArray(group.benchmarks) ? (group.benchmarks as Record<string, unknown>[]) : [];
      for (const b of benchmarks) {
        const ms = num(b.mean) ?? num(b.median);
        if (ms !== undefined && typeof b.name === "string") {
          const scope = typeof file.filepath === "string" ? `${basename(file.filepath)} > ` : "";
          out.push({ site: `${scope}${b.name}`, ms });
        }
      }
    }
  }
  if (out.length) return out;
  const list = Array.isArray(doc)
    ? doc
    : Array.isArray(root.results)
      ? root.results
      : Array.isArray(root.benchmarks)
        ? root.benchmarks
        : [];
  for (const entry of list as Record<string, unknown>[]) {
    if (!entry || typeof entry !== "object") continue;
    const name = [entry.name, entry.site, entry.command].find((v) => typeof v === "string") as string | undefined;
    const direct = [entry.ms, entry.mean_ms, entry.duration_ms, entry.time_ms, entry.durationMs].map(num).find((v) => v !== undefined);
    // hyperfine reports seconds
    const ms = direct ?? (typeof entry.command === "string" && num(entry.mean) !== undefined ? num(entry.mean)! * 1000 : undefined);
    if (name && ms !== undefined) out.push({ site: name, ms });
  }
  return out;
}

/**
 * MySQL/MariaDB slow query log (`# Query_time: 2.5 ...` blocks). `consumed` is the number of characters
 * of `text` that hold complete blocks: a trailing block without its terminating `;` is left for the next read.
 */
export function parseMysqlSlow(text: string): { samples: SlowSample[]; consumed: number } {
  const samples: SlowSample[] = [];
  let time: string | undefined;
  let queryMs: number | undefined;
  let sql: string[] = [];
  let blockStart: number | null = null;
  let offset = 0;
  for (const line of text.split("\n")) {
    const lineStart = offset;
    offset += line.length + 1;
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) {
      if (sql.length === 0) blockStart ??= lineStart;
      const t = /^# Time:\s*(.+)$/.exec(trimmed);
      if (t) time = toIso(t[1]!.trim());
      const q = /^# Query_time:\s*([\d.]+)/.exec(trimmed);
      if (q) queryMs = Number.parseFloat(q[1]!) * 1000;
      continue;
    }
    if (queryMs === undefined || !trimmed) continue;
    const setTs = /^SET timestamp=(\d+);?$/i.exec(trimmed);
    if (setTs) {
      time = toIso(Number(setTs[1])) ?? time;
      continue;
    }
    if (sql.length === 0 && /^use\s+\S+;$/i.test(trimmed)) continue;
    sql.push(trimmed);
    if (trimmed.endsWith(";")) {
      samples.push({ site: fingerprintSql(sql.join(" ")), ms: queryMs, ts: time });
      sql = [];
      queryMs = undefined;
      blockStart = null;
    }
  }
  return { samples, consumed: blockStart ?? text.length };
}

/**
 * PostgreSQL server log with `log_min_duration_statement`:
 * `... LOG:  duration: 2500.123 ms  statement: SELECT ...` (also `execute <name>:`); continuation lines
 * are tab/space indented.
 */
export function parsePgLog(text: string): SlowSample[] {
  const out: SlowSample[] = [];
  let current: { ms: number; ts?: string; sql: string[] } | null = null;
  const flush = () => {
    if (current?.sql.length) out.push({ site: fingerprintSql(current.sql.join(" ")), ms: current.ms, ts: current.ts });
    current = null;
  };
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\d{4}-\d\d-\d\d[ T][\d:.]+)?.*?\bLOG:\s+duration:\s+([\d.]+)\s+ms\s+(?:statement|execute\s+[^:]*):\s*(.*)$/.exec(line);
    if (m) {
      flush();
      current = {
        ms: Number.parseFloat(m[2]!),
        ts: m[1] ? toIso(`${m[1].replace(" ", "T")}Z`) : undefined,
        sql: m[3] ? [m[3].trim()] : [],
      };
    } else if (current && /^\s+\S/.test(line)) {
      current.sql.push(line.trim());
    } else if (line.trim()) {
      flush();
    }
  }
  flush();
  return out;
}

export interface SiteStats {
  site: string;
  count: number;
  slowCount: number;
  maxMs: number;
  p95Ms: number;
  meanMs: number;
  lastTs?: string;
}

export function aggregate(samples: SlowSample[], thresholdMs: number): SiteStats[] {
  const bySite = new Map<string, SlowSample[]>();
  for (const s of samples) bySite.set(s.site, [...(bySite.get(s.site) ?? []), s]);
  return [...bySite.entries()].map(([site, list]) => {
    const sorted = list.map((s) => s.ms).sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
    return {
      site,
      count: list.length,
      slowCount: sorted.filter((v) => v > thresholdMs).length,
      maxMs: sorted.at(-1)!,
      p95Ms: p95,
      meanMs: sorted.reduce((a, b) => a + b, 0) / sorted.length,
      lastTs: list.map((s) => s.ts).filter(Boolean).sort().at(-1),
    };
  });
}
