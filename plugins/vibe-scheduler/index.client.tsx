import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SchedulerScreen, SchedulerSettingsScreen } from "./client/screen";

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "main", title: "调度器", Component: SchedulerScreen });
  client.addPageRailItem({
    id: "scheduler",
    title: "调度器",
    order: 30,
    icon: "CalendarClock",
    screenId: "main",
  });
  client.addSettingsScreen({
    order: -20,
    id: "preferences",
    title: "调度器",
    icon: "Cpu",
    Component: SchedulerSettingsScreen,
  });
  client.addCommandCenterItem({
    id: "open-scheduler",
    title: "调度器：查看并发与设备池",
    icon: "Cpu",
    keywords: ["scheduler", "调度", "并发", "额度", "设备", "模拟器"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: "main" });
    },
  });
  return () => {};
}
