import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SchedulerScreen, SchedulerSettingsScreen, SchedulerSidebarItem } from "./client/screen";

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "main", title: "Scheduler", Component: SchedulerScreen });
  client.addSidebarHeaderItem({ id: "scheduler", title: "Scheduler", Component: SchedulerSidebarItem });
  client.addSettingsScreen({
    id: "preferences",
    title: "Scheduler",
    icon: "Cpu",
    Component: SchedulerSettingsScreen,
  });
  client.addCommandCenterItem({
    id: "open-scheduler",
    title: "Scheduler: Open concurrency and device pool",
    icon: "Cpu",
    keywords: ["scheduler", "concurrency", "quota", "devices", "emulator"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: "main" });
    },
  });
  return () => {};
}
