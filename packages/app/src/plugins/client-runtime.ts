import { createPlayAudio, type AudioEngine } from "@/audio";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { createPluginHosts } from "./hosts";
import type { PluginClientOpenPanelOptions } from "@getpaseo/plugin/client";
import {
  createPluginAgentActionContext,
  createPluginCapabilities,
  createPluginWorkspaceActionContext,
} from "./actions";
import { createPluginClientStateSource } from "./client-state/source";
import type { PluginClientRuntime } from "./evaluate";
import { createPluginNavigation } from "./navigation";
import { pluginButtonStore } from "./buttons";
import type { InstalledPlugin } from "./types";
import { setPluginTaskConversationRecipients } from "./workspace-panels/recipients";
import { resolvePluginPanelOpenLocation } from "./workspace-panels/locations";

export function createPluginClientRuntime(
  installation: InstalledPlugin,
  audio: Pick<AudioEngine, "play">,
): PluginClientRuntime {
  const state = createPluginClientStateSource(installation.serverId);
  const capabilities = createPluginCapabilities(
    installation,
    createPluginNavigation({ serverId: installation.serverId, workspaceId: null }),
  );
  return {
    ...capabilities,
    setTaskConversationRecipients(input) {
      setPluginTaskConversationRecipients(installation.serverId, input, installation);
    },
    playAudio: createPlayAudio(audio, installation.lifetime.signal),
    hosts: createPluginHosts(getHostRuntimeStore(), installation.lifetime.signal),
    addComposerPill(contribution) {
      return pluginButtonStore.addComposerPill(installation, contribution);
    },
    addHeaderButton(contribution) {
      return pluginButtonStore.addHeaderButton(installation, contribution);
    },
    openPanel(panelId, options) {
      openClientPanel({ installation, state, panelId, options });
    },
  };
}

function openClientPanel(input: {
  installation: InstalledPlugin;
  state: ReturnType<typeof createPluginClientStateSource>;
  panelId: string;
  options: PluginClientOpenPanelOptions;
}): void {
  const { installation, state, panelId, options } = input;
  const workspaceId = options.workspaceId.trim();
  const agentId = (options.anchorAgentId ?? options.agentId)?.trim();
  const navigation = createPluginNavigation({ serverId: installation.serverId, workspaceId });
  const panel = installation.workspacePanels.find((candidate) => candidate.id === panelId);
  if (!panel) throw new Error(`Workspace panel is unavailable: ${panelId}`);
  const location = resolvePluginPanelOpenLocation(panel, options.location);
  if (location === "conversation") {
    if (!options.conversationId || !navigation.openConversationPanel) {
      throw new Error("Conversation panel context is unavailable");
    }
    navigation.openConversationPanel(installation.id, panelId, options.conversationId);
    return;
  }
  const action = agentId
    ? createPluginAgentActionContext({
        plugin: installation,
        navigation,
        state,
        workspaceId,
        agentId,
        conversationId: options.conversationId,
        anchorAgentId: options.anchorAgentId ?? undefined,
      })
    : createPluginWorkspaceActionContext({
        plugin: installation,
        navigation,
        state,
        workspaceId,
      });
  if (!action) throw new Error("Plugin panel context is unavailable");
  action.openPanel(panelId, { location: options.location });
}
