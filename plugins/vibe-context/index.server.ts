import { projectIdForDirectory } from "./server/inject/project";
import { registerTaskContext } from "./server/runtime";
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
  const store = createVibeStore(db);
  const prompts = createContextPrompts(store);
  prompts.register();

  const context = server.registerSettings(contextSettings);
  let memoryTokens = DEFAULT_MEMORY_TOKENS;
  let contextValues = contextSettings.schema.parse({});
  const apply = (state: Awaited<ReturnType<typeof context.read>>) => {
    if (state.status === "ready") {
      memoryTokens = state.values.defaultMemoryTokens;
      contextValues = state.values;
    }
  };
  void context.read().then(apply);
  const unsubscribe = context.subscribe(apply);
  const defaultMemoryTokens = () => memoryTokens;

  const unregister = registerInjection(server, {
    log: (m) => console.log(m),
    prompts,
    projectIdFor: (cwd) => projectIdForDirectory(cwd, store.projects.list()),
    defaultMemoryTokens,
    budgetFor: (cwd) => {
      // Best effort: a hint written by the compaction scheduler, read per agent.create.
      try {
        return tightBudgetFor(db, cwd);
      } catch {
        return undefined;
      }
    },
  });
  const taskContext = registerTaskContext(server, {
    db,
    store,
    prompts,
    getConfig: () => contextValues,
  });
  const stopCompaction = registerCompaction(server, {
    prompts,
    defaultMemoryTokens,
    requestHandoff: taskContext.requestHandoff,
    runTaskTurn: taskContext.runTaskTurn,
  });
  return async () => {
    unregister();
    stopCompaction();
    await taskContext.close();
    unsubscribe();
    db.close();
  };
}
