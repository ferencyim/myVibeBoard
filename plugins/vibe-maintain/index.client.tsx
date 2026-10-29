import type { PluginClientContext } from "@getpaseo/plugin/client";
import { MaintainScreen, MaintainSettingsScreen, MaintainSidebarItem } from "./client/screen";

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "main", title: "自动维护", Component: MaintainScreen });
  client.addSidebarHeaderItem({ id: "maintain", title: "自动维护", Component: MaintainSidebarItem });
  client.addSettingsScreen({
    order: -10,
    id: "preferences",
    title: "自动维护",
    icon: "Wrench",
    Component: MaintainSettingsScreen,
  });
  client.addCommandCenterItem({
    id: "open-maintain",
    title: "自动维护：查看规则与运行记录",
    icon: "Wrench",
    keywords: ["maintenance", "maintain", "rules", "cleanup", "维护", "规则", "体检"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: "main" });
    },
  });
  return () => {};
}
