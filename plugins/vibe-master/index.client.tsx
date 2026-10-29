import type { PluginClientContext } from "@getpaseo/plugin/client";
import { MasterScreen, MasterSidebarItem, PromptLibrarySidebarItem } from "./client/screen";

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "main", title: "bot", Component: MasterScreen });
  client.addSidebarHeaderItem({ id: "master", title: "bot", order: -30, Component: MasterSidebarItem });
  client.addSidebarHeaderItem({ id: "prompt-library", title: "提示词仓库", order: -20, Component: PromptLibrarySidebarItem });
  client.addCommandCenterItem({
    id: "open-master", title: "bot：查看列表", icon: "Bot", keywords: ["master", "bot"], context: "global",
    onSelect({ openScreen }) { openScreen({ screenId: "main" }); },
  });
  return () => {};
}
