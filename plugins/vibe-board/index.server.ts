import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createBoardService, openBoardRuntime } from "./server/service";
import { registerBoardRpcs } from "./server/rpc";
import { verifyEvidenceRpc } from "./shared/evidence";
import { createTaskEvidenceReader } from "./server/evidence";
import { registerTaskRuntime } from "./server/task-runtime";

export default function contribute(server: PluginServerContext) {
  const runtime = openBoardRuntime();
  let paseo: PaseoApi | null = server.paseo ?? null;
  const tasks = registerTaskRuntime(server, {
    db: runtime.db,
    store: runtime.store,
    getPaseo: () => paseo,
    onPaseo: (api) => {
      paseo = api;
    },
  });
  registerBoardRpcs(server, createBoardService(runtime));
  const evidence = createTaskEvidenceReader(runtime.db);
  server.handle(verifyEvidenceRpc, (input) => evidence.evidence(input.evidenceId, input.thumb));
  server.registerAgentTool({
    name: "vibe_tabs",
    description:
      "读取当前 Vibe 任务 tab 的编号、角色、模型和状态。任何任务 tab 都可调用；用户说「继续 #n 的工作」时先用它确认 #n。",
    handler: async (_input, { callerAgentId }) => {
      if (!callerAgentId) throw new Error("vibe_tabs 只能由任务 tab 调用");
      return tasks.tabs.vibeTabs(callerAgentId);
    },
  });
  return async () => {
    await tasks.close();
    runtime.close();
  };
}
