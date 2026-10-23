import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSessionStore } from "@/stores/session-store";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";
import { useMemo } from "react";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";

import { getIsElectron } from "@/constants/platform";
import { createWorkspaceBrowser } from "@/desktop/browser/store";
import { createPluginHostNavigation } from "./host-navigation-model";
import { router } from "expo-router";
import { buildPluginSurfaceRoute } from "./routes";
import { buildPluginSettingsRoute } from "./settings/routes";
import { setPluginTaskConversationRecipients } from "./workspace-panels/recipients";
import { createTaskConversationNavigation } from "@/task-conversations/navigation";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useConversationPanelStore } from "./workspace-panels/conversation-state";
import { taskConversationKey } from "@/task-conversations/store";
import type { InstalledPlugin } from "./types";

export function usePluginHostNavigation(
  serverId: string,
  installation?: InstalledPlugin,
): NonNullable<PluginSurfaceProps["navigation"]> {
  const compact = useIsCompactFormFactor();
  return useMemo(
    () => ({
      ...createPluginHostNavigation(serverId, {
        browserAvailable: getIsElectron(),
        openAgent: navigateToAgent,
        openWorkspace: navigateToWorkspace,
        createBrowser: createWorkspaceBrowser,
        openPluginScreen: ({ serverId: host, pluginId, screenId, params }) =>
          router.push(
            buildPluginSurfaceRoute(host, pluginId, { kind: "surface", id: screenId }, params),
          ),
        openPluginSettings: ({ serverId: host, pluginId, screenId }) =>
          router.push(buildPluginSettingsRoute(host, pluginId, screenId)),
        resolveWorkspace: ({ serverId: targetServerId, workspaceId }) =>
          resolveWorkspaceMapKeyByIdentity({
            workspaces: useSessionStore.getState().sessions[targetServerId]?.workspaces,
            workspaceId,
          }),
      }),
      setTaskConversationRecipients: installation
        ? (input) => setPluginTaskConversationRecipients(serverId, input, installation)
        : undefined,
      ...(installation
        ? createTaskConversationNavigation({
            serverId,
            pluginId: installation.id,
            signal: installation.lifetime.signal,
            getClient: () => getHostRuntimeStore().getClient(serverId),
            onOpen: (conversationId) => {
              if (compact)
                useConversationPanelStore
                  .getState()
                  .close(taskConversationKey(serverId, conversationId));
            },
            hasWorkspace: (workspaceId) =>
              Boolean(
                resolveWorkspaceMapKeyByIdentity({
                  workspaces: useSessionStore.getState().sessions[serverId]?.workspaces,
                  workspaceId,
                }),
              ),
          })
        : {}),
    }),
    [serverId, installation, compact],
  );
}
