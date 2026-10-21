import type { PluginServerContext } from "@getpaseo/plugin/server";
import { registerCompaction } from "./server/compaction";
import { tightBudgetFor } from "./server/complexity";
import { contextSettings, DEFAULT_MEMORY_TOKENS } from "./server/inject";
import { createContextPrompts } from "./server/prompts";
import { createVibeStore, migrateOwner, openVibeDb } from "./server/vibe/db";
import { registerInjection } from "./server/inject";

export default function contribute(server: PluginServerContext) {
  // Prompt registry: register the defaults once; texts are resolved on every use.
  const db = openVibeDb();
  migrateOwner(db, "core");
  const prompts = createContextPrompts(createVibeStore(db));
  prompts.register();

  const context = server.registerSettings(contextSettings);
  let memoryTokens = DEFAULT_MEMORY_TOKENS;
  const apply = (state: Awaited<ReturnType<typeof context.read>>) => {
    if (state.status === "ready") memoryTokens = state.values.defaultMemoryTokens;
  };
  void context.read().then(apply);
  const unsubscribe = context.subscribe(apply);
  const defaultMemoryTokens = () => memoryTokens;

  const unregister = registerInjection(server, {
    log: (m) => console.log(m),
    prompts,
    defaultMemoryTokens,
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
  const stopCompaction = registerCompaction(server, { prompts, defaultMemoryTokens });
  return () => {
    unregister();
    stopCompaction();
    unsubscribe();
    db.close();
  };
}
