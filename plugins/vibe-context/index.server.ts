import type { PluginServerContext } from "@getpaseo/plugin/server";
import { registerInjection } from "./server/inject";

export default function contribute(server: PluginServerContext) {
  const unregister = registerInjection(server, { log: (m) => console.log(m) });
  return () => unregister();
}
