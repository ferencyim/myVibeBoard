import type { PluginClientContext, PluginWorkspaceTabDescriptor } from "@getpaseo/plugin/client";
import { taskPanelRpc, taskTabEnsureRpc, type TaskTabViewData } from "../shared/task-tabs";
import { UNRESOLVED_TAB_MODEL } from "../shared/vibe/contract";

export function taskWorkspaceTabs(tabs: TaskTabViewData[]): PluginWorkspaceTabDescriptor[] {
  return tabs.map((tab) => {
    const descriptor: PluginWorkspaceTabDescriptor = {
      id: tab.role,
      title: tab.title ?? `#${tab.number} ${tab.roleLabel} · ${tab.model}`,
      order: tab.number,
      disabled: tab.status === "未启用",
    };
    if (tab.agentId) descriptor.agentId = tab.agentId;
    if (tab.provider) {
      descriptor.setup = { provider: tab.provider };
      const model = tab.modelId ?? tab.model;
      if (model && model !== "沿用 #1 模型" && model !== UNRESOLVED_TAB_MODEL) descriptor.setup.model = model;
      if (tab.thinking) descriptor.setup.thinkingOptionId = tab.thinking;
    }
    return descriptor;
  });
}

export function contributeWorkspaceTabs(client: PluginClientContext) {
  return client.addWorkspaceTabProvider({
    id: "task-flow",
    async resolve({ workspaceId }) {
      const panel = await client.rpc(taskPanelRpc, { workspaceId });
      return panel.isTask ? taskWorkspaceTabs(panel.tabs) : [];
    },
    async create({ workspaceId, tabId, provider, model, thinkingOptionId }) {
      if (tabId === "main") {
        const panel = await client.rpc(taskPanelRpc, { workspaceId });
        const main = panel.tabs.find((tab) => tab.role === "main" && tab.agentId);
        if (!main) throw new Error("主会话暂时不可用，请稍后重试。");
        return { agentId: main.agentId };
      }
      if (!model) throw new Error("无法确定此角色的模型，请前往「任务默认模型」设置后重试。");
      return client.rpc(taskTabEnsureRpc, {
        workspaceId,
        role: roleForTab(tabId),
        provider: `${provider}/${model}`,
        thinkingOptionId,
      });
    },
    async enable({ workspaceId, tabId }) {
      await client.rpc(taskTabEnsureRpc, { workspaceId, role: roleForTab(tabId), enable: true });
    },
  });
}

function roleForTab(id: string) {
  switch (id) {
    case "planner":
    case "scout":
    case "worker":
    case "reviewer":
    case "verifier":
      return id;
    default:
      throw new Error("此 tab 不是可创建的流程角色。");
  }
}
