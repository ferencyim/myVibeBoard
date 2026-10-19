import type { TFunction } from "i18next";
import type { PluginIcon } from "@getpaseo/plugin/client";
import type { FilePanel } from "../panels";
import { parseFilePanelSelectorKey } from "../resolve";

const BUILTIN_PRESENTATION = {
  "builtin:markdown": { title: "markdown", icon: "FileText" },
  "builtin:html": { title: "html", icon: "FileCode" },
  "builtin:image": { title: "image", icon: "Image" },
} as const;

export function filePanelIcon(panel: FilePanel): PluginIcon {
  return "plugin" in panel ? panel.contribution.icon : BUILTIN_PRESENTATION[panel.id].icon;
}

/** "Markdown — Paseo", "Rich Markdown — markdown-panel". */
export function filePanelOptionLabel(t: TFunction, panel: FilePanel): string {
  if ("plugin" in panel) {
    return t("panels.file.filePanels.option", {
      title: panel.contribution.title,
      owner: panel.plugin.id,
    });
  }
  return t("panels.file.filePanels.option", {
    title: t(`panels.file.filePanels.builtin.${BUILTIN_PRESENTATION[panel.id].title}`),
    owner: t("panels.file.filePanels.builtin.owner"),
  });
}

/** "Open .md files with" for an extension key, "Open Dockerfile with" for a filename key. */
export function filePanelPickerTitle(t: TFunction, selectorKey: string): string {
  const selector = parseFilePanelSelectorKey(selectorKey);
  return selector.kind === "name"
    ? t("panels.file.filePanels.pickerTitleFilename", { filename: selector.value })
    : t("panels.file.filePanels.pickerTitleExtension", { extension: selector.value });
}

/** "Always use for .md", "Always use for Dockerfile". */
export function filePanelAlwaysUseLabel(t: TFunction, selectorKey: string): string {
  const selector = parseFilePanelSelectorKey(selectorKey);
  return selector.kind === "name"
    ? t("panels.file.filePanels.alwaysUseFilename", { filename: selector.value })
    : t("panels.file.filePanels.alwaysUseExtension", { extension: selector.value });
}
