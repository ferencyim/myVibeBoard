import { useInstalledPlugins } from "@/plugins/registry";
import type { InstalledPlugin, EvaluatedPluginFilePanelContribution } from "@/plugins/types";
import { useMemo } from "react";
import { builtinFilePanels } from "./catalog";

export {
  resolveFilePreviewPanel,
  resolveFilePanel,
  type FilePanelCandidate,
  type FilePanelFile,
} from "./resolve";
export { builtinFilePanels, isRenderedMarkdownFile } from "./catalog";
export { FilePanelPreview } from "./preview";

export interface PluginFilePanel {
  id: string;
  files: EvaluatedPluginFilePanelContribution["files"];
  document: "text" | "bytes";
  maxBytes: number;
  plugin: InstalledPlugin;
  contribution: EvaluatedPluginFilePanelContribution;
}
export type FilePanel = (typeof builtinFilePanels)[number] | PluginFilePanel;

export function useFilePanels(serverId: string): readonly FilePanel[] {
  const plugins = useInstalledPlugins();
  return useMemo(
    () => [
      ...builtinFilePanels,
      ...plugins
        .filter((plugin) => plugin.serverId === serverId)
        .flatMap((plugin) =>
          plugin.filePanels.map((contribution) => ({
            id: `plugin:${plugin.id}/${contribution.id}`,
            files: contribution.files,
            document: contribution.document,
            maxBytes: contribution.maxBytes,
            plugin,
            contribution,
          })),
        ),
    ],
    [plugins, serverId],
  );
}

export { DocumentFrame } from "./document-frame";
