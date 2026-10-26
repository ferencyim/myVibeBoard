import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { createBoardService, openBoardRuntime } from "./server/service";
import { registerBoardRpcs } from "./server/rpc";
import { verifyEvidenceRpc } from "./shared/evidence";
import { createTaskEvidenceReader } from "./server/evidence";
import { registerTaskRuntime } from "./server/task-runtime";
import { registerBoardTools } from "./server/tabs/board-tools";

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
  const openTabInput = z
    .object({
      role: z.enum(["scout", "plan_reviewer", "session"]),
      task: z.string().trim().min(1).describe("交给新 tab 的任务说明"),
      provider: z
        .string()
        .trim()
        .optional()
        .describe("provider/model；省略时沿用当前 tab 的模型"),
      presetId: z.string().trim().optional(),
    })
    .strict();
  server.registerAgentTool({
    name: "vibe_open_tab",
    description:
      "由插件在当前 Vibe 任务中打开一个新的编号 tab（scout/plan_reviewer 按角色提示词保持只读）。需要探路或方案复核时使用它，不要用 create_agent 冒充任务 tab。",
    input: openTabInput,
    handler: async (input, { callerAgentId }) => {
      if (!callerAgentId) throw new Error("vibe_open_tab 只能由任务 tab 调用");
      return tasks.tabs.openTab(callerAgentId, openTabInput.parse(input));
    },
  });
  registerBoardTools(server, tasks.board);
  return async () => {
    await tasks.close();
    runtime.close();
  };
}
