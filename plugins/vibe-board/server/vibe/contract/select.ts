// GENERATED FROM plugins/vibe-shared — DO NOT EDIT (run: node scripts/vibe/sync-shared.mjs)
// Sub-agent selection (IMPLEMENTATION-PLAN M4): a pure function so the master agent (WP-32), the
// scheduler and tests all call the same code. No I/O, no clock: everything arrives in the input.
//
// Inputs: remaining quota per provider, machine pressure, free devices, the capability table and
// each agent's track record (from .vibe/workers/<agent>/MEMORY.md) and what the task needs.
// A user pre-selection always wins.

export const PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 } as const;
export type Priority = keyof typeof PRIORITY_RANK;

export type QuotaLevel = "ok" | "tight" | "exhausted" | "unknown";

export interface ProviderQuota {
  /** 0-100, null when the provider reports no usable window. */
  remainingPct: number | null;
  level: QuotaLevel;
  resetsAt?: string | null;
}

/** Capability table entry. `tier` 1 = cheap/fast, 3 = strongest. */
export interface AgentProfile {
  id: string;
  provider: string;
  tier: 1 | 2 | 3;
  /** Tags / platforms this agent is good at (matched case-insensitively). */
  strengths: string[];
  /** When set, the agent can only take tasks for these platforms. */
  platforms?: string[];
  presetId?: string | null;
}

export type TaskSize = "S" | "M" | "L" | "XL";

export interface TaskNeeds {
  tags: string[];
  size?: TaskSize;
  /** Project type: android, ios, web, desktop, backend, embedded, other. */
  platform?: string;
  priority: Priority;
  /** Device kind the task needs exclusively (emulator, simulator, board...). */
  device?: string | null;
  /** Agent id the user picked; wins over everything. */
  preselected?: string | null;
}

export interface SelectContext {
  quota: Record<string, ProviderQuota>;
  /** Free devices per kind (only consulted when the task needs one). */
  devicesFree?: Record<string, number>;
  memoryPaused?: boolean;
  /** Per agent id: tag (lower case) or "*" -> score in [-1, 1] from MEMORY.md. */
  history?: Record<string, Record<string, number>>;
  /** Running sessions per provider. */
  running?: Record<string, number>;
  /** Cards below this priority must not use a tight provider. Default "high". */
  tightMinPriority?: Priority;
}

export interface Ranked {
  agentId: string;
  score: number;
  reasons: string[];
}

export interface Selection {
  agentId: string | null;
  reason: string;
  ranked: Ranked[];
  excluded: Array<{ agentId: string; why: string }>;
  warnings: string[];
  /** Set when nothing should start now: wait for the reset / a free device / memory. */
  wait: { until: string | null; reason: string } | null;
}

const lower = (xs: readonly string[]) => xs.map((x) => x.toLowerCase());

export function neededTier(task: Pick<TaskNeeds, "size" | "priority">): 1 | 2 | 3 {
  const base = task.size === "L" || task.size === "XL" ? 3 : task.size === "M" ? 2 : 1;
  const bump = task.priority === "urgent" || task.priority === "high" ? 1 : 0;
  return Math.min(3, base + bump) as 1 | 2 | 3;
}

export function selectAgent(
  profiles: readonly AgentProfile[],
  task: TaskNeeds,
  ctx: SelectContext,
): Selection {
  const warnings: string[] = [];
  const excluded: Selection["excluded"] = [];
  const quotaOf = (p: AgentProfile): ProviderQuota =>
    ctx.quota[p.provider] ?? { remainingPct: null, level: "unknown" };

  const empty = (reason: string, wait: Selection["wait"] = null): Selection => ({
    agentId: null,
    reason,
    ranked: [],
    excluded,
    warnings,
    wait,
  });

  if (task.preselected) {
    const picked = profiles.find((p) => p.id === task.preselected);
    if (!picked)
      return empty(`Pre-selected agent ${task.preselected} is not in the capability table`);
    const q = quotaOf(picked);
    if (q.level === "exhausted") warnings.push(`${picked.provider} quota is exhausted`);
    else if (q.level === "tight") warnings.push(`${picked.provider} quota is tight`);
    return {
      agentId: picked.id,
      reason: "Pre-selected by the user",
      ranked: [{ agentId: picked.id, score: Infinity, reasons: ["user pre-selected"] }],
      excluded,
      warnings,
      wait: null,
    };
  }

  if (task.device && (ctx.devicesFree?.[task.device] ?? Infinity) <= 0) {
    return empty(`No free ${task.device}`, {
      until: null,
      reason: `all ${task.device} devices are leased`,
    });
  }
  if (ctx.memoryPaused) {
    return empty("Memory above threshold", { until: null, reason: "memory pressure" });
  }

  const minRank = PRIORITY_RANK[ctx.tightMinPriority ?? "high"];
  const rank = PRIORITY_RANK[task.priority];
  const tags = lower(task.tags);
  const platform = task.platform?.toLowerCase();
  const need = neededTier(task);

  const ranked: Ranked[] = [];
  let blockedByQuotaUntil: string | null | undefined;
  for (const p of profiles) {
    const q = quotaOf(p);
    if (platform && p.platforms && !lower(p.platforms).includes(platform)) {
      excluded.push({ agentId: p.id, why: `does not cover platform ${platform}` });
      continue;
    }
    if (q.level === "exhausted") {
      excluded.push({ agentId: p.id, why: `${p.provider} quota exhausted` });
      blockedByQuotaUntil = pickEarlier(blockedByQuotaUntil, q.resetsAt ?? null);
      continue;
    }
    if (q.level === "tight" && rank > minRank) {
      excluded.push({
        agentId: p.id,
        why: `${p.provider} quota tight, reserved for ${ctx.tightMinPriority ?? "high"}+ priority`,
      });
      blockedByQuotaUntil = pickEarlier(blockedByQuotaUntil, q.resetsAt ?? null);
      continue;
    }

    const reasons: string[] = [];
    let score = 0;
    const strengths = lower(p.strengths);
    const matched = [...tags, ...(platform ? [platform] : [])].filter((t) => strengths.includes(t));
    if (matched.length) {
      score += 10 * matched.length;
      reasons.push(`strong at ${matched.join(", ")}`);
    }
    const gap = p.tier - need;
    // Under-powered is worse than over-powered; over-powered only costs quota.
    const fit = gap < 0 ? 12 * gap : -3 * gap;
    score += fit;
    reasons.push(
      gap === 0
        ? "tier fits the task"
        : gap < 0
          ? `tier ${p.tier} below needed ${need}`
          : `tier ${p.tier} above needed ${need}`,
    );

    if (q.remainingPct != null) {
      score += q.remainingPct / 10;
      reasons.push(`${Math.round(q.remainingPct)}% quota left`);
    }
    // A tight provider is kept for important work: the cheaper alternatives win for the rest.
    if (q.level === "tight") {
      score -= 4;
      reasons.push("quota tight");
    }
    const hist = ctx.history?.[p.id];
    if (hist) {
      const scores = [...tags, ...(platform ? [platform] : [])]
        .map((t) => hist[t])
        .filter((x): x is number => typeof x === "number");
      const h = scores.length
        ? scores.reduce((a, b) => a + b, 0) / scores.length
        : (hist["*"] ?? 0);
      if (h !== 0) {
        score += 10 * h;
        reasons.push(`track record ${h > 0 ? "+" : ""}${h.toFixed(2)}`);
      }
    }
    const load = ctx.running?.[p.provider] ?? 0;
    if (load) {
      score -= 2 * load;
      reasons.push(`${load} running`);
    }
    ranked.push({ agentId: p.id, score: Math.round(score * 100) / 100, reasons });
  }

  ranked.sort((a, b) => b.score - a.score || a.agentId.localeCompare(b.agentId));
  const best = ranked[0];
  if (!best) {
    return {
      agentId: null,
      reason: "No agent available",
      ranked,
      excluded,
      warnings,
      wait:
        blockedByQuotaUntil !== undefined
          ? { until: blockedByQuotaUntil, reason: "waiting for quota reset" }
          : null,
    };
  }
  return {
    agentId: best.agentId,
    reason: best.reasons.join("; "),
    ranked,
    excluded,
    warnings,
    wait: null,
  };
}

function pickEarlier(a: string | null | undefined, b: string | null): string | null {
  if (a === undefined) return b;
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}

/** Tier given to a provider nobody described: neither cheap nor strongest. */
export const NEUTRAL_TIER = 2;

/**
 * Capability table derived from the providers that actually exist (usage catalog, presets, ...):
 * every provider id gets one neutral profile (id = provider, tier 2, no declared strengths), so any
 * Paseo provider - built in or from a plugin - is selectable without code changes. Settings entries
 * (`agentProfiles`) replace the profile with the same id or add new ones (several agents per provider).
 */
export function mergeProfiles(
  extra: readonly AgentProfile[],
  providerIds: Iterable<string> = [],
): AgentProfile[] {
  const byId = new Map<string, AgentProfile>();
  for (const id of providerIds) {
    if (id && !byId.has(id)) byId.set(id, { id, provider: id, tier: NEUTRAL_TIER, strengths: [] });
  }
  for (const p of extra) byId.set(p.id, p);
  return [...byId.values()];
}

// --- MEMORY.md track record ---------------------------------------------------------------

const POSITIVE = /(✓|✅|\bsuccess|\bpassed|\bgood\b|通过|成功|擅长)/i;
const NEGATIVE = /(✗|❌|\bfail|\brejected|\bbad\b|驳回|失败|不擅长)/i;

/**
 * Turns a worker MEMORY.md into per-tag scores: every bullet line with a positive or negative
 * marker counts for each `#tag` on it (and for "*"). score = (pos - neg) / (pos + neg + 2).
 */
export function parseWorkerHistory(markdown: string): Record<string, number> {
  const counts = new Map<string, { pos: number; neg: number }>();
  const bump = (key: string, field: "pos" | "neg") => {
    const c = counts.get(key) ?? { pos: 0, neg: 0 };
    c[field]++;
    counts.set(key, c);
  };
  for (const line of markdown.split(/\r?\n/)) {
    if (!/^\s*([-*]|\d+\.)\s/.test(line)) continue;
    const neg = NEGATIVE.test(line);
    const pos = !neg && POSITIVE.test(line);
    if (!neg && !pos) continue;
    const field = neg ? "neg" : "pos";
    bump("*", field);
    for (const m of line.matchAll(/#([\p{L}\p{N}_-]+)/gu)) bump(m[1]!.toLowerCase(), field);
  }
  const out: Record<string, number> = {};
  for (const [k, c] of counts) out[k] = (c.pos - c.neg) / (c.pos + c.neg + 2);
  return out;
}
