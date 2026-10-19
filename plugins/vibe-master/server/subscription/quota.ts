// Provider quota from providers.listUsage(): remaining percent per provider, the level the
// scheduling policy uses (ok / tight / exhausted) and the quota-error classifier.

import type { Clock } from "../clock";
import type { MasterPaseo, UsageProviderLike } from "../types";

export type QuotaLevel = "ok" | "tight" | "exhausted" | "unknown";
export interface ProviderQuota {
  remainingPct: number | null;
  level: QuotaLevel;
  resetsAt: string | null;
}
export type QuotaMap = Record<string, ProviderQuota>;

export const EXHAUSTED_PCT = 2;

export function levelOf(remainingPct: number | null, tightPct: number): QuotaLevel {
  if (remainingPct === null) return "unknown";
  if (remainingPct <= EXHAUSTED_PCT) return "exhausted";
  return remainingPct <= tightPct ? "tight" : "ok";
}

/** The most constrained window decides. */
export function quotaFromUsage(providers: UsageProviderLike[], tightPct: number): QuotaMap {
  const out: QuotaMap = {};
  for (const p of providers) {
    let remaining: number | null = null;
    let resetsAt: string | null = null;
    for (const w of p.windows) {
      const left = w.remainingPct ?? (w.usedPct != null ? 100 - w.usedPct : null);
      if (left == null) continue;
      if (remaining === null || left < remaining) {
        remaining = left;
        resetsAt = w.resetsAt ?? null;
      }
    }
    out[p.providerId.toLowerCase()] = {
      remainingPct: remaining === null ? null : Math.max(0, Math.round(remaining * 10) / 10),
      level: levelOf(remaining, tightPct),
      resetsAt,
    };
  }
  return out;
}

const QUOTA_ERROR =
  /(quota|rate[\s_-]?limit|usage[\s_-]?limit|limit (reached|exceeded)|credit|billing|insufficient|exceeded your|too many requests|\b429\b|overloaded|resets? (at|in|on))/i;

export const isQuotaError = (message: string | null | undefined): boolean =>
  !!message && QUOTA_ERROR.test(message);

export interface QuotaReader {
  get(): Promise<QuotaMap>;
  /** Drop the cache (a scheduler signal says the numbers changed). */
  invalidate(): void;
}

/** Cached reader; an unreachable usage endpoint yields an empty map (levels become unknown). */
export function createQuotaReader(options: {
  getPaseo: () => Pick<MasterPaseo, "providers"> | null;
  tightPct: () => number;
  clock: Clock;
  ttlMs?: number;
}): QuotaReader {
  let cache: { at: number; value: QuotaMap } | null = null;
  const ttl = options.ttlMs ?? 60_000;
  return {
    invalidate() {
      cache = null;
    },
    async get() {
      if (cache && options.clock.now() - cache.at < ttl) return cache.value;
      const paseo = options.getPaseo();
      if (!paseo) return cache?.value ?? {};
      try {
        const usage = await paseo.providers.listUsage();
        cache = { at: options.clock.now(), value: quotaFromUsage(usage.providers, options.tightPct()) };
        return cache.value;
      } catch {
        return cache?.value ?? {};
      }
    },
  };
}
