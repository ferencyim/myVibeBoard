// Defaults shared by the server and the settings screen. Must stay free of server-only imports:
// the plugin client bundle may not import anything under server/.

/** Providers whose CLI understands `/compact`. Everything else is handed over instead. */
export const COMPACT_PROVIDERS: readonly string[] = ["claude", "codex"];

/** Default cache TTLs (seconds) per provider; users override them in the plugin settings. */
export const DEFAULT_TTL_SECONDS: Record<string, number> = { claude: 3600, codex: 300 };
export const FALLBACK_TTL_SECONDS = 300;

/** TTL at or above `longFrom` opens the window `long` seconds before expiry, shorter ones `short` (never over half). */
export interface MarginRule {
  longFrom: number;
  long: number;
  short: number;
}
export const DEFAULT_MARGIN_RULE: MarginRule = { longFrom: 3600, long: 180, short: 60 };

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
