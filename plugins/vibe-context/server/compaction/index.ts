// Pre-expiry compaction wiring (WP-35): lifecycle hooks feed the scheduler, a timer runs it.

import type { AgentSession } from "../vibe/contract";
import { dirname } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { complexitySettings, type ComplexitySettingsValues } from "../complexity";
import { buildContextBlock } from "../inject";
import type { PromptResolver } from "../prompts";
import { createMemoryStore } from "../memory/store";
import { createVibeStore, migrateOwner, openVibeDb, resolveVibeHome } from "../vibe/db";
import { detectNativeIdleCompaction } from "./native";
import { expectSystemTurn, peekSystemTurn } from "./system-turn";
import {
  createCompactionScheduler,
  type AgentInfo,
  type CompactionConfig,
  type CompactionHost,
} from "./scheduler";
import { compactionSettings } from "./settings";

export * from "../complexity";
export * from "./native";
export * from "./policy";
export * from "./scheduler";
export * from "./settings";

export interface CompactionOptions {
  runTaskTurn?: (
    session: AgentSession,
    workspaceId: string | null,
    turn: () => ReturnType<CompactionHost["run"]>,
  ) => ReturnType<CompactionHost["run"]>;
  requestHandoff?: (session: AgentSession, prompt: string) => Promise<void>;
  /** Replaceable probe for native idle compaction in the installed Claude Code. */
  detectNative?: () => Promise<boolean>;
  log?: (message: string) => void;
  dbPath?: string;
  settleMs?: number;
  /** Prompt texts (registry); defaults to the registered defaults. */
  prompts?: PromptResolver;
  /** Memory tokens inlined when no tight budget applies (setting); default 6000. */
  defaultMemoryTokens?: () => number;
}

/** A cold context keeps the exact model settings of the agent it replaces. */
export async function handoffAgent(
  paseo: Pick<PaseoApi, "agents">,
  agent: AgentInfo,
  prompt: string,
): Promise<string> {
  const snapshot = (await paseo.agents.ref(agent.id).refresh())?.agent;
  const provider = snapshot?.model ? `${snapshot.provider}/${snapshot.model}` : agent.provider;
  const thinkingOptionId = snapshot?.effectiveThinkingOptionId ?? snapshot?.thinkingOptionId;
  const created = await paseo.agents.create({
    config: {
      provider,
      ...(thinkingOptionId ? { thinkingOptionId } : {}),
      ...(snapshot?.currentModeId ? { modeId: snapshot.currentModeId } : {}),
    },
    cwd: agent.cwd,
    prompt,
  });
  return created.id;
}

export function registerCompaction(server: PluginServerContext, options: CompactionOptions = {}) {
  const log = options.log ?? ((m) => console.log(m));
  const settings = server.registerSettings(compactionSettings);
  const complexity = server.registerSettings(complexitySettings);
  let complexityValues: ComplexitySettingsValues | undefined;
  let config: CompactionConfig = { enabled: true, ttlSeconds: {} };
  let intervalMs = 20_000;
  const apply = (state: Awaited<ReturnType<typeof settings.read>>) => {
    if (state.status !== "ready") {
      log(`vibe-context: compaction settings invalid, keeping defaults: ${state.error}`);
      return;
    }
    config = state.values;
    log(`vibe-context: compaction settings: ${JSON.stringify(state.values)}`);
    intervalMs = state.values.checkIntervalSeconds * 1000;
  };
  void settings.read().then(apply);
  const unsubscribe = settings.subscribe(apply);
  const applyComplexity = (state: Awaited<ReturnType<typeof complexity.read>>) => {
    if (state.status !== "ready") {
      log(`vibe-context: complexity settings invalid, keeping previous: ${state.error}`);
      return;
    }
    complexityValues = state.values;
    log(`vibe-context: complexity settings: ${JSON.stringify(state.values)}`);
  };
  void complexity.read().then(applyComplexity);
  const unsubscribeComplexity = complexity.subscribe(applyComplexity);

  const db = openVibeDb(options.dbPath ? { path: options.dbPath } : {});
  migrateOwner(db, "core");
  const store = createVibeStore(db);
  const userHome = resolveVibeHome();
  const markerHome = options.dbPath ? dirname(options.dbPath) : userHome;

  let paseo: PaseoApi | null = (server as { paseo?: PaseoApi }).paseo ?? null;
  const handle = () => {
    if (!paseo) throw new Error("no Paseo handle yet");
    return paseo;
  };
  const host: CompactionHost = {
    async describeIdleAgent(agentId) {
      const snapshot = (await handle().agents.ref(agentId).refresh())?.agent;
      if (!snapshot || snapshot.status !== "idle" || snapshot.activeTurn || snapshot.archivedAt)
        return null;
      return { id: agentId, provider: snapshot.provider, cwd: snapshot.cwd };
    },
    async run(agentId, text) {
      // A turn that stops on an approval stays open: wait for the user, up to a bound.
      const agent = handle().agents.ref(agentId);
      const snapshot = (await agent.refresh())?.agent;
      if (!snapshot || snapshot.status !== "idle" || snapshot.activeTurn || snapshot.archivedAt)
        return { status: "permission" };
      const execute = async () => {
        const current = (await agent.refresh())?.agent;
        if (!current || current.status !== "idle" || current.activeTurn || current.archivedAt)
          return { status: "permission" as const };
        // Our own turn: tell the task owner it is not the user continuing the chat.
        expectSystemTurn(agentId, markerHome);
        const deadline = Date.now() + (config.approvalWaitMinutes ?? 10) * 60_000;
        let result = await agent.run(text, { sourceAgentId: agent.id });
        while (
          (result.status === "permission" || result.status === "timeout") &&
          Date.now() < deadline
        ) {
          result = await agent.waitForFinish(30_000);
        }
        return result;
      };
      const session = store.sessions.getByAgent(agentId);
      if (session && !session.cardId) {
        if (!options.runTaskTurn || (snapshot.model && snapshot.model !== session.model))
          return { status: "permission" };
        return options.runTaskTurn(session, snapshot.workspaceId ?? null, execute);
      }
      return execute();
    },
    requestHandoff: options.requestHandoff,
    async handoff(agent, prompt) {
      return handoffAgent(handle(), agent, prompt);
    },
    async archive(agentId) {
      await handle().agents.ref(agentId).archive();
    },
    async cliSessionIds(agentId) {
      const agent = (await handle().agents.ref(agentId).refresh())?.agent;
      const ids = [
        agent?.persistence?.sessionId,
        agent?.persistence?.nativeHandle,
        agent?.runtimeInfo?.sessionId,
      ];
      return [...new Set(ids.filter((id): id is string => !!id))];
    },
  };

  const scheduler = createCompactionScheduler({
    store,
    host,
    config: () => ({ ...config, complexity: complexityValues }),
    usageDb: db,
    isSystemTurn: (agentId) => peekSystemTurn(agentId, markerHome),
    buildContext: (cwd, maxMemoryTokens, projectId) =>
      buildContextBlock(
        createMemoryStore({ projectRoot: cwd, userHome, contextWindowTokens: 200_000 }),
        {
          maxMemoryTokens: maxMemoryTokens ?? options.defaultMemoryTokens?.(),
          prompts: options.prompts,
          projectId,
        },
      ),
    prompts: options.prompts,
    settleMs: options.settleMs,
    log,
  });

  const detect = options.detectNative ?? (() => detectNativeIdleCompaction());
  void detect().then((native) => {
    if (native)
      log("vibe-context: Claude Code compacts idle sessions natively; claude is left to it");
    scheduler.setNativeClaude(native);
    return native;
  });

  const offs = [
    server.on("agent.turn_started", ({ agent }, ctx) => {
      paseo = ctx.paseo;
      scheduler.onTurnStarted(agent);
    }),
    server.on("agent.turn_ended", ({ agent }, ctx) => {
      paseo = ctx.paseo;
      scheduler.onTurnEnded(agent);
      scheduler
        .refreshComplexity(agent)
        .catch((error) => log(`vibe-context: complexity failed: ${String(error)}`));
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
    if (!stopped) timer = schedule();
  };
  // The timer must not keep the daemon alive.
  const schedule = () => {
    const scheduled = setTimeout(loop, intervalMs);
    (scheduled as unknown as { unref?: () => void }).unref?.();
    return scheduled;
  };
  timer = schedule();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    for (const off of offs) off();
    unsubscribe();
    unsubscribeComplexity();
    db.close();
  };
}
