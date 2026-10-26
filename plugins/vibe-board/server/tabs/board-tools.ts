import type { PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import type { TaskBoard } from "./board";

const Id = z.string().trim().min(1).describe("子任务 id");
const Files = z
  .array(z.string().trim().min(1))
  .describe(
    "文件范围（glob，相对 worktree 根）。写文件的子任务必须声明，整仓单写者显式写 \"**\"；只读子任务可留空",
  );

/** Agent tools of the in-task board. Every task tab may list; only the execution tab and its
 *  sub-agents may change the board. */
export function registerBoardTools(server: PluginServerContext, board: TaskBoard) {
  const caller = (name: string, callerAgentId: string | null | undefined) => {
    if (!callerAgentId) throw new Error(`${name} 只能由任务 tab 或其子代理调用`);
    return callerAgentId;
  };
  server.registerAgentTool({
    name: "vibe_board_list",
    description:
      "查看本任务看板：每个子任务的目标、文件范围、依赖、状态（待办/进行中/完成/受阻）、认领者和结论。同任务所有 tab 与子代理都可调用。",
    handler: async (_input, { callerAgentId }) =>
      board.list(caller("vibe_board_list", callerAgentId)),
  });
  const claimInput = z
    .object({
      id: Id,
      assignee: z
        .string()
        .trim()
        .optional()
        .describe("替已有子代理认领时填它的 agentId；省略时由调用者认领"),
    })
    .strict();
  server.registerAgentTool({
    name: "vibe_board_claim",
    description:
      "认领看板子任务后才能开始改文件或派发子代理。依赖未完成、文件范围与进行中的子任务重叠、或已被别人认领时会拒绝并说明原因。",
    input: claimInput,
    handler: async (input, { callerAgentId }) =>
      board.claim(caller("vibe_board_claim", callerAgentId), claimInput.parse(input)),
  });
  const completeInput = z
    .object({
      id: Id,
      summary: z.string().trim().min(1).describe("结论摘要：做了什么、验证结果、剩余问题"),
      changedFiles: z.array(z.string()).optional().describe("本子任务改动的文件路径"),
    })
    .strict();
  server.registerAgentTool({
    name: "vibe_board_complete",
    description:
      "完成已认领的子任务，附改动文件与结论。插件会比对认领期间 worktree 的改动与子任务文件范围，越界文件写进结论并告警执行主代理。",
    input: completeInput,
    handler: async (input, { callerAgentId }) =>
      board.complete(caller("vibe_board_complete", callerAgentId), completeInput.parse(input)),
  });
  const releaseInput = z
    .object({
      id: Id,
      reason: z.string().trim().describe("放弃或失败的原因"),
      failed: z.boolean().optional().describe("true 表示失败，子任务标为受阻；否则退回待办"),
    })
    .strict();
  server.registerAgentTool({
    name: "vibe_board_release",
    description:
      "退回已认领的子任务（放弃或失败）。执行主代理还可以收回认领者已关闭、出错或长时间无活动的子任务。",
    input: releaseInput,
    handler: async (input, { callerAgentId }) =>
      board.release(caller("vibe_board_release", callerAgentId), releaseInput.parse(input)),
  });
  const addInput = z
    .object({
      id: Id,
      goal: z.string().trim().min(1).describe("子任务目标"),
      files: Files,
      dependsOn: z.array(z.string().trim().min(1)).default([]).describe("依赖的子任务 id"),
      acceptance: z.string().optional().describe("验收标准"),
      readOnly: z
        .boolean()
        .optional()
        .describe("只读调研或审查：不改文件，认领不占范围、不与其它子任务冲突"),
      ignore: z
        .array(z.string().trim().min(1))
        .optional()
        .describe("越界比对额外忽略的 glob（锁文件、快照、dist、build 等已内置忽略）"),
    })
    .strict();
  server.registerAgentTool({
    name: "vibe_board_add",
    description:
      "补登看板子任务，或修改未完成子任务的目标、文件范围、依赖、只读标记和越界忽略清单（进行中的子任务改范围时检查与其它进行中子任务是否重叠）。写文件的子任务必须声明 files；只读子任务用 readOnly。执行主代理与认领者可用。",
    input: addInput,
    handler: async (input, { callerAgentId }) =>
      board.add(caller("vibe_board_add", callerAgentId), addInput.parse(input)),
  });
}
