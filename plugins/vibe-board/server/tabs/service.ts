import { randomUUID } from "node:crypto";
import type { PaseoAgent, PaseoApi, PaseoAgentHandle } from "@getpaseo/client";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { PluginBeforeRequests } from "@getpaseo/plugin/server";
import type { VibeStore } from "../vibe/db";
import {
  TASK_PHASE_LABELS,
  TASK_TAB_ROLE_LABEL,
  TASK_TAB_ROLE_LABELS,
  TASK_TAB_ROLES,
  TASK_TAB_PRESET_LABEL,
  type Task,
  type TaskTab,
  type TaskTabRole,
} from "../vibe/contract";
import { assertTaskWorkspace } from "../task-host/workspace";
import { TASK_TAB_GUIDE_PROMPT } from "./prompts";

export interface TaskTabView {
  number: number;
  agentId: string;
  role: TaskTabRole;
  roleLabel: string;
  provider: string;
  model: string;
  status: string;
  title: string | null;
  busy: boolean;
}

function labeledRole(agent: Pick<PaseoAgent, "labels">): TaskTabRole | undefined {
  const value = agent.labels?.[TASK_TAB_ROLE_LABEL];
  return value && (TASK_TAB_ROLES as readonly string[]).includes(value)
    ? (value as TaskTabRole)
    : undefined;
}

function isSubagent(agent: Pick<PaseoAgent, "labels">): boolean {
  return !!agent.labels?.[PARENT_AGENT_ID_LABEL];
}
function statusOf(agent: PaseoAgent): string {
  if (agent.archivedAt) return "已归档";
  if (agent.activeTurn) return "运行中";
  if (agent.status === "idle") return "空闲";
  if (agent.status === "error") return "错误";
  if (agent.status === "closed") return "已关闭";
  return agent.status;
}
export function tabTitle(tab: Pick<TaskTab, "number" | "role" | "model">): string {
  return `#${tab.number} ${TASK_TAB_ROLE_LABELS[tab.role]} · ${tab.model}`;
}
export function formatTabs(tabs: readonly Pick<TaskTabView, "number" | "roleLabel" | "model" | "status">[]) {
  if (!tabs.length) return "（尚无）";
  return tabs.map((tab) => `#${tab.number} ${tab.roleLabel} · ${tab.model}（${tab.status}）`).join("\n");
}

/** Task tabs are ordinary agents; this registry only adds immutable numbers and titles. */
export function createTaskTabs(options: {
  store: VibeStore;
  getPaseo(): PaseoApi | null;
  log?: (message: string, error?: unknown) => void;
}) {
  const { store } = options;
  const log = options.log ?? ((message, error) => console.error("[vibe-board]", message, error ?? ""));
  function paseo(): PaseoApi {
    const api = options.getPaseo();
    if (!api) throw new Error("任务宿主尚未连接");
    return api;
  }
  async function refreshAgent(agentId: string): Promise<{ handle: PaseoAgentHandle; agent: PaseoAgent }> {
    const handle = paseo().agents.ref(agentId);
    await handle.refresh();
    const agent = handle.current();
    if (!agent) throw new Error("找不到原生 agent：" + agentId);
    return { handle, agent };
  }
  async function taskWorkspace(workspaceId: string) {
    const placement = paseo().workspaces.ref(workspaceId);
    await placement.refresh();
    assertTaskWorkspace(placement.current());
    return placement;
  }
  /** Allocates a number once per agent; subagents and archived agents stay out of the tab list. */
  async function ensureTab(agentId: string): Promise<TaskTab | null> {
    const { handle, agent } = await refreshAgent(agentId);
    const workspaceId = agent.workspaceId;
    if (!workspaceId || agent.internal || agent.archivedAt || isSubagent(agent)) return null;
    let placement;
    try {
      placement = await taskWorkspace(workspaceId);
    } catch {
      return null;
    }
    let task = store.tasks.get(workspaceId);
    if (!task) task = store.tasks.create({ workspaceId, anchorAgentId: agentId });
    const existing = task.tabs.find((tab) => tab.agentId === agentId);
    if (existing) return existing;
    const role = labeledRole(agent) ?? (agentId === task.anchorAgentId ? "main" : "session");
    const { tab } = store.tasks.allocateTab(workspaceId, {
      agentId,
      role,
      provider: agent.provider,
      model: agent.model?.trim() || "default",
      thinking: agent.thinkingOptionId ?? undefined,
      presetId: agent.labels?.[TASK_TAB_PRESET_LABEL] || undefined,
    });
    await handle.setTitle(tabTitle(tab)).catch((error) => {
      log("任务 tab 标题设置失败（编号已保留）", error);
    });
    return tab;
  }
  async function tabsFor(task: Task, refresh: boolean): Promise<TaskTabView[]> {
    return Promise.all(
      task.tabs.map(async (tab) => {
        let agent: PaseoAgent | undefined;
        if (refresh) {
          try {
            agent = (await refreshAgent(tab.agentId)).agent;
          } catch {
            agent = undefined;
          }
        }
        return {
          number: tab.number,
          agentId: tab.agentId,
          role: tab.role,
          roleLabel: TASK_TAB_ROLE_LABELS[tab.role],
          provider: agent?.provider ?? tab.provider,
          model: agent?.model ?? tab.model,
          status: agent ? statusOf(agent) : "已关闭",
          title: agent?.title ?? tabTitle(tab),
          busy: !!agent?.activeTurn,
        };
      }),
    );
  }
  function rolePromptKey(role: TaskTabRole): string | undefined {
    if (role === "main") return "task.role.planner";
    if (role === "scout" || role === "plan_reviewer" || role === "worker")
      return "task.role." + role;
    return undefined;
  }
  async function injectGuide(
    request: PluginBeforeRequests["agent.create"],
  ): Promise<PluginBeforeRequests["agent.create"]> {
    const workspaceId = request.workspaceId;
    if (!workspaceId) return request;
    if (request.labels?.[PARENT_AGENT_ID_LABEL] || request.parentAgentId) return request;
    let placement;
    try {
      placement = await taskWorkspace(workspaceId);
    } catch {
      return request;
    }
    const task = store.tasks.get(workspaceId);
    const role =
      labeledRole({ labels: request.labels ?? {} }) ??
      (task?.tabs.length ? ("session" as const) : ("main" as const));
    const tabs = task ? await tabsFor(task, false) : [];
    const projectId = placement.projectId;
    const guide = store.prompts.resolve(TASK_TAB_GUIDE_PROMPT.key, {
      projectId,
      vars: { tabs: formatTabs(tabs) },
    });
    const roleKey = rolePromptKey(role);
    const roleText = roleKey ? store.prompts.resolve(roleKey, { projectId }) : "";
    const format = role === "main" ? store.prompts.resolve("task.plan_format", { projectId }) : "";
    const supplied = request.config.systemPrompt ?? "";
    const parts = [guide, roleText, format].filter(
      (text): text is string => !!text && !supplied.includes(text),
    );
    return {
      ...request,
      config: {
        ...request.config,
        systemPrompt: [...parts, supplied].filter(Boolean).join("\n\n"),
      },
    };
  }
  async function status(workspaceId: string, agentId: string) {
    if (!store.tasks.get(workspaceId)) throw new Error("当前 workspace 不是 Vibe 任务");
    const task = store.tasks.get(workspaceId)!;
    const tabs = await tabsFor(task, true);
    const self = tabs.find((tab) => tab.agentId === agentId);
    const artifacts = store.taskArtifacts.list(workspaceId).slice(-3);
    const lines = [
      `任务阶段：${TASK_PHASE_LABELS[task.phase]}`,
      `方案：${task.plan?.goal ?? "尚未保存完整方案"}`,
      self ? `当前 tab：#${self.number} ${self.roleLabel}` : "当前 tab：未登记",
      "任务 tab：",
      formatTabs(tabs),
    ];
    if (task.control?.blockingReason) lines.push(`阻塞：${String(task.control.blockingReason)}`);
    if (task.summary) lines.push(`最新结论：${task.summary}`);
    for (const artifact of artifacts)
      lines.push(`沉淀（${artifact.kind}）：${artifact.summary}`);
    return { task, tabs, text: lines.join("\n") };
  }
  async function appendStatus(agentId: string, text: string) {
    await paseo()
      .agents.ref(agentId)
      .timeline.append({
        type: "plugin",
        id: randomUUID(),
        kind: "task-status",
        version: 1,
        data: { text },
      });
  }
  async function vibeTabs(callerAgentId: string) {
    const { agent } = await refreshAgent(callerAgentId);
    if (!agent.workspaceId) throw new Error("当前 agent 不属于任务 workspace");
    const { task, tabs } = await status(agent.workspaceId, agent.id);
    return {
      workspaceId: agent.workspaceId,
      phase: task.phase,
      plan: task.plan?.goal ?? null,
      self: tabs.find((tab) => tab.agentId === agent.id)?.number ?? null,
      tabs: tabs.map((tab) => ({
        number: tab.number,
        agentId: tab.agentId,
        role: tab.role,
        roleLabel: tab.roleLabel,
        provider: tab.provider,
        model: tab.model,
        status: tab.status,
      })),
    };
  }
  return {
    injectGuide,
    ensureTab,
    tabsFor,
    status,
    appendStatus,
    vibeTabs,
    formatTabs,
    workspace: taskWorkspace,
  };
}
export type TaskTabs = ReturnType<typeof createTaskTabs>;
