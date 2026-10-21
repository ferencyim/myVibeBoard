import type { PluginServerContext } from "@getpaseo/plugin/server";
import { switchAgentSession } from "./server/convert";
import { switchSession } from "./shared/convert";
import { switchSettings } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(switchSettings);
  server.handle(switchSession, async (input, context) => {
    // Read per call so a changed setting applies to the next switch. Invalid stored values fall back to the defaults.
    const state = await settings.read();
    return switchAgentSession(input, context, state.status === "ready" ? state.values : undefined);
  });
  return () => {};
}
