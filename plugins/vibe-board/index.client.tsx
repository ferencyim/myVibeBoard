import type {
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import React from "react";
import { TASK_CARD_KIND, TASK_TEXT_KIND } from "./shared/constants";
import {
  getAgentTasksRpc,
  seedDemoRpc,
  taskCardDataSchema,
  tasksAttachmentSource,
  taskTextDataSchema,
} from "./shared/contract";
import { transformAssistantTaskDirectives } from "./shared/directive";
import {
  TaskAgentPanel,
  TasksScreen,
  TasksSidebarItem,
  TasksWorkspacePanel,
} from "./client/screen";
import {
   TasksSettingsScreen,
  TaskTimelineCardItem,
  TaskTimelineTextItem,
} from "./client/timeline-card";

export default function contribute(client: PluginClientContext) {
  // 1. Main Screen & Sidebar Header Item
  client.addScreen({
    id: "main",
    title: (params) => (params.taskKey ? `Tasks · ${params.taskKey}` : "Tasks"),
    Component: TasksScreen,
  });

  client.addSidebarHeaderItem({
    id: "tasks",
    title: "Tasks",
    Component: TasksSidebarItem,
  });

  // 2. Workspace & Agent Panels
  client.addWorkspacePanel({
    id: "tasks-board",
    title: "Tasks",
    icon: "ListTodo",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: TasksWorkspacePanel,
  });

  client.addWorkspacePanel({
    id: "task-detail",
    title: "Task",
    icon: "ListTodo",
    context: "agent",
    locations: ["workspace", "explorer"],
    Component: TaskAgentPanel,
  });

  // 3. Settings Screen
  client.addSettingsScreen({
    id: "preferences",
    title: "Tasks",
    icon: "ListTodo",
    Component: TasksSettingsScreen,
  });

  // 4. Composer Attachment Source (@ / + picker)
  client.addAttachmentSource(tasksAttachmentSource);

  // 5. Timeline Transformer & Renderers for ::task{key="PROD-1"}
  client.addTimelineTransformer({
    id: "tasks-directive",
    query: { itemType: "assistant_message" },
    transform({ item, phase }) {
      return transformAssistantTaskDirectives(item.text, phase);
    },
  });

  client.addTimelineRenderer({
    kind: TASK_CARD_KIND,
    version: 1,
    schema: taskCardDataSchema,
    Component: (props) => (
      <TaskTimelineCardItem
        {...props}
        onOpenTask={(taskKey) =>
          client.openScreen({ screenId: "main", params: { taskKey } })
        }
      />
    ),
  });

  client.addTimelineRenderer({
    kind: TASK_TEXT_KIND,
    version: 1,
    schema: taskTextDataSchema,
    Component: TaskTimelineTextItem,
  });

  // 6. Slash Commands
  client.addSlashCommand({
    name: "tasks",
    description: "Open Paseo Tasks board or a specific task key (e.g. /tasks PROD-1)",
    argumentHint: "[TASK-KEY]",
    context: "workspace",
    onSubmit({ args, openScreen }) {
      const trimmed = args.trim().toUpperCase();
      if (trimmed) {
        openScreen({ screenId: "main", params: { taskKey: trimmed } });
      } else {
        openScreen({ screenId: "main" });
      }
    },
  });

  client.addSlashCommand({
    name: "task-panel",
    description: "Open the Task inspector panel beside this agent",
    argumentHint: "",
    context: "agent",
    onSubmit({ openPanel }) {
      openPanel("task-detail");
    },
  });

  // 7. Command Center Items
  client.addCommandCenterItem({
    id: "open-tasks",
    title: "Tasks: Open Board & List",
    icon: "ListTodo",
    keywords: ["tasks", "kanban", "board", "linear", "tracker", "delegate"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: "main" });
    },
  });

  client.addCommandCenterItem({
    id: "open-workspace-tasks",
    title: "Tasks: Open Workspace Board Panel",
    icon: "ListTodo",
    keywords: ["tasks", "board", "panel", "kanban"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("tasks-board");
    },
  });

  client.addCommandCenterItem({
    id: "open-agent-task",
    title: "Tasks: Open Agent Task Inspector",
    icon: "ListTodo",
    keywords: ["task", "agent", "delegate", "thread"],
    context: "agent",
    onSelect({ openPanel }) {
      openPanel("task-detail");
    },
  });

  client.addCommandCenterItem({
    id: "seed-demo-tasks",
    title: "Tasks: Seed Sample Projects & Tasks",
    icon: "Sparkles",
    keywords: ["tasks", "seed", "demo", "sample"],
    context: "global",
    async onSelect({ rpc, openScreen }) {
      await rpc(seedDemoRpc, {});
      openScreen({ screenId: "main" });
    },
  });

  // 8. Composer Pill per Agent (shows linked task key or "Task" button)
  const pills = new Map<string, PluginButtonRegistration>();
  const lifetime = new AbortController();

  const registerPill = (agent: {
    id: string;
    workspaceId?: string | null;
    labels?: Record<string, string>;
  }) => {
    if (lifetime.signal.aborted || !agent.workspaceId) return;
    const agentId = agent.id;
    const workspaceId = agent.workspaceId;
    const taskKey = agent.labels?.taskKey;
    pills.get(agentId)?.remove();
    pills.set(
      agentId,
      client.addComposerPill({
        id: "task-pill",
        workspaceId,
        agentId,
        button: {
          title: taskKey ? `Open task ${taskKey}` : "Open linked Task panel",
          icon: "ListTodo",
          label: taskKey ?? "Task",
          behavior: {
            kind: "action",
            async onPress() {
              if (taskKey) {
                client.openPanel("task-detail", { workspaceId, agentId });
                return;
              }
              try {
                const res = await client.rpc(getAgentTasksRpc, { agentId });
                if (res.tasks.length > 0) {
                  client.openPanel("task-detail", { workspaceId, agentId });
                  return;
                }
              } catch {}
              client.openPanel("task-detail", { workspaceId, agentId });
            },
          },
        },
      }),
    );
  };

  const removeAllPills = () => {
    for (const pill of pills.values()) pill.remove();
    pills.clear();
  };

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          removeAllPills();
          for (const { agent } of entries) registerPill(agent);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "upsert") return registerPill(update.agent);
          pills.get(update.agentId)?.remove();
          pills.delete(update.agentId);
        },
      });
      return undefined;
    })
    .catch(() => undefined);

  return () => {
    lifetime.abort();
    removeAllPills();
  };
}
