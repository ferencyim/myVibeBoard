import { botModelsListRpc } from "../../shared/project-bots";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  projectBotsArchiveRpc,
  projectBotsCreateRpc,
  projectBotsListRpc,
  projectBotsOpenRpc,
  projectBotsStateRpc,
} from "../../shared/project-bots";

export function registerProjectBotRpcs(server: PluginServerContext) {
  const pendingLists = new Map<string, Promise<unknown>>();
  async function timed<T>(method: string, invoke: () => Promise<T>): Promise<T> {
    const started = Date.now();
    const timer = setTimeout(() => {
      console.warn(`[vibe-board] bot RPC ${method} 已等待 5 秒`);
    }, 5_000);
    try {
      return await invoke();
    } finally {
      clearTimeout(timer);
      if (Date.now() - started >= 5_000)
        console.warn(`[vibe-board] bot RPC ${method} 结束，耗时 ${Date.now() - started} 毫秒`);
    }
  }
  server.handle(botModelsListRpc, async (input, { paseo, callerAgentId }) => {
    if (callerAgentId) throw new Error("模型目录仅供用户使用");
    return botModelsListRpc.output.parse(await paseo.plugins.invoke("vibe-bots", "models.list", input));
  });
  server.handle(projectBotsListRpc, async (input, context) => {
    if (context.callerAgentId) throw new Error("项目 bot 入口仅供用户使用");
    let pending = pendingLists.get(input.projectId);
    if (!pending) {
      pending = timed("bots.list", () =>
        context.paseo.plugins.invoke("vibe-bots", "bots.list", { ...input, kind: "project" }),
      ).finally(() => pendingLists.delete(input.projectId));
      pendingLists.set(input.projectId, pending);
    }
    return projectBotsListRpc.output.parse(await pending);
  });
  server.handle(projectBotsCreateRpc, async (input, context) => {
    if (context.callerAgentId) throw new Error("项目 bot 入口仅供用户使用");
    if (input.kind !== "project") throw new Error("项目入口只能新建项目 bot");
    return projectBotsCreateRpc.output.parse(
      await context.paseo.plugins.invoke("vibe-bots", "bots.create", input),
    );
  });
  server.handle(projectBotsOpenRpc, async (input, context) => {
    if (context.callerAgentId) throw new Error("项目 bot 入口仅供用户使用");
    return projectBotsOpenRpc.output.parse(
      await timed("bots.open", () => context.paseo.plugins.invoke("vibe-bots", "bots.open", input)),
    );
  });
  server.handle(projectBotsArchiveRpc, async (input, context) => {
    if (context.callerAgentId) throw new Error("项目 bot 入口仅供用户使用");
    return projectBotsArchiveRpc.output.parse(
      await context.paseo.plugins.invoke("vibe-bots", "bots.archive", input),
    );
  });
  server.handle(projectBotsStateRpc, async (input, context) => {
    if (context.callerAgentId) throw new Error("项目 bot 入口仅供用户使用");
    return projectBotsStateRpc.output.parse(
      await context.paseo.plugins.invoke("vibe-bots", "bots.state", input),
    );
  });
}
