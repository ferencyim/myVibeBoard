// Conversation complexity (WP-83): short / multi / long from effective agent turns and cache reads.
// Pure. A "turn" is one Paseo agent turn (turn_started .. turn_ended) that a plugin did not start
// itself; a turn can contain dozens of model calls (usage_event rows), which count as ONE turn.

import type { SessionComplexity } from "../vibe/contract";
import { DEFAULT_THRESHOLDS, type ComplexityThresholds } from "../../shared/settings/defaults";

export { DEFAULT_THRESHOLDS, type ComplexityThresholds } from "../../shared/settings/defaults";

export interface TurnStats {
  /** Effective agent turns since the last compaction. */
  turns: number;
  /** Summed cacheRead of all model calls since the last compaction. */
  cacheRead: number;
  /** Per turn: the largest context (input + cacheRead + cacheWrite) of any call inside it. */
  turnPeaks: readonly number[];
}



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
