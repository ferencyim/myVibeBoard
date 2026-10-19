import type { PluginServerContext } from "@getpaseo/plugin/server";
import { registerCompaction } from "./server/compaction";
import { registerInjection } from "./server/inject";

export default function contribute(server: PluginServerContext) {
  const unregister = registerInjection(server, { log: (m) => console.log(m) });
  const stopCompaction = registerCompaction(server);
  return () => {
    unregister();
    stopCompaction();
  };
}
