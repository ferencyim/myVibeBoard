import type { PluginClientContext } from "@getpaseo/plugin/client";
import { VerifySettingsScreen } from "./client/settings";

export default function contribute(client: PluginClientContext) {
  client.addSettingsScreen({
    id: "preferences",
    title: "验证与复核",
    icon: "ShieldCheck",
    Component: VerifySettingsScreen,
  });
  return () => {};
}
