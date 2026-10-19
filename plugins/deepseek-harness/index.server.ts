import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createDeepSeekHarnessProvider } from "./server/provider";
import { createDeepSeekUsageSource } from "./server/usage";

export default function contribute(server: PluginServerContext) {
  const provider = createDeepSeekHarnessProvider();
  server.registerProvider(provider);
  server.registerUsageSource(createDeepSeekUsageSource());
  return async () => {
    await provider.dispose();
  };
}
