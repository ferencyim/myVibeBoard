// Pre-expiry compaction scheduler (WP-35). Driven by the clock only: a session that is idle and
// whose prompt cache expires within the margin gets its progress written to the session .md and
// is then compacted (`/compact`) or, for CLIs without it, handed over to a fresh agent.
// Card events: for `/compact` the board lifecycle records completed compactions found in the
// turn timeline; this module records one only if the lifecycle did not (counts are compared), so
// there is exactly one. A handoff has no compaction item, so it is recorded here ("handoff").

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createLayout } from "../memory/layout";
import type { AgentSession } from "../vibe/contract";
import {
  buildTurnStats,
  classifyComplexity,
  queryCallUsage,
  readState,
  setTightBudget,
  updateState,
  writeState,
  type ComplexitySettingsValues,
} from "../complexity";
import type { VibeDb, VibeStore } from "../vibe/db";
import {
  baseProvider,
  COMPACT_PROVIDERS,
  DEFAULT_MARGIN_RULE,
  DEFAULT_TTL_SECONDS,
  FALLBACK_TTL_SECONDS,
  marginSeconds,
  skipReason,
  supportsCompact,
  type SkipReason,
} from "./policy";
import { defaultPrompts, type PromptResolver } from "../prompts";

export interface AgentInfo {
  id: string;
  provider: string;
  cwd: string;
}

/** What the scheduler needs from the daemon; tests pass a fake. */
export interface CompactionHost {
  /** Rehydrate only a native idle, unarchived agent after daemon restart. */
  describeIdleAgent?(agentId: string): Promise<AgentInfo | null>;
  /** Sends a prompt and resolves with how the turn ended; "permission" only after giving up on an approval. */
  run(
    agentId: string,
    text: string,
  ): Promise<{ status: "idle" | "error" | "permission" | "timeout" }>;
  /** Starts a fresh agent of the same kind with this prompt; returns its agent id. */
  handoff(agent: AgentInfo, prompt: string): Promise<string>;
  archive(agentId: string): Promise<void>;
  /** A workspace cold handoff is delegated to its owner so admission and stopping cannot be bypassed. */
  requestHandoff?(session: AgentSession, prompt: string): Promise<void>;
  /** CLI session ids behind an agent (the ids usage_event rows carry); enables complexity. */
  cliSessionIds?(agentId: string): Promise<string[]>;
}

export interface CompactionConfig {
  enabled: boolean;
  ttlSeconds: Record<string, number>;
  marginSeconds?: number;
  /** Advanced settings (WP-99); absent = the built-in values. */
  fallbackTtlSeconds?: number;
  marginLongFromSeconds?: number;
  marginLongSeconds?: number;
  marginShortSeconds?: number;
  compactProviders?: readonly string[];
  compactCommands?: Record<string, string>;
  approvalWaitMinutes?: number;
  /** Complexity policy (WP-83); absent = off. */
  complexity?: ComplexitySettingsValues;
}

export interface SchedulerOptions {
  /** Historical card harnesses must opt in explicitly; production never resumes old card writers. */
  includeLegacyCards?: boolean;
  store: Pick<VibeStore, "sessions" | "events" | "cards">;
  host: CompactionHost;
  config: () => CompactionConfig;
  /** Project goals + PROJECT_STATE.md block for a working directory (server/inject). */
  buildContext: (cwd: string, maxMemoryTokens?: number, projectId?: string | null) => string | null;
  /** Shared vibe.db handle: usage_event rows (vibe-stats) and the persisted complexity state. */
  usageDb?: Pick<VibeDb, "prepare">;
  /** True when a plugin announced it is about to start a turn on this agent (not counted). */
  isSystemTurn?: (agentId: string) => boolean;
  now?: () => number;
  /** Grace after `/compact` before checking whether the board lifecycle recorded the event. */
  settleMs?: number;
  /** Poll interval while waiting for the session to be marked idle again. */
  pollMs?: number;
  /** Prompt texts (registry); defaults to the registered defaults. */
  prompts?: PromptResolver;
  /** Claude Code compacts idle sessions itself: leave claude alone. */
  nativeClaude?: boolean;
  log?: (message: string) => void;
}

type Skipped = SkipReason | "native" | "untracked" | "failed" | "deferred";
export type TickOutcome =
  | { sessionId: string; action: "compact" | "handoff" | "requested" }
  | { sessionId: string; action: "skipped"; reason: Skipped };

export const ttlFor = (config: CompactionConfig, provider: string): number => {
  const id = baseProvider(provider);
  return (
    config.ttlSeconds[id] ??
    DEFAULT_TTL_SECONDS[id] ??
    config.fallbackTtlSeconds ??
    FALLBACK_TTL_SECONDS
  );
};

/** Seconds before expiry at which the compaction window opens. */
export const marginFor = (config: CompactionConfig, ttlSeconds: number): number =>
  config.marginSeconds ??
  marginSeconds(ttlSeconds, {
    longFrom: config.marginLongFromSeconds ?? DEFAULT_MARGIN_RULE.longFrom,
    long: config.marginLongSeconds ?? DEFAULT_MARGIN_RULE.long,
    short: config.marginShortSeconds ?? DEFAULT_MARGIN_RULE.short,
  });

/** The compact command of a provider ("/compact" unless the owner set another). */
export const compactCommandFor = (config: CompactionConfig, provider: string): string =>
  config.compactCommands?.[baseProvider(provider)] ?? "/compact";

export const canCompact = (config: CompactionConfig, provider: string): boolean =>
  supportsCompact(provider, config.compactProviders ?? COMPACT_PROVIDERS);

export function notesPrompt(
  mdPath: string,
  cardRef?: string | null,
  prompts: PromptResolver = defaultPrompts,
): string {
  return prompts.resolve("context.compact_notes", {
    vars: { mdPath, keyClause: cardRef ? `，key 为 "${cardRef}"` : "" },
  });
}

export function restorePrompt(
  block: string | null,
  prompts: PromptResolver = defaultPrompts,
): string {
  return prompts.resolve("context.compact_restore", {
    vars: { block: block ?? "（无项目上下文）" },
  });
}

export function coldStartPrompt(
  oldSessionId: string,
  mdPath: string,
  block: string | null,
  prompts: PromptResolver = defaultPrompts,
): string {
  return prompts.resolve("context.cold_start", {
    vars: {
      oldSessionId,
      mdPath,
      block: block
        ? `

${block}`
        : "",
    },
  });
}

export function createCompactionScheduler(options: SchedulerOptions) {
  const { store, host } = options;
  const prompts = () => options.prompts ?? defaultPrompts;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  let nativeClaude = options.nativeClaude ?? false;
  const agents = new Map<string, AgentInfo>();
  const compacted = new Set<string>(); // session ids handled in the current idle period
  const busy = new Set<string>(); // agent ids with a compaction flow in flight
  const cliIds = new Map<string, string[]>(); // agent id -> CLI session ids
  const turnStart = new Map<string, number>(); // agent id -> start of the running turn (ms)
  const systemTurns = new Set<string>(); // agent ids whose running turn is not the user's

  const track = (agent: AgentInfo) =>
    void agents.set(agent.id, { id: agent.id, provider: agent.provider, cwd: agent.cwd });
  const compactionEvents = (session: AgentSession) => {
    if (!session.cardId && session.workspaceId && options.usageDb)
      return (
        options.usageDb
          .prepare<{ count: number }>(
            "SELECT COUNT(*) AS count FROM vibe_event WHERE type = 'session.compacted' AND json_extract(payload_json, '$.sessionId') = ?",
          )
          .get(session.id)?.count ?? 0
      );
    if (!session.cardId) return 0;
    return store.events
      .list(session.cardId)
      .filter(
        (event) =>
          event.type === "compaction" &&
          (event.body as { sessionId?: string })?.sessionId === session.id,
      ).length;
  };
  const sleep = (ms: number) =>
    ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

  /** Re-classifies the session from usage_event and stores it (emits an event on change). */
  async function refreshComplexity(
    s: AgentSession,
    agent: AgentInfo,
  ): Promise<AgentSession["complexity"]> {
    const cx = options.config().complexity;
    if (!cx?.enabled || !options.usageDb || !host.cliSessionIds) return s.complexity;
    let ids = cliIds.get(agent.id) ?? [];
    if (ids.length === 0) {
      ids = await host.cliSessionIds(agent.id);
      cliIds.set(agent.id, ids);
    }
    const state = readState(options.usageDb, s.id);
    const calls = queryCallUsage(options.usageDb, ids, state.baselineTs);
    let next = classifyComplexity(buildTurnStats(state.windows, calls), cx);
    if (next === "short" && state.floor === "multi") next = "multi"; // inherited through a handoff
    if (next !== s.complexity) store.sessions.setComplexity(s.id, next);
    // New agents in this directory (agent.create injection) start with the matching budget.
    setTightBudget(options.usageDb, agent.cwd, next === "short" ? null : cx.tightMemoryTokens);
    return next;
  }

  function recordLegacyHandoff(s: AgentSession, next: AgentSession, newAgentId: string) {
    if (s.cardId) {
      // A cold context preserves the current model, including its place in the fallback order.
      const selection = store.events
        .list(s.cardId)
        .map(
          (event) =>
            event.body as {
              kind?: string;
              sessionId?: string;
            } | null,
        )
        .toReversed()
        .find((body) => body?.kind === "model_selected" && body.sessionId === s.id);
      if (selection)
        store.events.add({
          cardId: s.cardId,
          type: "status",
          authorKind: "system",
          author: "context",
          body: { ...selection, sessionId: next.id },
        });
      if (s.role === "subagent") {
        const card = store.cards.get(s.cardId);
        const subtaskId = Object.entries(card?.subtaskRuns ?? {}).find(
          ([, run]) => run.sessionId === s.id,
        )?.[0];
        if (subtaskId)
          store.cards.setSubtaskRun(s.cardId, subtaskId, {
            sessionId: next.id,
            agentId: newAgentId,
          });
      }
    }
  }

  async function flow(
    s: AgentSession,
    agent: AgentInfo,
    opts: { forceHandoff: boolean; tight: boolean; wasLong: boolean },
  ): Promise<"compact" | "handoff" | "requested" | "failed" | "deferred"> {
    const sessionPrompts: PromptResolver = {
      resolve: (key, input = {}) => prompts().resolve(key, { projectId: s.projectId, ...input }),
    };
    const mdPath = createLayout(agent.cwd).sessionMd(s.cardId ?? s.id);
    mkdirSync(dirname(mdPath), { recursive: true });
    // The lifecycle hooks that mark the session idle can trail the end of the turn by a moment.
    const stillIdle = async () => {
      for (let i = 0; i < 20; i++) {
        const state = store.sessions.get(s.id)?.state;
        if (state === "idle") return true;
        if (state !== "working") return false;
        await sleep(options.pollMs ?? 150);
      }
      return false;
    };

    const notes = await host.run(agent.id, notesPrompt(mdPath, s.cardId, sessionPrompts));
    // Waiting for an approval is not a failure: try again once the user has answered.
    if (notes.status === "permission") return "deferred";
    if (notes.status !== "idle" || !(await stillIdle())) return "failed";
    const tightTokens = opts.tight ? options.config().complexity?.tightMemoryTokens : undefined;
    const block = options.buildContext(agent.cwd, tightTokens, s.projectId);

    const config = options.config();
    if (opts.forceHandoff || !canCompact(config, agent.provider)) {
      if (!s.cardId && s.workspaceId) {
        if (!host.requestHandoff)
          throw new Error("工作区交接需要任务编排插件支持，请升级任务流程插件");
        await host.requestHandoff(s, coldStartPrompt(s.id, mdPath, block, sessionPrompts));
        return "requested";
      }
      const newAgentId = await host.handoff(agent, coldStartPrompt(s.id, mdPath, block, prompts()));
      const next = store.sessions.start({
        cardId: s.cardId,
        agentId: newAgentId,
        workspaceId: s.workspaceId,
        role: s.role,
        provider: s.currentProvider,
      });
      recordLegacyHandoff(s, next, newAgentId);
      if (options.usageDb && options.config().complexity?.enabled) {
        // The new session inherits the complexity (a "long" one as "multi": its context is fresh)
        // and the early-compaction count; its turn counting starts at zero.
        const old = readState(options.usageDb, s.id);
        const inherited = s.complexity === "long" ? "multi" : s.complexity;
        writeState(options.usageDb, next.id, {
          windows: [],
          baselineTs: new Date(now()).toISOString(),
          longCompactions: old.longCompactions + (opts.wasLong ? 1 : 0),
          floor: inherited === "multi" ? "multi" : null,
        });
        if (inherited) store.sessions.setComplexity(next.id, inherited);
      }
      store.sessions.recordCompaction(s.id, "handoff");
      store.sessions.setState(s.id, "ended", { outcome: "handoff" });
      await host.archive(agent.id);
      return "handoff";
    }

    const before = compactionEvents(s);
    const compact = await host.run(agent.id, compactCommandFor(config, agent.provider));
    if (compact.status === "permission") return "deferred";
    if (compact.status !== "idle" || !(await stillIdle())) return "failed";
    await sleep(options.settleMs ?? 1500);
    if (compactionEvents(s) === before) store.sessions.recordCompaction(s.id, "compact");
    if (options.usageDb) {
      // The context restarts small: count turns and usage from here.
      updateState(options.usageDb, s.id, (st) => {
        st.windows = [];
        st.baselineTs = new Date(now()).toISOString();
        if (opts.wasLong) st.longCompactions += 1;
      });
    }
    if (await stillIdle()) await host.run(agent.id, restorePrompt(block, sessionPrompts));
    return "compact";
  }

  async function idleAgent(s: AgentSession) {
    let agent = agents.get(s.agentId);
    if (!agent && host.describeIdleAgent) {
      try {
        agent = (await host.describeIdleAgent(s.agentId)) ?? undefined;
        if (agent) track(agent);
      } catch {
        /* Unknown native state stays untracked. */
      }
    }
    return agent;
  }

  return {
    setNativeClaude: (value: boolean) => void (nativeClaude = value),
    /** A real turn begins: the idle period is over (turns we start ourselves do not count). */
    onTurnStarted(agent: AgentInfo) {
      track(agent);
      turnStart.set(agent.id, now());
      if (busy.has(agent.id) || options.isSystemTurn?.(agent.id)) systemTurns.add(agent.id);
      else systemTurns.delete(agent.id);
      const s = store.sessions.getByAgent(agent.id);
      if (s && !busy.has(agent.id)) compacted.delete(s.id);
    },
    /** Round over: the cache was just written, so it expires one TTL from now. */
    onTurnEnded(agent: AgentInfo) {
      track(agent);
      const s = store.sessions.getByAgent(agent.id);
      if (!s) return;
      const t = now();
      const started = turnStart.get(agent.id) ?? t - 5 * 60_000; // missed the start (restart)
      turnStart.delete(agent.id);
      const system = systemTurns.delete(agent.id) || busy.has(agent.id);
      if (!system && options.usageDb && options.config().complexity?.enabled) {
        updateState(options.usageDb, s.id, (st) => void st.windows.push([started, t]));
      }
      store.sessions.touch(s.id, {
        cacheExpiresAt: new Date(t + ttlFor(options.config(), agent.provider) * 1000).toISOString(),
        lastActivityAt: new Date(t).toISOString(),
      });
    },
    onAgentGone(agentId: string) {
      agents.delete(agentId);
      cliIds.delete(agentId);
    },
    /** Re-classify one agent's session now (call after a turn; usage rows may lag, tick retries). */
    async refreshComplexity(agent: AgentInfo) {
      const s = store.sessions.getByAgent(agent.id);
      return s ? refreshComplexity(s, agent) : null;
    },

    /** One check over all idle sessions; call it on an interval. */
    async tick(): Promise<TickOutcome[]> {
      const config = options.config();
      const out: TickOutcome[] = [];
      if (!config.enabled) return out;
      for (const s of store.sessions
        .list({ states: ["idle"] })
        .filter((session) => options.includeLegacyCards || !session.cardId)) {
        const skipped = (reason: Skipped) =>
          out.push({ sessionId: s.id, action: "skipped", reason });

        const agent = await idleAgent(s);
        if (!agent || busy.has(agent.id)) {
          skipped("untracked");
          continue;
        }
        if (nativeClaude && baseProvider(agent.provider) === "claude") {
          skipped("native");
          continue;
        }
        const cx = config.complexity;
        let complexity = s.complexity;
        try {
          complexity = await refreshComplexity(s, agent);
        } catch (error) {
          log(`vibe-context: complexity failed for session ${s.id}: ${String(error)}`);
        }
        const isLong = !!cx?.enabled && complexity === "long";
        const force = isLong && cx.earlyCompactLong;
        const reason = skipReason({
          state: s.state,
          cacheExpiresAtMs: s.cacheExpiresAt ? Date.parse(s.cacheExpiresAt) : null,
          nowMs: now(),
          marginMs: marginFor(config, ttlFor(config, agent.provider)) * 1000,
          alreadyCompacted: compacted.has(s.id),
          force,
        });
        if (reason) {
          skipped(reason);
          continue;
        }
        compacted.add(s.id); // once per idle period, whatever the outcome
        busy.add(agent.id);
        try {
          const done = options.usageDb ? readState(options.usageDb, s.id).longCompactions : 0;
          const action = await flow(s, agent, {
            forceHandoff: force && done >= (cx?.handoffAfterCompactions ?? 2),
            tight: !!cx?.enabled && (complexity === "multi" || complexity === "long"),
            wasLong: isLong,
          });
          if (action === "failed") skipped("failed");
          else if (action === "deferred") {
            compacted.delete(s.id);
            skipped("deferred");
          } else out.push({ sessionId: s.id, action });
          log(`vibe-context: compaction ${action} for session ${s.id}`);
        } catch (error) {
          log(`vibe-context: compaction failed for session ${s.id}: ${String(error)}`);
          skipped("failed");
        } finally {
          busy.delete(agent.id);
        }
      }
      return out;
    },
  };
}

export type CompactionScheduler = ReturnType<typeof createCompactionScheduler>;
