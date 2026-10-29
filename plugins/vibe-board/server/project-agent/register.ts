import { z } from "zod";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { projectAgentOpenRpc, projectAgentStateRpc } from "../../shared/project-agent";
import type { ProjectAgents } from "./service";

export function registerProjectAgents(server: PluginServerContext, projects: ProjectAgents) {
  server.handle(projectAgentOpenRpc, async (input, context) => {
    if (context.callerAgentId) throw new Error("项目入口仅供用户打开");
    return projects.open(input.projectId);
  });
  server.handle(projectAgentStateRpc, (input) => projects.state(input.projectId));
  const cleanups = [server.on("agent.user_prompt_received", (event) => projects.received(event))];
  server.registerAgentTool({
    name: "vibe_project_tasks",
    description: "读取本项目任务列表，包括目标、阶段与方案状态；仅项目 agent 可用。",
    handler: async (_input, { callerAgentId }) => {
      if (!callerAgentId) throw new Error("工具仅供项目 agent 使用");
      return projects.tasksFor(callerAgentId);
    },
  });
  const route = z
    .object({
      workspaceId: z.string().min(1),
      sourceMessageId: z.string().min(1).optional(),
      text: z.string().describe("逐字复制要路由的真实用户需求，澄清后仍传最初需求，不能修改或总结"),
    })
    .strict();
  server.registerAgentTool({
    name: "vibe_route_to_task",
    description:
      "把当前真实用户原话及附件以用户身份转给本项目已有任务 #1；仅项目 agent 可用，一次性授权。",
    input: route,
    handler: async (input, { callerAgentId }) => {
      if (!callerAgentId) throw new Error("工具仅供项目 agent 使用");
      return projects.route(callerAgentId, route.parse(input));
    },
  });
  const create = z
    .object({
      text: z.string().describe("逐字复制当前用户输入"),
      name: z.string().trim().min(1).optional(),
      sourceMessageId: z.string().min(1).optional(),
    })
    .strict();
  server.registerAgentTool({
    name: "vibe_create_task",
    description:
      "按普通任务路径在本项目新建任务，预建流程角色，并把真实用户原话及附件作为 #1 首消息；仅项目 agent 可用。",
    input: create,
    handler: async (input, { callerAgentId }) => {
      if (!callerAgentId) throw new Error("工具仅供项目 agent 使用");
      return projects.create(callerAgentId, create.parse(input));
    },
  });
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
