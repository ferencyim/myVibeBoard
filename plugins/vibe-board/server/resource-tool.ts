import type { PluginServerContext } from "@getpaseo/plugin/server";
import { readResourceBriefing, type VibeDb } from "./vibe/db";

export function registerResourceTool(
  server: Pick<PluginServerContext, "registerAgentTool">,
  db: VibeDb,
) {
  server.registerAgentTool({
    name: "vibe_resources",
    description:
      "读取本机和远程开发机当前资源的一行简报及紧张项；构建、全量测试、模拟器、打包前调用。",
    handler: async () => {
      const { briefing, tightItems } = readResourceBriefing(db);
      return { briefing, tightItems };
    },
  });
}
