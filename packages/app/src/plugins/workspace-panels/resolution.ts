import type { EvaluatedPluginWorkspacePanelContribution } from "../types";
import type { InstalledPlugin } from "../types";
import type { PluginWorkspaceTabTarget } from "@/workspace-tabs/model";

export function requiredPanelLabel(target: PluginWorkspaceTabTarget): string | null {
  if (
    target.pluginId === "vibe-git" &&
    target.panelId === "git" &&
    target.context === "workspace"
  ) {
    return "Git/构建";
  }
  if (
    (target.pluginId === "vibe-board" &&
      target.panelId === "task-info" &&
      target.context === "workspace") ||
    (target.pluginId === "vibe-bots" && target.panelId === "profile" && target.context === "agent")
  ) {
    return "资料";
  }
  return null;
}

export function resolvePluginWorkspacePanel(
  plugin: InstalledPlugin | null,
  target: PluginWorkspaceTabTarget,
): EvaluatedPluginWorkspacePanelContribution | null {
  return (
    plugin?.workspacePanels.find(
      (panel) => panel.id === target.panelId && panel.context === target.context,
    ) ?? null
  );
}
