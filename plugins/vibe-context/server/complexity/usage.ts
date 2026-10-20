// Reads vibe-stats' usage_event rows (shared vibe.db) for the CLI sessions behind one agent.
// vibe-stats owns the table; if it is not migrated yet there is simply no data.

import type { VibeDb } from "../vibe/db";
import type { TurnUsage } from "./classify";

interface Row {
  tokens_in: number;
  tokens_out: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
}

/** Usage rows of the given CLI session ids, oldest first; `sinceIso` excludes older rows. */
export function queryTurnUsage(
  db: Pick<VibeDb, "prepare">,
  cliSessionIds: readonly string[],
  sinceIso?: string | null,
): TurnUsage[] {
  if (cliSessionIds.length === 0) return [];
  const marks = cliSessionIds.map(() => "?").join(",");
  try {
    const rows = db
      .prepare<Row>(
        `SELECT tokens_in, tokens_out, tokens_cache_read, tokens_cache_write FROM usage_event
         WHERE session_id IN (${marks})${sinceIso ? " AND ts > ?" : ""} ORDER BY ts, id`,
      )
      .all(...cliSessionIds, ...(sinceIso ? [sinceIso] : []));
    return rows.map((r) => ({
      tokensIn: r.tokens_in,
      tokensOut: r.tokens_out,
      cacheRead: r.tokens_cache_read,
      cacheWrite: r.tokens_cache_write,
    }));
  } catch {
    return []; // usage_event not created yet
  }
}
