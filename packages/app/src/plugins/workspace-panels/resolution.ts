import type { PluginWorkspacePanelContribution } from "@getpaseo/plugin/client";
import type { InstalledPlugin } from "../types";
import type { PluginWorkspaceTabTarget } from "@/workspace-tabs/model";

type ConversationPanelContribution = Extract<
  PluginWorkspacePanelContribution,
  { locations: readonly ["conversation"] }
>;
type StandalonePanelContribution = Exclude<
  PluginWorkspacePanelContribution,
  ConversationPanelContribution
>;

export function isPluginConversationPanel(
  panel: PluginWorkspacePanelContribution,
): panel is ConversationPanelContribution {
  return (
    panel.context === "agent" &&
    panel.locations?.length === 1 &&
    panel.locations[0] === "conversation"
  );
}

export function resolvePluginWorkspacePanel(
  plugin: InstalledPlugin | null,
  target: PluginWorkspaceTabTarget,
): StandalonePanelContribution | null {
  const panel = plugin?.workspacePanels.find(
    (candidate) => candidate.id === target.panelId && candidate.context === target.context,
  );
  return panel && !isPluginConversationPanel(panel) ? panel : null;
}
