import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ContextSettingsScreen } from "./client/settings";

export default function contribute(client: PluginClientContext) {
  client.addSettingsScreen({
    id: "preferences",
    title: "上下文与压缩",
    icon: "Layers",
    Component: ContextSettingsScreen,
  });
  return () => {};
}
