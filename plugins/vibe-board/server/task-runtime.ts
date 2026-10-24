import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { EVENT_PAYLOADS } from "./vibe/contract";
import { createEventConsumer, type VibeDb, type VibeStore } from "./vibe/db";
import { createTaskTabs } from "./tabs/service";
import { createTaskFlow } from "./tabs/flow";
import { taskTabCommandRpc } from "../shared/task-tabs";

/** The business owner for numbered task tabs and the open-tab task flow. */
export function registerTaskRuntime(
  server: PluginServerContext,
  options: {
    db: VibeDb;
    store: VibeStore;
    getPaseo(): PaseoApi | null;
    onPaseo(paseo: PaseoApi): void;
  },
) {
  const log = (message: string, error?: unknown) =>
    console.error("[vibe-board] " + message, error ?? "");
  let closed = false;
  const tabs = createTaskTabs({ store: options.store, getPaseo: options.getPaseo, log });
  const flow = createTaskFlow({
    db: options.db,
    store: options.store,
    tabs,
    getPaseo: options.getPaseo,
    log,
  });
  flow.registerPrompts();
  const cleanups = [
    server.before("workspace.create", ({ request }) => {
      tabs.trackWorkspaceCreate(request);
    }),
    server.on("workspace.created", ({ workspace }, context) => {
      options.onPaseo(context.paseo);
      tabs.claimCreatedWorkspace(workspace.id, workspace.projectId);
    }),
    server.before("agent.create", async ({ request }, context) => {
      options.onPaseo(context.paseo);
      return tabs.injectGuide(request);
    }),
    server.on("agent.created", async ({ agent }, context) => {
      options.onPaseo(context.paseo);
      if (closed) return;
      await tabs.ensureTab(agent.id).catch((error) => log("任务 tab 登记失败", error));
    }),
    server.on("agent.turn_ended", async ({ agent, turnId, outcome }, context) => {
      options.onPaseo(context.paseo);
      if (closed) return;
      try {
        await flow.turnEnded({ agent, turnId, outcome });
      } catch (error) {
        log("任务 tab 回合收尾失败", error);
      }
    }),
  ];
  server.handle(taskTabCommandRpc, async (input, context) => {
    options.onPaseo(context.paseo);
    if (context.callerAgentId)
      throw new Error("agent 消息不能授权任务命令；请由用户在原生输入框发送斜杠命令或「通过」");
    if (input.action === "execute") {
      const result = await flow.execute(input);
      return { task: result.task, message: result.message };
    }
    if (input.action === "accept") {
      const result = await flow.accept(input);
      return { task: result.task, message: result.message };
    }
    if (input.action === "stop") {
      const result = await flow.stop(input);
      return { task: result.task, message: result.message };
    }
    if (input.action === "handoff") {
      const result = await flow.handoff(input);
      return { task: result.task, message: result.message };
    }
    const result = await flow.status(input);
    return { task: result.task, message: result.text };
  });
  const consumer = createEventConsumer({
    db: options.db,
    consumer: "vibe-board:task-tabs",
    types: ["scheduler.task_admitted"],
    handler: async (event) => {
      if (!options.getPaseo()) throw new Error("任务宿主连接尚未就绪，保留事件待重试");
      flow.resources.handleAdmission(event);
      if (event.type !== "scheduler.task_admitted") return;
      await flow.workerAdmitted(
        EVENT_PAYLOADS["scheduler.task_admitted"].parse(event.payload),
      );
    },
    onError: (error) => log("任务准入事件处理失败", error),
  });
  consumer.start();
  return {
    flow,
    tabs,
    async close() {
      closed = true;
      for (const cleanup of cleanups) cleanup();
      await consumer.stop();
      await flow.close();
    },
  };
}
