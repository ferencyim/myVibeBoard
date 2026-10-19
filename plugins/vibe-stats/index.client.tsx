import type { PluginClientContext } from "@getpaseo/plugin/client";
import { StatsScreen, StatsSettingsScreen, StatsSidebarItem } from "./client/screen";

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "main", title: "Stats", Component: StatsScreen });
  client.addSidebarHeaderItem({ id: "stats", title: "Stats", Component: StatsSidebarItem });
  client.addSettingsScreen({
    id: "preferences",
    title: "Stats",
    icon: "ChartBar",
    Component: StatsSettingsScreen,
  });
  client.addCommandCenterItem({
    id: "open-stats",
    title: "Stats: Open usage overview",
    icon: "ChartBar",
    keywords: ["stats", "usage", "tokens", "cost", "quota"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: "main" });
    },
  });
  return () => {};
}
