import type { PluginServerContext } from "@getpaseo/plugin/server";
import { switchAgentSession } from "./server/convert";
import { switchSession } from "./shared/convert";

export default function contribute(server: PluginServerContext) {
  server.handle(switchSession, switchAgentSession);
  return () => {};
}
