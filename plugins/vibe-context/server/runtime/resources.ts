import { randomUUID } from "node:crypto";
import type { AgentSession, EventPayload } from "../vibe/contract";
import { createEventConsumer, publishEvent, type VibeDb, type VibeStore } from "../vibe/db";
type Result = EventPayload<"scheduler.task_resource_result">;
interface TurnResult {
  status: "idle" | "error" | "permission" | "timeout";
}
/** Compaction turns use the same admission path as the task's ordinary native turns. */
export function createContextResources(options: {
  db: VibeDb;
  store: VibeStore;
  report(session: AgentSession, text: string): Promise<void>;
  timeoutMs?: number;
}) {
  const pending = new Map<
    string,
    { resolve(result: Result): void; timer: ReturnType<typeof setTimeout> }
  >();
  let stopped = false;
  const consumer = createEventConsumer({
    db: options.db,
    consumer: "vibe-context:resources",
    types: ["scheduler.task_resource_result"],
    startAt: "now",
    handler: (event) => {
      const result = event.payload as Result;
      const waiter = pending.get(result.requestId);
      if (waiter) {
        clearTimeout(waiter.timer);
        pending.delete(result.requestId);
        waiter.resolve(result);
      }
    },
  });
  consumer.start();
  const request = (
    workspaceId: string,
    action: "acquire" | "bind" | "yield" | "freeze",
    extra: Omit<
      EventPayload<"scheduler.task_resource_request">,
      "requestId" | "workspaceId" | "action"
    > = {},
  ): Promise<Result> => {
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        resolve({
          requestId,
          workspaceId,
          ok: false,
          reason: "调度回执不明，保留资源并暂停上下文处理",
        });
      }, options.timeoutMs ?? 10000);
      pending.set(requestId, { resolve, timer });
      publishEvent(options.db, {
        type: "scheduler.task_resource_request",
        payload: { requestId, workspaceId, action, ...extra },
      });
    });
  };
  const current = (session: AgentSession, workspaceId: string) => {
    if (stopped) return false;
    if (session.role === "master") return true;
    const task = options.store.tasks.get(workspaceId);
    return (
      !!task &&
      task.confirmedAt === (session.confirmedAt ?? null) &&
      ["planning", "awaiting_confirmation", "executing", "reviewing", "verifying"].includes(
        task.phase,
      )
    );
  };
  const freeze = async (session: AgentSession, workspaceId: string, reason: string) => {
    publishEvent(options.db, {
      type: "scheduler.task_resource_request",
      payload: { requestId: randomUUID(), workspaceId, action: "freeze", agentId: session.agentId },
    });
    await options.report(session, reason);
  };
  return {
    async run(
      session: AgentSession,
      workspaceId: string | null,
      turn: () => Promise<TurnResult>,
    ): Promise<TurnResult> {
      if (
        !workspaceId ||
        !current(session, workspaceId) ||
        session.candidateIndex == null ||
        !session.model
      )
        return { status: "permission" };
      const task = options.store.tasks.get(workspaceId);
      const subtaskId = task?.subtaskRuns.find((run) => run.agentId === session.agentId)?.subtaskId;
      const acquired = await request(workspaceId, "acquire", {
        role: session.role,
        candidateIndex: session.candidateIndex,
        provider: session.currentProvider,
        model: session.model,
        ...(subtaskId ? { subtaskId } : {}),
      });
      if (!acquired.ok) {
        if (acquired.reason.includes("回执不明"))
          await freeze(session, workspaceId, acquired.reason);
        return { status: "permission" };
      }
      if (
        !current(session, workspaceId) ||
        !acquired.reservationId ||
        acquired.provider !== session.currentProvider ||
        acquired.model !== session.model
      ) {
        await freeze(session, workspaceId, "确认或实际模型发生变化，暂停上下文处理并保留资源");
        return { status: "permission" };
      }
      const reservationId = acquired.reservationId;
      const bound = await request(workspaceId, "bind", { reservationId, agentId: session.agentId });
      if (!bound.ok || !current(session, workspaceId)) {
        await freeze(session, workspaceId, bound.reason || "任务已停止");
        return { status: "permission" };
      }
      const result = await turn();
      if (result.status === "idle") {
        const yielded = await request(workspaceId, "yield", {
          reservationId,
          agentId: session.agentId,
        });
        if (!yielded.ok) await freeze(session, workspaceId, yielded.reason);
      }
      return result;
    },
    poll: consumer.poll,
    async close() {
      stopped = true;
      await consumer.stop();
      for (const [requestId, waiter] of pending) {
        clearTimeout(waiter.timer);
        waiter.resolve({
          requestId,
          workspaceId: "",
          ok: false,
          reason: "上下文插件已停止，资源待恢复核对",
        });
      }
      pending.clear();
    },
  };
}
