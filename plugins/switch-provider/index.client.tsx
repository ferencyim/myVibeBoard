import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SwitchPanel } from "./client/picker";
import { SwitchSettingsScreen } from "./client/settings";

export default function contribute(client: PluginClientContext) {
  const removePanel = client.addWorkspacePanel({
    id: "switch-provider",
    title: "Switch provider",
    icon: "MessagesSquare",
    context: "agent",
    Component: SwitchPanel,
  });
  const removeItem = client.addCommandCenterItem({
    id: "switch-provider",
    title: "Switch provider…",
    icon: "MessagesSquare",
    keywords: ["provider", "model", "continue", "handoff", "codex", "claude", "opencode"],
    context: "agent",
    onSelect({ openPanel }) {
      openPanel("switch-provider");
    },
  });
  const removeSettings = client.addSettingsScreen({
    id: "preferences",
    title: "Switch provider",
    icon: "MessagesSquare",
    Component: SwitchSettingsScreen,
  });
  return () => {
    removeSettings();
    removeItem();
    removePanel();
  };
}
