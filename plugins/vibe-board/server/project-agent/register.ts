import { projectBotModelRpc } from "../../shared/project-bots";
import { z } from "zod";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { projectAgentOpenRpc, projectAgentStateRpc } from "../../shared/project-agent";
import type { ProjectAgents } from "./service";

export function registerProjectAgents(server: PluginServerContext, projects: ProjectAgents) {
  server.handle(projectAgentOpenRpc, async (input, context) => {
    if (context.callerAgentId) throw new Error("项目入口仅供用户打开");
    return projects.open(input.projectId);
  });
  server.handle(projectBotModelRpc, (input, context) => {
    if (context.callerAgentId) throw new Error("项目 bot 默认模型仅供宿主服务读取");
    return projects.resolveModel(input.projectId);
  });
  server.handle(projectAgentStateRpc, (input) => projects.state(input.projectId));
  const cleanups = [server.on("agent.user_prompt_received", (event) => projects.received(event))];
  server.registerAgentTool({
    name: "vibe_projects",
    description: "独立 bot 只读查看各项目；不会修改项目或派发任务。",
    handler: async (_input, { callerAgentId }) => {
      if (!callerAgentId) throw new Error("工具仅供 bot 使用");
      return projects.projectsFor(callerAgentId);
    },
  });
  const tasks = z.object({ projectId: z.string().min(1).optional() }).strict();
  server.registerAgentTool({
    name: "vibe_project_tasks",
    description: "只读查看任务目标、阶段与方案状态；独立 bot 指定 projectId，项目 bot 只能查看本项目。",
    input: tasks,
    handler: async (input, { callerAgentId }) => {
      if (!callerAgentId) throw new Error("工具仅供 bot 使用");
      return projects.tasksFor(callerAgentId, tasks.parse(input ?? {}).projectId);
    },
  });
  server.registerAgentTool({
    name: "vibe_tasks_overview",
    description: "只读查看全部项目任务的精简状态（项目、任务名、阶段、流程档位、是否在等用户、最近活动）。所有 bot 可用；修改仍只限本项目。",
    handler: async (_input, { callerAgentId }) => {
      if (!callerAgentId) throw new Error("工具仅供 bot 使用");
      return projects.overviewFor(callerAgentId);
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
  const setFlow = z.object({
    workspaceId: z.string().min(1),
    flowLevel: z.enum(["simple", "medium", "full"]),
    flowReason: z.string().trim().min(1),
  }).strict();
  server.registerAgentTool({
    name: "vibe_set_task_flow",
    description: "为等待自动评估的本项目新任务设置流程档位和理由。",
    input: setFlow,
    handler: async (input, { callerAgentId }) => {
      if (!callerAgentId) throw new Error("工具仅供项目 bot 使用");
      return projects.setTaskFlow(callerAgentId, setFlow.parse(input));
    },
  });
  const create = z
    .object({
      text: z.string().describe("逐字复制当前用户输入"),
      projectId: z.string().min(1).optional(),
      name: z.string().trim().min(1).optional(),
      sourceMessageId: z.string().min(1).optional(),
      flowLevel: z.enum(["simple", "medium", "full"]),
      flowReason: z.string().trim().min(1),
    })
    .strict();
  server.registerAgentTool({
    name: "vibe_create_task",
    description:
      "按普通任务路径新建任务并预建流程角色，真实用户原话及附件作为 #1 首消息；独立 bot 必须指定 projectId，项目 bot 只能在本项目创建。",
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
