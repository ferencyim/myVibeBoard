import { buildPluginSettingsRoute } from "./settings/routes";
import { router } from "expo-router";
import type { PluginPanelLocation } from "@getpaseo/plugin/client";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildPluginSurfaceRoute } from "./routes";
import type { PluginNavigation } from "./actions";
import { useTaskConversationStore, taskConversationKey } from "@/task-conversations/store";
import { useConversationPanelStore } from "./workspace-panels/conversation-state";

export function createPluginNavigation(input: {
  serverId: string;
  workspaceId: string | null;
}): PluginNavigation {
  const { serverId, workspaceId } = input;
  function placement(location: PluginPanelLocation) {
    if (location !== "explorer") return undefined;
    if (!workspaceId) throw new Error("No active workspace");
    const workspaceKey = `${serverId}:${workspaceId}`;
    const paneId = useWorkspaceLayoutStore.getState().showExplorerSidebar(workspaceKey);
    if (!paneId) throw new Error("Explorer is unavailable");
    return { mode: "pane" as const, paneId };
  }
  return {
    openSettings(pluginId, screenId) {
      router.push(buildPluginSettingsRoute(serverId, pluginId, screenId));
    },
    openSurface(pluginId, surfaceId, params) {
      router.push(
        buildPluginSurfaceRoute(serverId, pluginId, { kind: "surface", id: surfaceId }, params),
      );
    },
    openWorkspacePanel(pluginId, panelId, location) {
      if (location === "conversation") throw new Error("Conversation panels require agent context");
      if (!workspaceId) throw new Error("No active workspace");
      navigateToWorkspace({
        serverId,
        workspaceId,
        target: { kind: "plugin", pluginId, panelId, context: "workspace" },
        placement: placement(location),
      });
    },
    openAgentPanel(pluginId, panelId, agentId, location) {
      if (location === "conversation") throw new Error("Conversation identity is required");
      if (!workspaceId) throw new Error("No active workspace");
      navigateToWorkspace({
        serverId,
        workspaceId,
        target: { kind: "plugin", pluginId, panelId, context: "agent", agentId },
        placement: placement(location),
      });
    },
    openConversationPanel(pluginId, panelId, conversationId) {
      const key = taskConversationKey(serverId, conversationId);
      const conversation = useTaskConversationStore.getState().conversations.get(key);
      if (!conversation || conversation.workspaceId !== workspaceId) {
        throw new Error("Conversation panel context is unavailable");
      }
      useConversationPanelStore.getState().open(key, { pluginId, panelId });
    },
  };
}
