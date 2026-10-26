import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { EVENT_PAYLOADS, type VibeEvent } from "../vibe/contract";
import { publishEvent, type VibeDb } from "../vibe/db";

type Request = ReturnType<(typeof EVENT_PAYLOADS)["scheduler.task_resource_request"]["parse"]>;
type Result = ReturnType<(typeof EVENT_PAYLOADS)["scheduler.task_resource_result"]["parse"]>;
type Admission = ReturnType<(typeof EVENT_PAYLOADS)["scheduler.task_admitted"]["parse"]>;
export interface TaskTurnToken {
  turnId: string;
  isCurrent(): boolean;
  release(): Promise<void>;
}

/** Transport only: the scheduler owns capacity, conflicts, leases and recovery. */
export function createTaskResources(db: VibeDb, timeoutMs = 10_000) {
  const admissions = new Map<string, Admission>();
  const leases = new Map<
    string,
    { workspaceId: string; reservationId: string; generation: string }
  >();
  const generations = new Map<string, { id: string; workspaceId: string }>();
  const turns = new Map<string, { turnId: string; workspaceId: string; generation: string }>();
  const releasing = new Map<string, Promise<void>>();
  async function request(input: Omit<Request, "requestId">): Promise<Result> {
    const requestId = randomUUID();
    const requestSeq = publishEvent(db, {
      type: "scheduler.task_resource_request",
      payload: { ...input, requestId },
    });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const row = db
        .prepare<{ payload_json: string }>(
          "SELECT payload_json FROM vibe_event WHERE seq > ? AND type = 'scheduler.task_resource_result' AND json_extract(payload_json, '$.requestId') = ? ORDER BY seq DESC LIMIT 1",
        )
        .get(requestSeq, requestId);
      if (row)
        return EVENT_PAYLOADS["scheduler.task_resource_result"].parse(JSON.parse(row.payload_json));
      await delay(40);
    }
    throw new Error("调度器未返回准入结果；本轮未运行，资源保持待核对");
  }
  async function releaseAgent(workspaceId: string, agentId: string, generation?: string) {
    if (generation && generations.get(agentId)?.id !== generation) return;
    const pending = releasing.get(agentId);
    if (pending) return pending;
    const lease = leases.get(agentId);
    if (!lease || lease.workspaceId !== workspaceId) return;
    const release = (async () => {
      const result = await request({
        workspaceId,
        agentId,
        action: "release",
        reservationId: lease.reservationId,
      });
      if (result.ok && leases.get(agentId) === lease) {
        leases.delete(agentId);
        if (admissions.get(workspaceId)?.reservationId === lease.reservationId)
          admissions.delete(workspaceId);
      }
    })();
    releasing.set(agentId, release);
    try {
      await release;
    } finally {
      releasing.delete(agentId);
    }
  }
  async function reclaimUnsentReservation(
    workspaceId: string,
    agentId: string,
    reservationId: string,
    generation: string,
    originalError: unknown,
  ) {
    leases.set(agentId, { workspaceId, reservationId, generation });
    try {
      const released = await request({ workspaceId, agentId, action: "release", reservationId });
      if (!released.ok) throw new Error(released.reason);
      leases.delete(agentId);
      if (admissions.get(workspaceId)?.reservationId === reservationId)
        admissions.delete(workspaceId);
    } catch (releaseError) {
      throw new Error(
        String(originalError) + "；尚未派发，资源释放未确认：" + String(releaseError),
        {
          cause: releaseError,
        },
      );
    }
  }
  return {
    request,
    admissionFor: (workspaceId: string) => admissions.get(workspaceId),
    /** Drop a scheduler admission whose reservation was released without being bound. */
    forgetAdmission(workspaceId: string, reservationId: string) {
      if (admissions.get(workspaceId)?.reservationId === reservationId)
        admissions.delete(workspaceId);
    },
    hasLease: (agentId: string) => leases.has(agentId),
    /** The agent this plugin bound (or is binding) to a reservation, if any. */
    holderOf(reservationId: string): string | undefined {
      for (const [agentId, lease] of leases) if (lease.reservationId === reservationId) return agentId;
      return undefined;
    },
    /** Ties a started turn to the lease generation it runs under, so that turn's end can only
     *  release that generation, never a newer admission of the same tab. */
    noteTurnStarted(agentId: string, turnId: string | null) {
      const lease = leases.get(agentId);
      if (lease && turnId) turns.set(agentId, { ...lease, turnId });
    },
    takeTurn(agentId: string, turnId: string | null): TaskTurnToken | undefined {
      const turn = turns.get(agentId);
      if (!turnId || turn?.turnId !== turnId) return undefined;
      turns.delete(agentId);
      return {
        turnId,
        isCurrent: () => generations.get(agentId)?.id === turn.generation,
        release: () => releaseAgent(turn.workspaceId, agentId, turn.generation),
      };
    },
    handleAdmission(event: VibeEvent) {
      if (event.type === "scheduler.task_admitted") {
        const admitted = EVENT_PAYLOADS["scheduler.task_admitted"].parse(event.payload);
        admissions.set(admitted.workspaceId, admitted);
      }
    },
    async admit(
      input: Omit<Request, "requestId" | "action">,
      confirmedAt: string | null,
      beforeBind?: () => void | Promise<void>,
      generation: string = randomUUID(),
    ) {
      const agentId = input.agentId;
      if (!agentId) throw new Error("接手准入缺少原生成员身份");
      while (releasing.has(agentId)) await releasing.get(agentId);
      // Claim the next turn synchronously. An old turn cannot release its replacement while
      // registerRuntime or the scheduler bind request is awaiting an external response.
      generations.set(agentId, { id: generation, workspaceId: input.workspaceId });
      const previous = leases.get(agentId);
      if (previous) leases.set(agentId, { ...previous, generation });
      const admitted = admissions.get(input.workspaceId);
      let reservationId = leases.get(agentId)?.reservationId;
      if (!reservationId && input.role === "worker" && admitted?.confirmedAt === confirmedAt) {
        reservationId = admitted.reservationId;
      } else if (!reservationId) {
        const result = await request({ ...input, action: "acquire" });
        if (!result.ok) throw new Error(result.reason);
        reservationId = result.reservationId;
      }
      if (!reservationId) throw new Error("调度器没有返回可绑定的资源身份");
      leases.set(agentId, { workspaceId: input.workspaceId, reservationId, generation });
      try {
        await beforeBind?.();
      } catch (error) {
        await reclaimUnsentReservation(
          input.workspaceId,
          agentId,
          reservationId,
          generation,
          error,
        );
        throw error;
      }
      const bound = await request({ ...input, action: "bind", reservationId });
      if (!bound.ok) throw new Error(bound.reason);
      leases.set(agentId, { workspaceId: input.workspaceId, reservationId, generation });
      if (admitted?.reservationId === reservationId) admissions.delete(input.workspaceId);
      return bound;
    },
    releaseAgent,
    async settled(workspaceId: string, agentId?: string) {
      for (const [id, generation] of generations)
        if (generation.workspaceId === workspaceId && (!agentId || id === agentId)) {
          generations.delete(id);
          turns.delete(id);
        }
      for (const [id, lease] of leases) {
        if (lease.workspaceId !== workspaceId || (agentId && id !== agentId)) continue;
        await releaseAgent(workspaceId, id);
      }
      const reconciled = await request({ workspaceId, action: "reconcile" });
      if (reconciled.ok) {
        for (const [id, lease] of leases)
          if (lease.workspaceId === workspaceId && (!agentId || id === agentId)) leases.delete(id);
      }
    },
  };
}
