// Pre-expiry compaction wiring (WP-35): lifecycle hooks feed the scheduler, a timer runs it.

import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { buildContextBlock } from "../inject";
import { createMemoryStore } from "../memory/store";
import { createVibeStore, migrateOwner, openVibeDb, resolveVibeHome } from "../vibe/db";
import { detectNativeIdleCompaction } from "./native";
import { createCompactionScheduler, type CompactionConfig, type CompactionHost } from "./scheduler";
import { compactionSettings } from "./settings";

export * from "./native";
export * from "./policy";
export * from "./scheduler";
export * from "./settings";

export interface CompactionOptions {
  /** Replaceable probe for native idle compaction in the installed Claude Code. */
  detectNative?: () => Promise<boolean>;
  log?: (message: string) => void;
  dbPath?: string;
  settleMs?: number;
}

export function registerCompaction(server: PluginServerContext, options: CompactionOptions = {}) {
  const log = options.log ?? ((m) => console.log(m));
  const settings = server.registerSettings(compactionSettings);
  let config: CompactionConfig = { enabled: true, ttlSeconds: {} };
  let intervalMs = 20_000;
  const apply = (state: Awaited<ReturnType<typeof settings.read>>) => {
    if (state.status !== "ready") return;
    config = state.values;
    intervalMs = state.values.checkIntervalSeconds * 1000;
  };
  void settings.read().then(apply);
  const unsubscribe = settings.subscribe(apply);

  const db = openVibeDb(options.dbPath ? { path: options.dbPath } : {});
  migrateOwner(db, "core");
  const store = createVibeStore(db);
  const userHome = resolveVibeHome();

  let paseo: PaseoApi | null = null;
  const handle = () => {
    if (!paseo) throw new Error("no Paseo handle yet");
    return paseo;
  };
  const host: CompactionHost = {
    run: (agentId, text) => handle().agents.ref(agentId).run(text),
    async handoff(agent, prompt) {
      const created = await handle().agents.create({
        config: { provider: agent.provider },
        cwd: agent.cwd,
        prompt,
      });
      return created.id;
    },
    async archive(agentId) {
      await handle().agents.ref(agentId).archive();
    },
  };

  const scheduler = createCompactionScheduler({
    store,
    host,
    config: () => config,
    buildContext: (cwd) =>
      buildContextBlock(
        createMemoryStore({ projectRoot: cwd, userHome, contextWindowTokens: 200_000 }),
      ),
    settleMs: options.settleMs,
    log,
  });

  const detect = options.detectNative ?? (() => detectNativeIdleCompaction());
  void detect().then((native) => {
    if (native) log("vibe-context: Claude Code compacts idle sessions natively; claude is left to it");
    scheduler.setNativeClaude(native);
  });

  const offs = [
    server.on("agent.turn_started", ({ agent }, ctx) => {
      paseo = ctx.paseo;
      scheduler.onTurnStarted(agent);
    }),
    server.on("agent.turn_ended", ({ agent }, ctx) => {
      paseo = ctx.paseo;
      scheduler.onTurnEnded(agent);
    }),
    server.on("agent.closed", ({ agent }) => scheduler.onAgentGone(agent.id)),
    server.on("agent.archived", ({ agent }) => scheduler.onAgentGone(agent.id)),
  ];

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const loop = async () => {
    try {
      await scheduler.tick();
    } catch (error) {
      log(`vibe-context: compaction tick failed: ${String(error)}`);
    }
    if (!stopped) timer = setTimeout(loop, intervalMs).unref();
  };
  timer = setTimeout(loop, intervalMs).unref();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    for (const off of offs) off();
    unsubscribe();
    db.close();
  };
}
