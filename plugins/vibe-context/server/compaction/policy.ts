// Pure trigger rules for pre-expiry compaction (WP-35). Time only: no context-size input.

/** Providers whose CLI understands `/compact`. Everything else is handed over instead. */
export const COMPACT_PROVIDERS: readonly string[] = ["claude", "codex"];

/** "claude/sonnet" -> "claude". */
export const baseProvider = (provider: string): string => provider.split("/")[0].toLowerCase();

export const supportsCompact = (provider: string): boolean =>
  COMPACT_PROVIDERS.includes(baseProvider(provider));

/** Default cache TTLs (seconds) per provider; users override them in the plugin settings. */
export const DEFAULT_TTL_SECONDS: Record<string, number> = { claude: 3600, codex: 300 };
export const FALLBACK_TTL_SECONDS = 300;

/** How long before expiry the window opens: 3 min for a 1 h TTL, 1 min for 5 min (never over half). */
export function marginSeconds(ttlSeconds: number): number {
  return Math.min(ttlSeconds >= 3600 ? 180 : 60, ttlSeconds / 2);
}

export type SkipReason =
  | "not-idle" // working / waiting for approval / starting / ended / error
  | "no-expiry"
  | "cache-cold" // already expired: compacting would save nothing
  | "cache-hot" // more than the margin left
  | "already-compacted"; // this idle period was handled

export interface WindowInput {
  state: string;
  cacheExpiresAtMs: number | null;
  nowMs: number;
  marginMs: number;
  alreadyCompacted: boolean;
  /** Long conversation (WP-83): compact at this idle moment whatever the cache state. */
  force?: boolean;
}

/** `null` means: compact now. */
export function skipReason(i: WindowInput): SkipReason | null {
  if (i.state !== "idle") return "not-idle";
  if (i.alreadyCompacted) return "already-compacted";
  if (i.force) return null;
  if (i.cacheExpiresAtMs === null) return "no-expiry";
  const left = i.cacheExpiresAtMs - i.nowMs;
  if (left <= 0) return "cache-cold";
  if (left > i.marginMs) return "cache-hot";
  return null;
}
