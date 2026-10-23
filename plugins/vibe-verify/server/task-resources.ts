import { randomUUID } from "node:crypto";
import { createEventConsumer, publishEvent, type VibeDb } from "./vibe/db";
import type { TaskResourceLease } from "./task-pipeline";

interface Result {
  retryable?: boolean;
  requestId: string;
  workspaceId: string;
  ok: boolean;
  reason: string;
  reservationId?: string;
  provider?: string;
  model?: string;
}
export function createTaskResources(
  db: VibeDb,
  options: {
    timeoutMs?: number;
    pollMs?: number;
    current?: (workspaceId: string) => { phase: string; confirmedAt: string | null } | undefined;
    waiting?: (workspaceId: string, reason: string) => Promise<void>;
    log?: (message: string, error?: unknown) => void;
  } = {},
) {
  let stopped = false;
  const pending = new Map<
    string,
    {
      resolve: (result: Result) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const consumer = createEventConsumer({
    db,
    consumer: "vibe-verify-task-resources",
    types: ["scheduler.task_resource_result"],
    startAt: "now",
    pollIntervalMs: options.pollMs,
    handler: (event) => {
      const result = event.payload as Result;
      const waiter = pending.get(result.requestId);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      pending.delete(result.requestId);
      waiter.resolve(result);
    },
    onError: (error) => options.log?.("验证资源结果读取失败", error),
  });
  consumer.start();
  function request(
    workspaceId: string,
    action: "acquire" | "bind" | "release" | "reconcile",
    extra: {
      role?: "reviewer" | "verifier";
      candidateIndex?: number;
      reservationId?: string;
      agentId?: string;
    },
  ): Promise<Result> {
    if (stopped) return Promise.reject(new Error("验证插件已停止"));
    const requestId = randomUUID();
    return new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("调度结果不明，保留资源并暂停验证"));
      }, options.timeoutMs ?? 30_000);
      pending.set(requestId, { resolve, reject, timer });
      try {
        publishEvent(db, {
          type: "scheduler.task_resource_request",
          payload: { requestId, workspaceId, action, ...extra },
        });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(requestId);
        reject(error);
      }
    });
  }
  return {
    async acquire(
      workspaceId: string,
      role: "reviewer" | "verifier",
      provider: string,
      candidateIndex: number,
    ): Promise<TaskResourceLease> {
      const confirmedAt = options.current?.(workspaceId)?.confirmedAt;
      let lastReason = "";
      let result: Result;
      for (;;) {
        if (stopped) throw new Error("验证插件已停止，取消资源排队");
        const current = options.current?.(workspaceId);
        if (
          options.current &&
          (!current ||
            current.confirmedAt !== confirmedAt ||
            !["reviewing", "verifying"].includes(current.phase))
        )
          throw new Error("任务已停止或确认变化，取消验证排队");
        result = await request(workspaceId, "acquire", { role, candidateIndex });
        if (result.ok) break;
        if (!result.retryable) throw new Error(result.reason || "调度器拒绝验证资源请求");
        if (result.reason !== lastReason) {
          lastReason = result.reason;
          await options.waiting?.(workspaceId, result.reason);
        }
        await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 500));
      }
      if (!result.reservationId) throw new Error("调度器没有返回验证资源租约");
      if (result.provider && result.provider !== provider)
        throw new Error("调度器与确认快照的模型候选不一致，保留租约等待核对");
      const reservationId = result.reservationId;
      let boundToAgent = false;
      return {
        bind: async (agentId) => {
          const bound = await request(workspaceId, "bind", { reservationId, agentId });
          if (!bound.ok) throw new Error(bound.reason);
          boundToAgent = true;
        },
        release: async () => {
          const released = await request(workspaceId, boundToAgent ? "release" : "reconcile", {
            reservationId,
          });
          if (!released.ok) throw new Error(released.reason);
        },
      };
    },
    poll: consumer.poll,
    async stop() {
      stopped = true;
      await consumer.stop();
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.reject(new Error("验证插件已停止，资源状态待恢复核对"));
      }
      pending.clear();
    },
  };
}
