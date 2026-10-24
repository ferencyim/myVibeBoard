import { z } from "zod";
import { parseReply } from "../assess/parse";
import { buildRepairMessage } from "../master/prompts";
import type { PromptPort } from "../prompts/port";
import { defaultPromptPort } from "../prompts/port";
import type { TuningSource } from "../tuning";
import { defaultTuning } from "../tuning";
import type { MasterAsk } from "../types";
import { MasterError } from "../types";
import type { Task } from "../vibe/contract";
import type { VibeDb, VibeStore } from "../vibe/db";
import { publishEvent } from "../vibe/db";

export interface DispatcherDeps {
  db: VibeDb;
  store: VibeStore;
  master: MasterAsk;
  /** Runs `fn` between the master's other jobs (the master has one conversation). */
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
  prompts?: PromptPort;
  tuning?: TuningSource;
  /** Owner switches: the master is enabled and master dispatch is on. */
  enabled(): boolean;
  /** Seconds one question may take (settings). */
  timeoutSeconds(): number;
  now?: () => Date;
  log?: (message: string, error?: unknown) => void;
}

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const FAILURE_TEXT: Record<string, string> = {
  unavailable: "总 agent 暂不可用",
  quota: "总 agent 的额度已用完",
  timeout: "总 agent 没有及时回复",
  permission: "总 agent 在等待权限批准",
  agent: "总 agent 出错",
};

export function failureReason(error: unknown): string {
  if (error instanceof MasterError) {
    return `${FAILURE_TEXT[error.kind] ?? "总 agent 出错"}：${clip(error.message, 160)}`;
  }
  return `总 agent 出错：${clip(error instanceof Error ? error.message : String(error), 160)}`;
}

export interface TaskDispatchRequest {
  requestId: string;
  slots: number;
  workspaceIds: string[];
}
const Reply = z.object({ order: z.array(z.string()), reason: z.string().default("") });
const eligible = (task: Task | undefined): task is Task =>
  !!task && task.phase === "queued" && !!task.confirmedAt && !!task.plan && !!task.rolesSnapshot;

/** Suggestions only. Admission, leases and the final snapshot check belong to the scheduler. */
export function createTaskDispatcher(deps: DispatcherDeps) {
  const prompts = deps.prompts ?? defaultPromptPort();
  const tuning = deps.tuning ?? defaultTuning;
  const pending = new Map<string, Promise<void>>();
  function answer(
    request: TaskDispatchRequest,
    kind: "chosen" | "failed",
    payload: Record<string, unknown>,
  ) {
    publishEvent(
      deps.db,
      {
        type: kind === "chosen" ? "master.task_dispatch_chosen" : "master.task_dispatch_failed",
        payload: { requestId: request.requestId, ...payload },
        dedupeKey: "task_dispatch_" + kind + ":" + request.requestId,
      } as never,
      deps.now,
    );
  }
  async function pick(request: TaskDispatchRequest): Promise<void> {
    try {
      if (!deps.enabled()) throw new MasterError("unavailable", "总 agent 派发已关闭或已停用");
      if (!Number.isInteger(request.slots) || request.slots < 1)
        throw new Error("没有可用调度名额");
      const tasks = [...new Set(request.workspaceIds)]
        .map((id) => deps.store.tasks.get(id))
        .filter(eligible);
      if (!tasks.length) throw new Error("候选任务已不在已确认排队状态");
      const timeoutMs = deps.timeoutSeconds() * 1000;
      const picked = await deps.exclusive(async () => {
        // A queued request may wait behind memory consolidation. Recheck before asking the model.
        if (!deps.enabled()) throw new MasterError("unavailable", "总 agent 派发已关闭或已停用");
        const prompt = prompts.resolve("master.task_dispatch", {
          vars: {
            slots: String(request.slots),
            candidates: tasks
              .map((task) =>
                [
                  "- workspace " + task.workspaceId + "；确认时间 " + task.confirmedAt,
                  "  目标：" + task.plan!.goal,
                  "  做法：" + task.plan!.approach,
                  "  文件：" + (task.plan!.files.join("、") || "（范围未知，调度器按仓库排他）"),
                ].join("\n"),
              )
              .join("\n"),
          },
        });
        let reply = await deps.master.ask(prompt, { timeoutMs });
        for (let attempt = 0; ; attempt++) {
          const parsed = parseReply(reply, Reply);
          if (parsed.ok) return parsed.value;
          if (attempt >= tuning().jsonRepairRetries)
            throw new MasterError("agent", "回复格式不对：" + parsed.error);
          reply = await deps.master.ask(
            buildRepairMessage("task_dispatch", parsed.error, prompts),
            { timeoutMs },
          );
        }
      });
      if (!deps.enabled()) throw new MasterError("unavailable", "总 agent 派发已关闭或已停用");
      const offered = new Map(tasks.map((task) => [task.workspaceId, task.confirmedAt]));
      const chosen = [...new Set(picked.order)]
        .filter((id) => {
          const current = deps.store.tasks.get(id);
          return offered.has(id) && eligible(current) && current.confirmedAt === offered.get(id);
        })
        .slice(0, request.slots);
      if (!chosen.length) throw new Error("总 agent 未选出仍有效的候选任务");
      answer(request, "chosen", { workspaceIds: chosen, reason: picked.reason.slice(0, 300) });
    } catch (error) {
      answer(request, "failed", { reason: failureReason(error) });
    }
  }
  return {
    handle(request: TaskDispatchRequest): Promise<void> {
      const active = pending.get(request.requestId);
      if (active) return active;
      const result = pick(request).finally(() => pending.delete(request.requestId));
      pending.set(request.requestId, result);
      return result;
    },
  };
}
