// Reads vibe-stats' usage_event rows (shared vibe.db) for the CLI sessions behind one agent and
// folds them into per-turn statistics. vibe-stats owns the table; if it is not migrated yet there
// is simply no data.

import type { VibeDb } from "../vibe/db";
import type { TurnStats } from "./classify";

export interface CallUsage {
  tsMs: number;
  context: number; // input + cacheRead + cacheWrite
  cacheRead: number;
}

/** A turn's wall-clock window in ms (turn_started .. turn_ended). */
export type TurnWindow = readonly [startMs: number, endMs: number];

/** Log timestamps trail/lead the hooks slightly. */
const SLACK_BEFORE_MS = 2_000;
const SLACK_AFTER_MS = 10_000;

interface Row {
  ts: string;
  tokens_in: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
}

/** Model calls of the given CLI session ids after `sinceIso`, oldest first. */
export function queryCallUsage(
  db: Pick<VibeDb, "prepare">,
  cliSessionIds: readonly string[],
  sinceIso?: string | null,
): CallUsage[] {
  if (cliSessionIds.length === 0) return [];
  const marks = cliSessionIds.map(() => "?").join(",");
  try {
    return db
      .prepare<Row>(
        `SELECT ts, tokens_in, tokens_cache_read, tokens_cache_write FROM usage_event
         WHERE session_id IN (${marks})${sinceIso ? " AND ts > ?" : ""} ORDER BY ts, id`,
      )
      .all(...cliSessionIds, ...(sinceIso ? [sinceIso] : []))
      .map((r) => ({
        tsMs: Date.parse(r.ts),
        context: r.tokens_in + r.tokens_cache_read + r.tokens_cache_write,
        cacheRead: r.tokens_cache_read,
      }));
  } catch {
    return []; // usage_event not created yet
  }
}

/** Turns come from agent turn windows; calls only decide each turn's peak context and cacheRead. */
export function buildTurnStats(windows: readonly TurnWindow[], calls: readonly CallUsage[]): TurnStats {
  return {
    turns: windows.length,
    cacheRead: calls.reduce((sum, c) => sum + c.cacheRead, 0),
    turnPeaks: windows.map(([start, end]) =>
      calls
        .filter((c) => c.tsMs >= start - SLACK_BEFORE_MS && c.tsMs <= end + SLACK_AFTER_MS)
        .reduce((max, c) => Math.max(max, c.context), 0),
    ),
  };
}
