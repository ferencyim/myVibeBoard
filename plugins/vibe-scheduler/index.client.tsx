import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SchedulerScreen, SchedulerSettingsScreen } from "./client/screen";

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "main", title: "中枢", Component: SchedulerScreen });
  client.addPageRailItem({
    id: "scheduler",
    title: "中枢",
    order: 30,
    icon: "ListTodo",
    screenId: "main",
  });
  client.addSettingsScreen({
    order: -20,
    id: "preferences",
    title: "中枢",
    icon: "Cpu",
    Component: SchedulerSettingsScreen,
  });
  client.addCommandCenterItem({
    id: "open-scheduler",
    title: "中枢：队列、资源与全局指令",
    icon: "Cpu",
    keywords: ["scheduler", "hub", "中枢", "队列", "暂停", "指令", "调度", "并发", "额度", "设备", "模拟器"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: "main" });
    },
  });
  return () => {};
}
