// Conversation complexity (WP-83): short / multi / long from effective turns and cache reads.
// Pure. One "turn" is one model round as logged in usage_event (one API call), so long agentic
// turns count several times; the thresholds are settings for that reason.

import type { SessionComplexity } from "../vibe/contract";

export interface TurnUsage {
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ComplexityThresholds {
  /** Last turn count still "short" (default 3: 1-3 turns). */
  shortMaxTurns: number;
  /** First turn count that is "long" (default 15; 4-14 is "multi"). */
  longMinTurns: number;
  /** Accumulated cacheRead at or above this is "long" (default 1,000,000). */
  longCacheRead: number;
  /** A turn whose context (input + cache read + cache write) reaches this is "heavy". */
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

export const turnContext = (t: TurnUsage): number => t.tokensIn + t.cacheRead + t.cacheWrite;

/** Turns that did something (an all-zero usage row is noise). */
export const effectiveTurns = (turns: readonly TurnUsage[]): TurnUsage[] =>
  turns.filter((t) => t.tokensIn + t.tokensOut + t.cacheRead + t.cacheWrite > 0);

export function classifyComplexity(
  all: readonly TurnUsage[],
  thresholds: ComplexityThresholds = DEFAULT_THRESHOLDS,
): SessionComplexity {
  const turns = effectiveTurns(all);
  if (turns.length === 0) return "short";
  const cacheRead = turns.reduce((sum, t) => sum + t.cacheRead, 0);
  const heavy = turns.filter((t) => turnContext(t) >= thresholds.heavyTurnContext).length;
  if (
    turns.length >= thresholds.longMinTurns ||
    cacheRead >= thresholds.longCacheRead ||
    heavy / turns.length >= thresholds.heavyTurnShare
  ) {
    return "long";
  }
  return turns.length > thresholds.shortMaxTurns ? "multi" : "short";
}
