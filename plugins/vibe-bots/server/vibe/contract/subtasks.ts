// GENERATED FROM plugins/vibe-shared — DO NOT EDIT (run: node scripts/vibe/sync-shared.mjs)
import { z } from "zod";

export function subtaskListError(
  subtasks: readonly { id: string; dependsOn: readonly string[] }[],
): string | null {
  const ids = new Set<string>();
  for (const s of subtasks) {
    if (ids.has(s.id)) return `子任务编号重复：${s.id}`;
    ids.add(s.id);
  }
  for (const s of subtasks) {
    for (const dep of s.dependsOn) {
      if (dep === s.id) return `子任务 ${s.id} 不能依赖自己`;
      if (!ids.has(dep)) return `子任务 ${s.id} 依赖的 ${dep} 不存在`;
    }
  }
  const byId = new Map(subtasks.map((s) => [s.id, s]));
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string): string | null => {
    if (state.get(id) === "done") return null;
    if (state.get(id) === "visiting") return `子任务依赖成环（经过 ${id}）`;
    state.set(id, "visiting");
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      const error = visit(dep);
      if (error) return error;
    }
    state.set(id, "done");
    return null;
  };
  for (const s of subtasks) {
    const error = visit(s.id);
    if (error) return error;
  }
  return null;
}

// --- concurrency (the scheduler's limits, published for the board) ---------------------------

/** vibe_meta key under which vibe-scheduler publishes its limits (JSON, SchedulerLimits). */
export const SCHEDULER_LIMITS_KEY = "scheduler.limits";

export const SchedulerLimitsSchema = z.object({
  globalLimit: z.number().int().min(1),
  providerLimits: z.record(z.string(), z.number().int().min(0)),
});
export type SchedulerLimits = z.infer<typeof SchedulerLimitsSchema>;

/** Same as vibe-scheduler's DEFAULT_CONFIG; used until the scheduler published its settings. */
export const DEFAULT_SCHEDULER_LIMITS: SchedulerLimits = { globalLimit: 4, providerLimits: {} };

/** A running executor (worker or sub-agent) as the concurrency check counts it. */
export interface ActiveAgent {
  provider: string;
  projectId: string | null;
}

/** Why one more agent on `provider` in `projectId` would exceed a limit, or null. */
export function concurrencyBlock(input: {
  limits: SchedulerLimits;
  active: readonly ActiveAgent[];
  provider: string;
  projectId: string;
  projectLimit: number | null;
}): string | null {
  const { limits, active, provider, projectId, projectLimit } = input;
  if (active.length >= limits.globalLimit)
    return `已达全局并发上限 ${limits.globalLimit}，等其它代理结束`;
  const providerLimit = limits.providerLimits[provider];
  if (
    providerLimit !== undefined &&
    active.filter((a) => a.provider === provider).length >= providerLimit
  ) {
    return `${provider} 已达并发上限 ${providerLimit}，等其它代理结束`;
  }
  if (
    projectLimit != null &&
    active.filter((a) => a.projectId === projectId).length >= projectLimit
  ) {
    return `项目已达并发上限 ${projectLimit}，等其它代理结束`;
  }
  return null;
}

/**
 * Does this session take a concurrency slot? A card's main agent does until it ends (it may be
 * continued at any time); a sub-agent only while it works or asks (idle = its subtask is finished).
 */
export function takesSlot(session: { role: string; state: string }): boolean {
  if (session.role === "worker")
    return ["starting", "working", "waiting", "idle"].includes(session.state);
  if (session.role === "subagent")
    return ["starting", "working", "waiting"].includes(session.state);
  return false;
}
