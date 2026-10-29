import type { ComponentType } from "react";
import { i18n } from "@/i18n/i18next";
import type { PanelDescriptor, PanelIconProps } from "@/panels/panel-registry";

export function buildDraftPanelDescriptor(input: {
  isCreating: boolean;
  title?: string;
  disabled?: boolean;
  pendingPrompt?: string | null;
  icon: ComponentType<PanelIconProps>;
}): PanelDescriptor {
  const { icon, isCreating, pendingPrompt } = input;
  const newAgentLabel = input.title
    ? input.title + (input.disabled ? " · 未启用" : "")
    : i18n.t("panels.draft.newAgent");
  const creatingLabel = input.title ? newAgentLabel : pendingPrompt?.trim() || newAgentLabel;
  if (isCreating) {
    return {
      label: creatingLabel,
      subtitle: i18n.t("panels.draft.creatingAgent"),
      tooltip: creatingLabel,
      titleState: "ready",
      icon,
      statusBucket: "running",
    };
  }

  return {
    label: newAgentLabel,
    subtitle: newAgentLabel,
    tooltip: newAgentLabel,
    titleState: "ready",
    icon,
    statusBucket: null,
  };
}
