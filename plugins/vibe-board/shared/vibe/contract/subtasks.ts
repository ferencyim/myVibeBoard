// GENERATED FROM plugins/vibe-shared — DO NOT EDIT (run: node scripts/vibe/sync-shared.mjs)
// Subtasks of a card's plan and their sub-agents (WP-106). Pure rules shared by the daemon (which
// starts sub-agents on the main agent's request), the board UI and the scheduler: is a subtask list
// valid, may a subtask start now, is the card's execution still busy with sub-agents.

import { z } from "zod";
import type { SubtaskStatus } from "./enums";
import type { CardView, Subtask, SubtaskRun } from "./model";
import { findOverlap } from "./overlap";

export const SUBTASK_STATUS_LABELS: Record<SubtaskStatus, string> = {
  pending: "待开始",
  running: "进行中",
  waiting: "提问中",
  done: "完成",
  failed: "失败",
};

/** Statuses in which a sub-agent is working on the subtask. */
export const ACTIVE_SUBTASK_STATUSES: readonly SubtaskStatus[] = ["running", "waiting"];

export const emptyRun = (): SubtaskRun => ({
  status: "pending",
  sessionId: null,
  agentId: null,
  presetId: null,
  summary: "",
  error: "",
  attempts: 0,
  notified: true,
  startedAt: null,
  finishedAt: null,
});

export function runOf(card: Pick<CardView, "subtaskRuns">, subtaskId: string): SubtaskRun {
  return card.subtaskRuns[subtaskId] ?? emptyRun();
}

export const subtasksOf = (card: Pick<CardView, "plan">): Subtask[] => card.plan?.subtasks ?? [];

/** Why a subtask list cannot be stored (unique ids, known dependencies, no cycles), or null. */
export function subtaskListError(subtasks: readonly Subtask[]): string | null {
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

/**
 * Why the subtask may not start now, or null. Refused: unknown subtask, already running, an
 * unfinished dependency, or files overlapping a subtask whose sub-agent is running.
 */
export function subtaskStartBlock(card: Pick<CardView, "plan" | "subtaskRuns">, subtaskId: string): string | null {
  const subtasks = subtasksOf(card);
  const subtask = subtasks.find((s) => s.id === subtaskId);
  if (!subtask) return `方案里没有子任务 ${subtaskId}（现有：${subtasks.map((s) => s.id).join(", ") || "无"}）`;
  const run = runOf(card, subtaskId);
  if (ACTIVE_SUBTASK_STATUSES.includes(run.status)) return `子任务 ${subtaskId} 的子代理已在运行，用 vibe_subtask_message 和它沟通`;
  const unfinished = subtask.dependsOn.filter((dep) => runOf(card, dep).status !== "done");
  if (unfinished.length) return `子任务 ${subtaskId} 依赖的 ${unfinished.join(", ")} 还没有完成`;
  for (const other of subtasks) {
    if (other.id === subtaskId || !ACTIVE_SUBTASK_STATUSES.includes(runOf(card, other.id).status)) continue;
    const overlap = findOverlap(subtask.files, other.files);
    if (overlap) {
      return `子任务 ${subtaskId} 与正在运行的 ${other.id} 涉及相同的文件（${overlap[0]} / ${overlap[1]}），等它结束再启动`;
    }
  }
  return null;
}

/**
 * The card's execution still waits for sub-agents: one is running or asking, or a status change has
 * not reached the main agent yet. While true, the main agent ending a round does not finish the card.
 */
export function subtasksBusy(card: Pick<CardView, "subtaskRuns">): boolean {
  return Object.values(card.subtaskRuns).some(
    (run) => ACTIVE_SUBTASK_STATUSES.includes(run.status) || !run.notified,
  );
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
  if (active.length >= limits.globalLimit) return `已达全局并发上限 ${limits.globalLimit}，等其它代理结束`;
  const providerLimit = limits.providerLimits[provider];
  if (providerLimit !== undefined && active.filter((a) => a.provider === provider).length >= providerLimit) {
    return `${provider} 已达并发上限 ${providerLimit}，等其它代理结束`;
  }
  if (projectLimit != null && active.filter((a) => a.projectId === projectId).length >= projectLimit) {
    return `项目已达并发上限 ${projectLimit}，等其它代理结束`;
  }
  return null;
}

/**
 * Does this session take a concurrency slot? A card's main agent does until it ends (it may be
 * continued at any time); a sub-agent only while it works or asks (idle = its subtask is finished).
 */
export function takesSlot(session: { role: string; state: string }): boolean {
  if (session.role === "worker") return ["starting", "working", "waiting", "idle"].includes(session.state);
  if (session.role === "subagent") return ["starting", "working", "waiting"].includes(session.state);
  return false;
}
