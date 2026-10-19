// Turns providers.listUsage() into per-provider quota levels.

import type { ProviderQuota } from "./select";

export interface UsageWindowLike {
  usedPct?: number | null;
  remainingPct?: number | null;
  resetsAt?: string | null;
}
export interface UsageProviderLike {
  providerId: string;
  status: string;
  windows: readonly UsageWindowLike[];
}

export interface QuotaThresholds {
  tightPct: number;
  exhaustedPct: number;
}

/** Remaining quota of the scarcest window; unavailable providers are "unknown" (never blocked). */
export function normalizeUsage(
  providers: readonly UsageProviderLike[],
  t: QuotaThresholds,
): Record<string, ProviderQuota> {
  const out: Record<string, ProviderQuota> = {};
  for (const p of providers) {
    let remaining: number | null = null;
    let resetsAt: string | null = null;
    if (p.status === "available") {
      for (const w of p.windows) {
        const r = w.remainingPct ?? (w.usedPct != null ? 100 - w.usedPct : null);
        if (r == null) continue;
        if (remaining === null || r < remaining) {
          remaining = r;
          resetsAt = w.resetsAt ?? null;
        }
      }
    }
    out[p.providerId] = {
      remainingPct: remaining,
      level:
        remaining === null
          ? "unknown"
          : remaining <= t.exhaustedPct
            ? "exhausted"
            : remaining <= t.tightPct
              ? "tight"
              : "ok",
      resetsAt,
    };
  }
  return out;
}

/** Preset provider ids may carry a model suffix ("claude/opus"); fall back to the head segment. */
export function quotaFor(
  quota: Readonly<Record<string, ProviderQuota>>,
  provider: string,
): ProviderQuota {
  return quota[provider] ?? quota[provider.split("/")[0]!] ?? { remainingPct: null, level: "unknown" };
}
