import type { PluginClientContext } from "@getpaseo/plugin/client";
import { MasterScreen } from "./client/screen";

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "main", title: "bot", Component: MasterScreen });
  client.addPageRailItem({ id: "master", title: "bot", icon: "Bot", order: 0, screenId: "main" });
  client.addCommandCenterItem({
    id: "open-master", title: "bot：查看列表", icon: "Bot", keywords: ["master", "bot"], context: "global",
    onSelect({ openScreen }) { openScreen({ screenId: "main" }); },
  });
  return () => {};
}
