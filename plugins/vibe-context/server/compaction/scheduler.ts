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
import type { VibeStore } from "../vibe/db";
import {
  baseProvider,
  DEFAULT_TTL_SECONDS,
  FALLBACK_TTL_SECONDS,
  marginSeconds,
  skipReason,
  supportsCompact,
  type SkipReason,
} from "./policy";

export interface AgentInfo {
  id: string;
  provider: string;
  cwd: string;
}

/** What the scheduler needs from the daemon; tests pass a fake. */
export interface CompactionHost {
  /** Sends a prompt and resolves with how the turn ended; "permission" only after giving up on an approval. */
  run(
    agentId: string,
    text: string,
  ): Promise<{ status: "idle" | "error" | "permission" | "timeout" }>;
  /** Starts a fresh agent of the same kind with this prompt; returns its agent id. */
  handoff(agent: AgentInfo, prompt: string): Promise<string>;
  archive(agentId: string): Promise<void>;
}

export interface CompactionConfig {
  enabled: boolean;
  ttlSeconds: Record<string, number>;
  marginSeconds?: number;
}

export interface SchedulerOptions {
  store: Pick<VibeStore, "sessions" | "events">;
  host: CompactionHost;
  config: () => CompactionConfig;
  /** Project goals + PROJECT_STATE.md block for a working directory (server/inject). */
  buildContext: (cwd: string) => string | null;
  now?: () => number;
  /** Grace after `/compact` before checking whether the board lifecycle recorded the event. */
  settleMs?: number;
  /** Poll interval while waiting for the session to be marked idle again. */
  pollMs?: number;
  /** Claude Code compacts idle sessions itself: leave claude alone. */
  nativeClaude?: boolean;
  log?: (message: string) => void;
}

type Skipped = SkipReason | "native" | "untracked" | "failed" | "deferred";
export type TickOutcome =
  | { sessionId: string; action: "compact" | "handoff" }
  | { sessionId: string; action: "skipped"; reason: Skipped };

export const ttlFor = (config: CompactionConfig, provider: string): number => {
  const id = baseProvider(provider);
  return config.ttlSeconds[id] ?? DEFAULT_TTL_SECONDS[id] ?? FALLBACK_TTL_SECONDS;
};

export function notesPrompt(mdPath: string, cardRef?: string | null): string {
  return (
    "Your context is about to be compacted. Before that, save your progress notes: the goal, " +
    "what is done, what is in progress, next steps, key files and decisions, open questions. " +
    "Use the `vibe_session_note` tool of the `vibe-board` MCP server" +
    (cardRef ? ` with key "${cardRef}"` : "") +
    " (it overwrites " +
    `\`${mdPath}\` and needs no approval); only if that tool does not exist, write that file ` +
    'yourself (create or overwrite it). Do nothing else. Reply "saved" when done.'
  );
}

export function restorePrompt(block: string | null): string {
  return (
    "Context was compacted. The project context below is authoritative; continue from your " +
    `session notes. Reply "ok" only.\n\n${block ?? "(no project context)"}`
  );
}

export function coldStartPrompt(
  oldSessionId: string,
  mdPath: string,
  block: string | null,
): string {
  return (
    `You continue session ${oldSessionId}, handed over because its context cache expires. ` +
    `Read \`${mdPath}\` for its progress and the files under \`.vibe/\` for project memory, ` +
    `then carry on with the task.${block ? `\n\n${block}` : ""}`
  );
}

export function createCompactionScheduler(options: SchedulerOptions) {
  const { store, host } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  let nativeClaude = options.nativeClaude ?? false;
  const agents = new Map<string, AgentInfo>();
  const compacted = new Set<string>(); // session ids handled in the current idle period
  const busy = new Set<string>(); // agent ids with a compaction flow in flight

  const track = (agent: AgentInfo) =>
    void agents.set(agent.id, { id: agent.id, provider: agent.provider, cwd: agent.cwd });
  const compactionEvents = (s: AgentSession) =>
    s.cardId
      ? store.events
          .list(s.cardId)
          .filter(
            (e) => e.type === "compaction" && (e.body as { sessionId?: string })?.sessionId === s.id,
          ).length
      : 0;
  const sleep = (ms: number) =>
    ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

  async function flow(s: AgentSession, agent: AgentInfo): Promise<"compact" | "handoff" | "failed" | "deferred"> {
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

    const notes = await host.run(agent.id, notesPrompt(mdPath, s.cardId));
    // Waiting for an approval is not a failure: try again once the user has answered.
    if (notes.status === "permission") return "deferred";
    if (notes.status !== "idle" || !(await stillIdle())) return "failed";
    const block = options.buildContext(agent.cwd);

    if (!supportsCompact(agent.provider)) {
      const newAgentId = await host.handoff(agent, coldStartPrompt(s.id, mdPath, block));
      store.sessions.start({
        cardId: s.cardId,
        agentId: newAgentId,
        workspaceId: s.workspaceId,
        role: s.role,
        provider: s.currentProvider,
      });
      store.sessions.recordCompaction(s.id, "handoff");
      store.sessions.setState(s.id, "ended", { outcome: "handoff" });
      await host.archive(agent.id);
      return "handoff";
    }

    const before = compactionEvents(s);
    if ((await host.run(agent.id, "/compact")).status === "error") return "failed";
    await sleep(options.settleMs ?? 1500);
    if (compactionEvents(s) === before) store.sessions.recordCompaction(s.id, "compact");
    if (await stillIdle()) await host.run(agent.id, restorePrompt(block));
    return "compact";
  }

  return {
    setNativeClaude: (value: boolean) => void (nativeClaude = value),
    /** A real turn begins: the idle period is over (turns we start ourselves do not count). */
    onTurnStarted(agent: AgentInfo) {
      track(agent);
      const s = store.sessions.getByAgent(agent.id);
      if (s && !busy.has(agent.id)) compacted.delete(s.id);
    },
    /** Round over: the cache was just written, so it expires one TTL from now. */
    onTurnEnded(agent: AgentInfo) {
      track(agent);
      const s = store.sessions.getByAgent(agent.id);
      if (!s) return;
      const t = now();
      store.sessions.touch(s.id, {
        cacheExpiresAt: new Date(t + ttlFor(options.config(), agent.provider) * 1000).toISOString(),
        lastActivityAt: new Date(t).toISOString(),
      });
    },
    onAgentGone: (agentId: string) => void agents.delete(agentId),

    /** One check over all idle sessions; call it on an interval. */
    async tick(): Promise<TickOutcome[]> {
      const config = options.config();
      const out: TickOutcome[] = [];
      if (!config.enabled) return out;
      for (const s of store.sessions.list({ states: ["idle"] })) {
        const skipped = (reason: Skipped) => out.push({ sessionId: s.id, action: "skipped", reason });
        const agent = agents.get(s.agentId);
        if (!agent || busy.has(agent.id)) {
          skipped("untracked");
          continue;
        }
        if (nativeClaude && baseProvider(agent.provider) === "claude") {
          skipped("native");
          continue;
        }
        const reason = skipReason({
          state: s.state,
          cacheExpiresAtMs: s.cacheExpiresAt ? Date.parse(s.cacheExpiresAt) : null,
          nowMs: now(),
          marginMs:
            (config.marginSeconds ?? marginSeconds(ttlFor(config, agent.provider))) * 1000,
          alreadyCompacted: compacted.has(s.id),
        });
        if (reason) {
          skipped(reason);
          continue;
        }
        compacted.add(s.id); // once per idle period, whatever the outcome
        busy.add(agent.id);
        try {
          const action = await flow(s, agent);
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
