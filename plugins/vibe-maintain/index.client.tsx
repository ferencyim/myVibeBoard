import type { PluginClientContext } from "@getpaseo/plugin/client";
import { MaintainScreen, MaintainSettingsScreen, MaintainSidebarItem } from "./client/screen";

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "main", title: "Maintenance", Component: MaintainScreen });
  client.addSidebarHeaderItem({ id: "maintain", title: "Maintenance", Component: MaintainSidebarItem });
  client.addSettingsScreen({
    id: "preferences",
    title: "Maintenance",
    icon: "Wrench",
    Component: MaintainSettingsScreen,
  });
  client.addCommandCenterItem({
    id: "open-maintain",
    title: "Maintenance: Open rules and runs",
    icon: "Wrench",
    keywords: ["maintenance", "maintain", "rules", "cleanup"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: "main" });
    },
  });
  return () => {};
}
