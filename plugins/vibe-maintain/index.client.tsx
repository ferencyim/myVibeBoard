import type { PluginClientContext } from "@getpaseo/plugin/client";
import { MaintainPanel, isRequiredForAgent } from "./client/panel";

export default function contribute(client: PluginClientContext) {
  client.addAgentPanel({ id: "maintenance", title: "自动维护", icon: "Wrench", locations: ["explorer"], Component: MaintainPanel, requiredForAgent: isRequiredForAgent });
  return () => {};
}
