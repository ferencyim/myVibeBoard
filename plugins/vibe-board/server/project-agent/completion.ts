import type { PaseoApi } from "@getpaseo/client";
import type { BoardSettingsValues } from "../../shared/settings";
import { createEventConsumer, type VibeDb, type VibeStore } from "../vibe/db";
import { PROJECT_COMPLETION_PROMPT } from "./completion-prompt";
import { EVENT_PAYLOADS } from "../vibe/contract";

/** Task control stores delivery receipts, so restart catch-up cannot enqueue the same work twice. */
export function createProjectCompletion(options: {
  db: VibeDb;
  store: VibeStore;
  getPaseo(): PaseoApi | null;
  settings(): BoardSettingsValues;
  sendProject(projectId: string, text: string): Promise<void>;
  ready?: Promise<void>;
}) {
  let closed = false;
  options.store.prompts.register([PROJECT_COMPLETION_PROMPT], {
    aliases: { "master.wake.task_done": PROJECT_COMPLETION_PROMPT.key },
  });
  const inflight = new Map<string, Promise<void>>();
  function completed(workspaceId: string): Promise<void> {
    const running = inflight.get(workspaceId);
    if (running) return running;
    const next = deliver(workspaceId).finally(() => inflight.delete(workspaceId));
    inflight.set(workspaceId, next);
    return next;
  }
  async function deliver(workspaceId: string) {
    if (closed || !options.settings().projectConsolidateOnDone) return;
    const task = options.store.tasks.get(workspaceId);
    if (!task || task.phase !== "completed") return;
    const key = task.confirmedAt ?? "completed";
    if (task.control?.projectCompletionDelivered === key) return;
    const api = options.getPaseo();
    if (!api) throw new Error("项目 agent 尚未连接，完成整理事件保留重试");
    const workspace = await api.workspaces.ref(workspaceId).refresh();
    if (!workspace) return;
    const requirements = options.settings().projectMaintainRequirements;
    await options.sendProject(
      workspace.projectId,
      options.store.prompts.resolve(PROJECT_COMPLETION_PROMPT.key, {
        projectId: workspace.projectId,
        vars: {
          project: workspace.projectId,
          workspace: workspaceId,
          plan: JSON.stringify(task.plan),
          summary: task.summary,
          runs: JSON.stringify(task.subtaskRuns),
          memory: "请读取本项目 AGENTS.md 与 CLAUDE.md 的当前内容，不凭历史快照改写。",
          task: JSON.stringify({
            workspaceId,
            goal: task.plan?.goal,
            plan: task.plan,
            summary: task.summary,
          }),
          requirements: requirements
            ? "按任务已确认结果维护 PRODUCT-REQUIREMENTS.md，不添加未获用户确认的新需求。"
            : "本次关闭需求文档维护，不修改 PRODUCT-REQUIREMENTS.md。",
        },
      }),
    );
    options.store.tasks.updateControl(workspaceId, { projectCompletionDelivered: key });
  }
  const consumer = createEventConsumer({
    db: options.db,
    consumer: "vibe-board:project-completion",
    types: ["task.updated"],
    startAt: "now",
    handler: async (event) => {
      await options.ready;
      const payload = EVENT_PAYLOADS["task.updated"].parse(event.payload);
      if (payload.fields.includes("phase")) await completed(payload.workspaceId);
    },
    onError: (error) => console.error("[vibe-board] 项目完成整理投递失败", error),
  });
  consumer.start();
  const sweep = async () => {
    await options.ready;
    if (!options.settings().projectSweepOnStart) return;
    for (const task of options.store.tasks.list({ phase: "completed" })) {
      try {
        await completed(task.workspaceId);
      } catch (error) {
        console.error("[vibe-board] 项目整理补扫单任务失败", error);
      }
    }
  };
  const timer = setTimeout(() => {
    void sweep().catch((error) => console.error("[vibe-board] 项目整理补扫失败", error));
  }, 5000);
  return {
    completed,
    sweep,
    async close() {
      closed = true;
      clearTimeout(timer);
      await consumer.stop();
    },
  };
}
