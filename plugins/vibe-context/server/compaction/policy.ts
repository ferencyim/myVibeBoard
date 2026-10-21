// Pure trigger rules for pre-expiry compaction (WP-35). Time only: no context-size input.

import { COMPACT_PROVIDERS, DEFAULT_MARGIN_RULE, type MarginRule } from "../../shared/settings/defaults";

export {
  COMPACT_PROVIDERS,
  DEFAULT_MARGIN_RULE,
  DEFAULT_TTL_SECONDS,
  FALLBACK_TTL_SECONDS,
  type MarginRule,
} from "../../shared/settings/defaults";


/** "claude/sonnet" -> "claude". */
export const baseProvider = (provider: string): string => provider.split("/")[0].toLowerCase();

export const supportsCompact = (provider: string, providers: readonly string[] = COMPACT_PROVIDERS): boolean =>
  providers.includes(baseProvider(provider));



/** How long before expiry the window opens: 3 min for a 1 h TTL, 1 min for 5 min (never over half). */
export function marginSeconds(ttlSeconds: number, rule: MarginRule = DEFAULT_MARGIN_RULE): number {
  return Math.min(ttlSeconds >= rule.longFrom ? rule.long : rule.short, ttlSeconds / 2);
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
