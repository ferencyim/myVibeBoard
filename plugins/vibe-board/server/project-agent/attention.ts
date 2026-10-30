import type { PaseoApi } from "@getpaseo/client";
import { createEventConsumer, type VibeDb, type VibeStore } from "../vibe/db";
import { EVENT_PAYLOADS, TASK_PHASE_LABELS, type TaskPhase } from "../vibe/contract";
import { NEEDS_USER_PHASES } from "./service";

/** Tells a project's default bot when one of its tasks starts waiting for the user or fails. */
export function createTaskAttention(options: {
  db: VibeDb;
  store: VibeStore;
  getPaseo(): PaseoApi | null;
  ready?: Promise<void>;
}) {
  async function check(workspaceId: string) {
    const task = options.store.tasks.get(workspaceId);
    if (!task) return;
    const notify = NEEDS_USER_PHASES.has(task.phase) || task.phase === "failed";
    const last = task.control?.attentionNotifiedPhase;
    if (!notify) {
      if (last) options.store.tasks.updateControl(workspaceId, { attentionNotifiedPhase: null });
      return;
    }
    if (last === task.phase) return;
    const api = options.getPaseo();
    if (!api) throw new Error("宿主尚未连接，任务状态通知保留重试");
    const workspace = await api.workspaces.ref(workspaceId).refresh();
    const projectId = typeof task.control?.projectId === "string" ? task.control.projectId : workspace?.projectId;
    if (!projectId) return;
    const phase: TaskPhase = task.phase;
    const text = `任务「${workspace?.name ?? workspaceId}」(${workspaceId}) 进入「${TASK_PHASE_LABELS[phase]}」` +
      (phase === "failed" ? "，请查看原因并告知用户。" : "，正在等用户处理。");
    const result = await api.plugins.invoke("vibe-bots", "bots.notify", { target: { projectId }, text, source: "任务看板" });
    if (result && typeof result === "object" && "accepted" in result && result.accepted === false) {
      // No default bot (or archived): nothing to retry, record it so the event is not redelivered forever.
      console.warn("[vibe-board] 任务状态未能通知项目 bot", result);
    }
    options.store.tasks.updateControl(workspaceId, { attentionNotifiedPhase: phase });
  }
  const consumer = createEventConsumer({
    db: options.db,
    consumer: "vibe-board:task-attention",
    types: ["task.updated"],
    startAt: "now",
    handler: async (event) => {
      await options.ready;
      const payload = EVENT_PAYLOADS["task.updated"].parse(event.payload);
      if (payload.fields.includes("phase")) await check(payload.workspaceId);
    },
    onError: (error) => console.error("[vibe-board] 任务状态通知失败", error),
  });
  consumer.start();
  return { close: () => consumer.stop() };
}
