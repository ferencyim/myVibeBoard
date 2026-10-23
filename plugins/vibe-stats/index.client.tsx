import type { PluginClientContext } from "@getpaseo/plugin/client";
import { StatsScreen } from "./client/screen";

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "main", title: "用量统计", Component: StatsScreen });
  client.addCommandCenterItem({
    id: "open-stats",
    title: "统计：打开用量概览",
    icon: "ChartBar",
    keywords: ["统计", "用量", "tokens", "费用", "额度"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: "main" });
    },
  });
  return () => {};
}
