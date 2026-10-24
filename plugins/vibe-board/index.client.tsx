import type { PluginClientContext } from "@getpaseo/plugin/client";
import { BehaviourScreen } from "./client/behaviour/BehaviourScreen";
import { BehaviourSidebarItem, BoardSettingsScreen } from "./client/sidebar";
import { taskTabCommandRpc, type TaskTabCommand } from "./shared/task-tabs";

let requestCounter = 0;
const requestId = () => `task-tab-${Date.now()}-${++requestCounter}`;

const COMMANDS: readonly { command: string; action: TaskTabCommand["action"]; label: string; hint: string }[] =
  [
    { command: "执行", action: "execute", label: "确认最新方案并打开执行 tab", hint: "可附修改要求" },
    { command: "通过", action: "accept", label: "验收本轮验证结果并完成 Git 收尾", hint: "可附说明" },
    { command: "状态", action: "status", label: "把任务阶段、tab 状态和最新结论追加到当前 tab", hint: "无" },
  ];

export default function contribute(client: PluginClientContext) {
  const cleanups = [
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
    // Agent 行为: every prompt of every agent, editable globally or per project.
    client.addScreen({ id: "behaviour", title: "Agent 行为", Component: BehaviourScreen }),
    client.addSidebarHeaderItem({
      id: "behaviour",
      title: "Agent 行为",
      Component: BehaviourSidebarItem,
    }),

    client.addSettingsScreen({
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
  ];

  // The host requires a cleanup function back.
  return async () => {
    for (const cleanup of cleanups) await cleanup();
  };
}
