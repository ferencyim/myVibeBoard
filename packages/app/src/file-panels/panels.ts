import { useMemo } from "react";
import { useInstalledPlugins } from "@/plugins/registry";
import type { InstalledPlugin, EvaluatedPluginFilePanelContribution } from "@/plugins/types";
import { builtinFilePanels } from "./catalog";

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
