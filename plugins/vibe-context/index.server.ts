import type { PluginServerContext } from "@getpaseo/plugin/server";
import { registerCompaction } from "./server/compaction";
import { tightBudgetFor } from "./server/complexity";
import { migrateOwner, openVibeDb } from "./server/vibe/db";
import { registerInjection } from "./server/inject";

export default function contribute(server: PluginServerContext) {
  const unregister = registerInjection(server, {
    log: (m) => console.log(m),
    budgetFor: (cwd) => {
      // Best effort: a hint written by the compaction scheduler, read per agent.create.
      try {
        const db = openVibeDb();
        try {
          migrateOwner(db, "core");
          return tightBudgetFor(db, cwd);
        } finally {
          db.close();
        }
      } catch {
        return undefined;
      }
    },
  });
  const stopCompaction = registerCompaction(server);
  return () => {
    unregister();
    stopCompaction();
  };
}
