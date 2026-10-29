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
  server.handle(botModelsListRpc, async (input, { paseo, callerAgentId }) => {
    if (callerAgentId) throw new Error("模型目录仅供用户使用");
    return botModelsListRpc.output.parse(await paseo.plugins.invoke("vibe-bots", "models.list", input));
  });
  server.handle(projectBotsListRpc, async (input, context) => {
    if (context.callerAgentId) throw new Error("项目 bot 入口仅供用户使用");
    return projectBotsListRpc.output.parse(
      await context.paseo.plugins.invoke("vibe-bots", "bots.list", { ...input, kind: "project" }),
    );
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
      await context.paseo.plugins.invoke("vibe-bots", "bots.open", input),
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
