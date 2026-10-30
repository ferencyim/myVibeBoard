import type { PluginClientContext } from "@getpaseo/plugin/client";
import { GitPanel } from "./client/panel";

export default function contribute(client: PluginClientContext) {
  const cleanups = [
    client.addWorkspacePanel({
      id: "git",
      title: "Git/构建",
      icon: "GitBranch",
      locations: ["workspace", "explorer"],
      Component: GitPanel,
    }),
    client.addCommandCenterItem({
      id: "open-git",
      title: "Git/构建面板",
      icon: "GitBranch",
      keywords: ["Git", "构建", "发布", "工作区"],
      context: "workspace",
      onSelect({ openPanel }) {
        openPanel("git", { location: "explorer" });
      },
    }),
  ];
  return async () => {
    for (const cleanup of cleanups) await cleanup();
  };
}
