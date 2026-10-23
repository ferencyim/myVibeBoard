import type { PluginClientContext } from "@getpaseo/plugin/client";
import { BoardScreen } from "./client/board/BoardScreen";
import { SessionsScreen } from "./client/sessions/SessionsScreen";
import { BehaviourScreen } from "./client/behaviour/BehaviourScreen";
import {
  BehaviourSidebarItem,
  BoardSettingsScreen,
  BoardSidebarItem,
  SessionsSidebarItem,
} from "./client/sidebar";
import { TaskConversationPanel } from "./client/task-conversation/TaskConversationPanel";
import { newCommandRequestId, TASK_ACTIONS } from "./client/task-conversation/logic";
import { taskConversationCommandRpc } from "./shared/task-conversation";
import { registerTaskRecipients } from "./client/task-conversation/recipients";
import { ReportSummary } from "./client/task-conversation/ReportSummary";
import {
  reportSummarySchema,
  summarizeTaskReport,
} from "./client/task-conversation/report-summary";

export default function contribute(client: PluginClientContext) {
  const cleanups = [
    client.addTimelineTransformer({
      id: "task-report-summary",
      query: { itemType: "assistant_message" },
      transform(input) {
        const report = summarizeTaskReport(input);
        if (!report) return;
        return {
          items: [{ type: "plugin", kind: "task-report-summary", version: 1, data: report }],
        };
      },
    }),
    client.addTimelineRenderer({
      kind: "task-report-summary",
      version: 1,
      schema: reportSummarySchema,
      Component: ReportSummary,
    }),
    client.addFirstMessageOutboxOwner({ initialRole: "planner" }),
    registerTaskRecipients(client),
    client.addWorkspacePanel({
      id: "task-flow",
      title: "任务流程",
      icon: "ListChecks",
      context: "agent",
      locations: ["conversation"],
      Component: TaskConversationPanel,
    }),
    ...TASK_ACTIONS.map(({ command, label, action }) =>
      client.addSlashCommand({
        name: command,
        description: `任务流程：${label}`,
        argumentHint: "[原因或修改要求]",
        context: "agent",
        async onSubmit({ workspace, conversationId, args, rpc, openPanel }) {
          if (!conversationId) throw new Error("请在任务会话中使用此命令");
          await rpc(taskConversationCommandRpc, {
            workspaceId: workspace.id,
            conversationId,
            action,
            requestId: newCommandRequestId(),
            ...(args ? { reason: args } : {}),
          });
          openPanel("task-flow", { location: "conversation" });
        },
      }),
    ),
    // `params`: { project?: <id|prefix>, card?: <key> } open a project tab / a card detail directly.
    client.addScreen({
      id: "board",
      title: (params) => (params.card ? `Vibe Board · ${params.card}` : "Vibe Board"),
      Component: BoardScreen,
    }),

    client.addSidebarHeaderItem({
      id: "board",
      title: "Vibe Board",
      Component: BoardSidebarItem,
    }),

    // 会话汇总: waiting sessions on top, offline-capable (data from the phone replica).
    client.addScreen({ id: "sessions", title: "会话汇总", Component: SessionsScreen }),
    client.addSidebarHeaderItem({
      id: "sessions",
      title: "会话汇总",
      Component: SessionsSidebarItem,
    }),

    // Agent 行为: every prompt of every agent, editable globally or per project.
    client.addScreen({ id: "behaviour", title: "Agent 行为", Component: BehaviourScreen }),
    client.addSidebarHeaderItem({
      id: "behaviour",
      title: "Agent 行为",
      Component: BehaviourSidebarItem,
    }),

    client.addSettingsScreen({
      id: "preferences",
      title: "Vibe Board",
      icon: "KanbanSquare",
      Component: BoardSettingsScreen,
    }),

    client.addSlashCommand({
      name: "board",
      description: "Open the Vibe Board, or a card (e.g. /board WEB-12)",
      argumentHint: "[CARD-KEY]",
      context: "workspace",
      onSubmit({ args, openScreen }) {
        const card = args.trim().toUpperCase();
        openScreen({ screenId: "board", ...(card ? { params: { card } } : {}) });
      },
    }),

    client.addCommandCenterItem({
      id: "open-board",
      title: "Vibe Board: Open",
      icon: "KanbanSquare",
      keywords: ["board", "kanban", "cards", "tasks", "vibe"],
      context: "global",
      onSelect({ openScreen }) {
        openScreen({ screenId: "board" });
      },
    }),

    client.addCommandCenterItem({
      id: "open-behaviour",
      title: "Vibe Board: Agent 行为（提示词与自动化）",
      icon: "Bot",
      keywords: ["prompt", "agent", "behaviour", "提示词", "行为", "规则"],
      context: "global",
      onSelect({ openScreen }) {
        openScreen({ screenId: "behaviour" });
      },
    }),

    client.addCommandCenterItem({
      id: "open-sessions",
      title: "Vibe Board: 会话汇总",
      icon: "MessageSquare",
      keywords: ["sessions", "waiting", "reply", "会话"],
      context: "global",
      onSelect({ openScreen }) {
        openScreen({ screenId: "sessions" });
      },
    }),
  ];

  // The host requires a cleanup function back.
  return async () => {
    for (const cleanup of cleanups) await cleanup();
  };
}
