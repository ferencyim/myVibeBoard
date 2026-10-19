import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SwitchPanel } from "./client/picker";

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
  return () => {
    removeItem();
    removePanel();
  };
}
