import { useInstalledPlugins } from "@/plugins/registry";
import type { InstalledPlugin, EvaluatedPluginFilePanelContribution } from "@/plugins/types";
import type { ExplorerFile } from "@/stores/session-store";
import { builtinFilePanels } from "./catalog";
import { resolveFilePanel } from "./resolve";

export { resolveFilePanel, type FilePanelCandidate, type FilePanelFile } from "./resolve";
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
  return [
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
  ];
}

export function resolveFilePreviewPanel(input: {
  preview: ExplorerFile | null;
  path: string;
  candidates: readonly FilePanel[];
  associations: Readonly<Record<string, string>>;
}) {
  const { preview, path, associations } = input;
  if (!preview) return null;
  return resolveFilePanel({
    file: { path, kind: preview.kind, size: preview.size, hasBytes: Boolean(preview.bytes) },
    candidates: input.candidates,
    associations,
  }).panel;
}

export { DocumentFrame } from "./document-frame";
