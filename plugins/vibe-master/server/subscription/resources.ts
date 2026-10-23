import { randomUUID } from "node:crypto";
import type { MasterTarget } from "../../shared/rpc";
import { MasterError, type MasterAgentHandle } from "../types";
import { createEventConsumer, publishEvent, type VibeDb } from "../vibe/db";

/** The scheduler owns every compute lease, including this auxiliary model. */
export function createMasterResources(deps: {
  db: VibeDb;
  log(message: string, error?: unknown): void;
}) {
  interface Result {
    ok: boolean;
    reason: string;
    reservationId?: string;
    retryable?: boolean;
  }
  let stopped = false;
  const pending = new Map<string, (result: Result) => void>();
  const leases = new Map<string, { workspaceId: string; reservationId: string }>();
  const consumer = createEventConsumer({
    db: deps.db,
    consumer: "vibe-master-resources",
    types: ["scheduler.task_resource_result"],
    startAt: "now",
    pollIntervalMs: 50,
    handler(event) {
      const result = event.payload as Result & { requestId: string };
      pending.get(result.requestId)?.(result);
    },
  });
  consumer.start();
  function request(payload: Record<string, unknown>): Promise<Result> {
    if (stopped) return Promise.reject(new MasterError("unavailable", "总 agent 资源端口已停止"));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        // These events are ordered after acquire/bind. Reconcile only releases when native idle is proven.
        for (const action of ["freeze", "reconcile"])
          publishEvent(deps.db, {
            type: "scheduler.task_resource_request",
            payload: { requestId: randomUUID(), workspaceId: payload.workspaceId, action },
          } as never);
        reject(
          new MasterError("unavailable", "调度器未及时回应总 agent 资源请求，已请求冻结并核对"),
        );
      }, 15000);
      pending.set(requestId, (result) => {
        clearTimeout(timer);
        pending.delete(requestId);
        resolve(result);
      });
      try {
        publishEvent(deps.db, {
          type: "scheduler.task_resource_request",
          payload: { requestId, ...payload },
        } as never);
      } catch (error) {
        clearTimeout(timer);
        pending.delete(requestId);
        reject(error);
      }
    });
  }
  return {
    async acquireFiles(
      workspaceId: string,
      files: string[],
      target: MasterTarget,
    ): Promise<() => Promise<void>> {
      const acquired = await request({
        action: "acquire",
        role: "master",
        workspaceId,
        files,
        hostLease: true,
        provider: target.provider,
        model: target.model,
      });
      if (!acquired.ok || !acquired.reservationId)
        throw new MasterError(
          "unavailable",
          "完成整理等待文件锁：" + acquired.reason,
          acquired.retryable !== false,
        );
      return async () => {
        const released = await request({
          action: "release",
          workspaceId,
          reservationId: acquired.reservationId,
        });
        if (!released.ok) deps.log("完成整理文件锁释放未落实：" + released.reason);
      };
    },
    async acquire(agent: MasterAgentHandle, target: MasterTarget): Promise<() => Promise<void>> {
      let lease = leases.get(agent.id);
      if (lease) {
        const reconciled = await request({ action: "reconcile", workspaceId: lease.workspaceId });
        if (!reconciled.ok)
          throw new MasterError(
            "unavailable",
            "旧总 agent 停止仍未确认：" + reconciled.reason,
            false,
          );
        leases.delete(agent.id);
        lease = undefined;
      }
      if (!lease) {
        const refreshed = (await agent.refresh()) as {
          agent?: { workspaceId?: string | null };
        } | null;
        const workspaceId = refreshed?.agent?.workspaceId;
        if (!workspaceId)
          throw new MasterError("unavailable", "无法读取总 agent 的原生 workspace，未申请计算资源");
        const acquired = await request({
          action: "acquire",
          workspaceId,
          role: "master",
          provider: target.provider,
          model: target.model,
        });
        if (!acquired.ok || !acquired.reservationId)
          throw new MasterError(
            "unavailable",
            "总 agent 等待调度名额：" + acquired.reason,
            acquired.retryable !== false,
          );
        lease = { workspaceId, reservationId: acquired.reservationId };
        const bound = await request({ action: "bind", ...lease, agentId: agent.id });
        if (!bound.ok) {
          await request({ action: "release", ...lease, agentId: agent.id });
          throw new MasterError("unavailable", "总 agent 资源绑定失败：" + bound.reason);
        }
        leases.set(agent.id, lease);
      }
      const active = lease;
      return async () => {
        try {
          const released = await request({ action: "release", ...active, agentId: agent.id });
          // Timeout/permission may leave the native turn active. Its lease remains until idle is proven.
          if (released.ok) leases.delete(agent.id);
          else
            throw new MasterError(
              "unavailable",
              "总 agent 运行未结束，保留计算租约：" + released.reason,
              false,
            );
        } catch (error) {
          deps.log("总 agent 租约释放未落实，保留记录", error);
          if (error instanceof MasterError) throw error;
          throw new MasterError(
            "unavailable",
            "总 agent 停止未确认，保留租约并暂停自动接续",
            false,
          );
        }
      };
    },
    async stop() {
      stopped = true;
      for (const resolve of pending.values()) resolve({ ok: false, reason: "总 agent 已停止" });
      await consumer.stop();
    },
  };
}
