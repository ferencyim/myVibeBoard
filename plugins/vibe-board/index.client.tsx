import { ProjectAgentSettingsSection } from "./client/project-settings";
import { ProjectAgentSidebarItem, contributeProjectBotWorkspaces } from "./client/project-agent";
import { resolveMainConfigRpc } from "./shared/rpc";
import { TaskDefaultsScreen, ProjectTaskDefaultsSection } from "./client/presets/defaults-screen";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { BehaviourScreen } from "./client/behaviour/BehaviourScreen";
import { BehaviourSidebarItem, BoardSettingsScreen } from "./client/sidebar";
import { TaskFlowPanel } from "./client/task-panel";
import { TaskStatusItem } from "./client/task-status";
import { contributeGroupTarget } from "./client/group-target";
import { contributeWorkspaceTabs } from "./client/workspace-tabs";
import { contributeTaskSidebarProjection } from "./client/project-agent-task-projection";
import { taskStatusDataSchema, taskTabCommandRpc, type TaskTabCommand } from "./shared/task-tabs";

let requestCounter = 0;
const requestId = () => `task-tab-${Date.now()}-${++requestCounter}`;

const COMMANDS: readonly {
  command: string;
  action: TaskTabCommand["action"];
  label: string;
  hint: string;
}[] = [
  { command: "执行", action: "execute", label: "确认最新方案并打开执行 tab", hint: "可附修改要求" },
  { command: "通过", action: "accept", label: "验收本轮验证结果并完成 Git 收尾", hint: "可附说明" },
  {
    command: "重新审阅",
    action: "rereview",
    label: "让方案模型列表再审阅一次当前最新方案（在主会话或方案 tab 发送）",
    hint: "无",
  },
  {
    command: "停止任务",
    action: "stop",
    label: "撤销排队并停止运行中的任务 tab",
    hint: "可附说明",
  },
  {
    command: "接手",
    action: "handoff",
    label: "接手指定 tab 的角色与进度",
    hint: "#编号，可附要求",
  },
  {
    command: "状态",
    action: "status",
    label: "把任务阶段、tab 状态和最新结论追加到当前 tab",
    hint: "无",
  },
];

export default function contribute(client: PluginClientContext) {
  const cleanups = [
    contributeWorkspaceTabs(client),
    contributeProjectBotWorkspaces(client),
    contributeTaskSidebarProjection(client),
    client.addProjectSidebarGroup({
      id: "project-agent",
      title: "项目 bot",
      order: -100,
      Component: ProjectAgentSidebarItem,
    }),
    client.addFirstMessageModelResolver({
      async resolve(input) {
        return (await client.rpc(resolveMainConfigRpc, input)).config ?? null;
      },
    }),
    ...COMMANDS.map(({ command, action, label, hint }) =>
      client.addSlashCommand({
        name: command,
        description: `任务流程：${label}`,
        argumentHint: hint,
        context: "agent",
        async onSubmit({ workspace, agent, args, rpc }) {
          await rpc(taskTabCommandRpc, {
            workspaceId: workspace.id,
            agentId: agent.id,
            action,
            requestId: requestId(),
            ...(args ? { reason: args } : {}),
          });
        },
      }),
    ),
    client.addTimelineRenderer({
      kind: "task-status",
      version: 1,
      schema: taskStatusDataSchema,
      Component: TaskStatusItem,
    }),
    client.addWorkspacePanel({
      id: "task-flow",
      title: "任务流程",
      icon: "ListChecks",
      locations: ["workspace", "explorer"],
      Component: TaskFlowPanel,
    }),
    client.addCommandCenterItem({
      id: "open-task-flow",
      title: "任务流程面板",
      icon: "ListChecks",
      keywords: ["任务", "流程", "状态", "tab", "面板"],
      context: "workspace",
      onSelect({ openPanel }) {
        openPanel("task-flow", { location: "explorer" });
      },
    }),
    // Agent 行为: every prompt of every agent, editable globally or per project.
    client.addScreen({ id: "behaviour", title: "Agent 行为", Component: BehaviourScreen }),
    client.addSidebarHeaderItem({
      id: "behaviour",
      title: "Agent 行为",
      Component: BehaviourSidebarItem,
    }),

    client.addProjectSettingsSection({
      id: "project-agent",
      title: "项目 agent 全局策略（本主机）",
      Component: ProjectAgentSettingsSection,
    }),
    client.addProjectSettingsSection({
      id: "task-default-models",
      title: "任务默认模型",
      Component: ProjectTaskDefaultsSection,
    }),
    client.addSettingsScreen({
      order: -50,
      id: "task-default-models",
      title: "任务默认模型",
      icon: "Bot",
      Component: TaskDefaultsScreen,
    }),
    client.addSettingsScreen({
      order: -40,
      id: "preferences",
      title: "任务设置",
      icon: "Settings",
      Component: BoardSettingsScreen,
    }),

    client.addCommandCenterItem({
      id: "open-behaviour",
      title: "Agent 行为（提示词与自动化）",
      icon: "Bot",
      keywords: ["prompt", "agent", "behaviour", "提示词", "行为", "规则"],
      context: "global",
      onSelect({ openScreen }) {
        openScreen({ screenId: "behaviour" });
      },
    }),
    // 「发给」on each task's #1 composer.
    contributeGroupTarget(client),
  ];

  // The host requires a cleanup function back.
  return async () => {
    for (const cleanup of cleanups) await cleanup();
  };
}
