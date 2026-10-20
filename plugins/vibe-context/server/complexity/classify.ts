// Conversation complexity (WP-83): short / multi / long from effective agent turns and cache reads.
// Pure. A "turn" is one Paseo agent turn (turn_started .. turn_ended) that a plugin did not start
// itself; a turn can contain dozens of model calls (usage_event rows), which count as ONE turn.

import type { SessionComplexity } from "../vibe/contract";

export interface TurnStats {
  /** Effective agent turns since the last compaction. */
  turns: number;
  /** Summed cacheRead of all model calls since the last compaction. */
  cacheRead: number;
  /** Per turn: the largest context (input + cacheRead + cacheWrite) of any call inside it. */
  turnPeaks: readonly number[];
}

export interface ComplexityThresholds {
  /** Last turn count still "short" (default 3: 1-3 turns). */
  shortMaxTurns: number;
  /** First turn count that is "long" (default 15; 4-14 is "multi"). */
  longMinTurns: number;
  /** Accumulated cacheRead at or above this is "long" (default 1,000,000). */
  longCacheRead: number;
  /** A turn whose peak context reaches this is "heavy". */
  heavyTurnContext: number;
  /** Share of heavy turns at or above this is "long" (default 0.25). */
  heavyTurnShare: number;
}

export const DEFAULT_THRESHOLDS: ComplexityThresholds = {
  shortMaxTurns: 3,
  longMinTurns: 15,
  longCacheRead: 1_000_000,
  heavyTurnContext: 177_047,
  heavyTurnShare: 0.25,
};

export function classifyComplexity(
  stats: TurnStats,
  thresholds: ComplexityThresholds = DEFAULT_THRESHOLDS,
): SessionComplexity {
  const heavy = stats.turnPeaks.filter((p) => p >= thresholds.heavyTurnContext).length;
  if (
    stats.turns >= thresholds.longMinTurns ||
    stats.cacheRead >= thresholds.longCacheRead ||
    (stats.turns > 0 && heavy / stats.turns >= thresholds.heavyTurnShare)
  ) {
    return "long";
  }
  return stats.turns > thresholds.shortMaxTurns ? "multi" : "short";
}
