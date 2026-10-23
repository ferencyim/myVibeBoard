import type { AgentSession, TaskPresetSnapshot } from "../vibe/contract";
import { classifyFailure, type FailureCategory } from "../vibe/contract/error-class";
import type { TaskRuntimeCommands, VibeStore } from "../vibe/db";
import { defaultPrompts, type PromptResolver } from "../prompts";

export interface ActualModel {
  provider: string;
  model: string;
  thinking?: string;
}
export interface ContinuationSelection {
  candidateIndex: number;
  actualModel: ActualModel;
}
export type StartAttempt =
  | { status: "started"; agentId: string; actualModel: ActualModel }
  | { status: "deferred"; reason: string }
  | { status: "failed"; message: string; stopped: boolean };
export interface ContinuationHost {
  /** true means the old native agent has definitively stopped; unknown must return false. */
  stop(agentId: string): Promise<boolean>;
  /** The orchestration owner must acquire scheduler resources and retain this workspace/worktree. */
  start(input: {
    session: AgentSession;
    preset: TaskPresetSnapshot;
    candidate: TaskPresetSnapshot["models"][number];
    candidateIndex: number;
    prompt: string;
  }): Promise<StartAttempt>;
}
export interface ContinuationOptions {
  store: Pick<VibeStore, "sessions">;
  runtime: Pick<TaskRuntimeCommands, "recordContinuation" | "getContinuation" | "getSelection">;
  host: ContinuationHost;
  /** Must persist selection through the shared command layer, before admitting a further turn. */
  selected?(session: AgentSession, selection: ContinuationSelection, previous: AgentSession): void;
  report(session: AgentSession, text: string): void | Promise<void>;
  prompts?: PromptResolver;
}
export type ContinuationResult =
  | { status: "continued"; session: AgentSession; candidateIndex: number }
  | { status: "ignored" | "paused" | "exhausted" | "deferred"; reason: string };

/** Generic subprocess exits and tool/test errors do not prove a provider failure. */
export function continuationFailure(message: string, code?: string): FailureCategory {
  const category = classifyFailure(message, code);
  if (category !== "unavailable") return category;
  return /provider[^.\n]{0,40}(?:unavailable|not (?:installed|available|found)|disabled)|service unavailable|temporarily unavailable|overloaded|rate[_ ]limit|\b(?:429|502|503|504|529)\b|econnrefused|econnreset|etimedout|network error|socket hang up|stream disconnected/i.test(
    code ? code + " " + message : message,
  )
    ? "unavailable"
    : "other";
}

/** Same controller applies to all seven task roles and the separately configured master. */
const validSelection = (
  selection: ContinuationSelection | undefined,
  count: number,
): selection is ContinuationSelection =>
  !!selection &&
  Number.isInteger(selection.candidateIndex) &&
  selection.candidateIndex >= 0 &&
  selection.candidateIndex < count;

export function createTaskContinuation(options: ContinuationOptions) {
  const inflight = new Map<string, Promise<ContinuationResult>>();
  async function run(
    sessionId: string,
    input: { preset: TaskPresetSnapshot; message: string; code?: string; summary: string },
  ): Promise<ContinuationResult> {
    const replacement = options.runtime.getContinuation(sessionId);
    if (replacement)
      return {
        status: "continued",
        session: replacement,
        candidateIndex: replacement.candidateIndex ?? 0,
      };
    const session = options.store.sessions.get(sessionId);
    if (!session || session.state === "ended") return { status: "ignored", reason: "会话已结束" };
    if (continuationFailure(input.message, input.code) === "other")
      return { status: "ignored", reason: "普通任务失败不自动轮换模型" };
    const selection = options.runtime.getSelection(session.id);
    if (!validSelection(selection, input.preset.models.length)) {
      const reason = "缺少可靠的实际模型选择，已停止自动接续";
      await options.report(session, reason);
      return { status: "paused", reason };
    }
    let stopped = false;
    try {
      stopped = await options.host.stop(session.agentId);
    } catch {
      /* Missing cancellation receipt is unsafe to continue. */
    }
    if (!stopped) {
      const reason = "旧会话停止结果不明，保留资源并暂停接续";
      await options.report(session, reason);
      return { status: "paused", reason };
    }
    const prompt = (options.prompts ?? defaultPrompts).resolve("context.failure_handoff", {
      projectId: session.projectId,
      vars: {
        workspaceId: session.workspaceId ?? "总 agent",
        role: session.role,
        oldAgentId: session.agentId,
        summary: input.summary,
      },
    });
    for (let index = selection.candidateIndex + 1; index < input.preset.models.length; index++) {
      let attempt: StartAttempt;
      try {
        attempt = await options.host.start({
          session,
          preset: input.preset,
          candidate: input.preset.models[index]!,
          candidateIndex: index,
          prompt,
        });
      } catch {
        const reason = "候选启动结果不明，保留资源并暂停接续";
        await options.report(session, reason);
        return { status: "paused", reason };
      }
      if (attempt.status === "deferred") return { status: "deferred", reason: attempt.reason };
      if (attempt.status === "failed") {
        if (!attempt.stopped || continuationFailure(attempt.message) === "other") {
          const reason = attempt.stopped
            ? "候选出现普通任务失败，暂停轮换"
            : "候选停止结果不明，保留资源并暂停接续";
          await options.report(session, reason);
          return { status: "paused", reason };
        }
        continue;
      }
      const { to } = options.runtime.recordContinuation({
        fromSessionId: session.id,
        agentId: attempt.agentId,
        provider: attempt.actualModel.provider,
        model: attempt.actualModel.model,
        thinking: attempt.actualModel.thinking,
        candidateIndex: index,
        reason: input.message,
      });
      options.selected?.(to, { candidateIndex: index, actualModel: attempt.actualModel }, session);
      await options.report(
        to,
        "模型已按预设顺序接续：" + attempt.actualModel.provider + "/" + attempt.actualModel.model,
      );
      return { status: "continued", session: to, candidateIndex: index };
    }
    const reason = "预设候选模型已耗尽，任务暂停，等待用户处理";
    await options.report(session, reason);
    return { status: "exhausted", reason };
  }
  return {
    continue(sessionId: string, input: Parameters<typeof run>[1]): Promise<ContinuationResult> {
      const current = inflight.get(sessionId);
      if (current) return current;
      const operation = run(sessionId, input).finally(() => inflight.delete(sessionId));
      inflight.set(sessionId, operation);
      return operation;
    },
  };
}
