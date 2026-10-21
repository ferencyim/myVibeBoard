// Stall watchdog (WP-82): a working/starting session with no agent output for too long is marked
// stalled (sessions.markStalled -> session.stalled event -> card badge + push). The marker is not
// a session state; activity (touchActivity) or the session ending clears it.
//
// Paseo has no per-item hook, so activity comes from two places: the turn/permission hooks in
// lifecycle (they call touchActivity) and this poll, which reads the timestamp of the agent's newest
// timeline item. Waiting for a permission/question is the session state `waiting` (never listed here).

import type { PaseoApi } from "@getpaseo/client";
import type { AgentSession } from "../vibe/contract";
import type { BoardService } from "../service";
import { defaultPrompts, type PromptResolver } from "../prompts";

export interface StallConfig {
  enabled: boolean;
  minutes: number;
  /** provider id -> minutes, overrides `minutes`. */
  providerMinutes: Record<string, number>;
  /** Minutes of being stalled after which the agent is interrupted and told to continue (0 = never). */
  autoInterruptMinutes: number;
}

export const DEFAULT_STALL_CONFIG: StallConfig = {
  enabled: true,
  minutes: 10,
  providerMinutes: {},
  autoInterruptMinutes: 0,
};

/** Roles that run turns on behalf of a card; the long-lived master has its own flows. */
export const STALL_ROLES: readonly string[] = ["worker", "verifier", "reviewer", "planner"];

/** Default text of the "continue" nudge (the owner may override it, see server/prompts). */
export const CONTINUE_PROMPT = defaultPrompts.resolve("board.watchdog_continue");

/** "claude=15, codex=8" -> { claude: 15, codex: 8 }; malformed pairs are ignored. */
export function parseProviderMinutes(text: string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of (text ?? "").split(/[,;\s]+/)) {
    const [provider, value] = part.split("=");
    const minutes = Number(value);
    if (provider && Number.isFinite(minutes) && minutes > 0) out[provider.trim().toLowerCase()] = minutes;
  }
  return out;
}

export const stallThresholdMs = (config: StallConfig, provider: string) =>
  (config.providerMinutes[provider.toLowerCase()] ?? config.minutes) * 60_000;

/** Only touch the row when the agent moved at least this far past the recorded activity (limits sync churn). */
const TOUCH_GRANULARITY_MS = 15_000;

export interface WatchdogOptions {
  board: BoardService;
  getPaseo: () => Pick<PaseoApi, "agents"> | null;
  getConfig: () => Promise<StallConfig> | StallConfig;
  now?: () => number;
  prompts?: PromptResolver;
  log?: (message: string, error?: unknown) => void;
}

export function createWatchdog(options: WatchdogOptions) {
  const { store } = options.board;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((m, e) => console.error(`[vibe-board watchdog] ${m}`, e ?? ""));
  /** `sessionId:stalledSince` already interrupted once */
  const interrupted = new Set<string>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  /**
   * Time of the newest timeline item (the agent's real output) the daemon holds, or null when it
   * cannot tell. The snapshot's `updatedAt` is no use: reading the agent itself bumps it.
   */
  async function agentActivity(
    paseo: Pick<PaseoApi, "agents"> | null,
    session: AgentSession,
  ): Promise<number | null> {
    if (!paseo) return null;
    try {
      const page = await paseo.agents
        .ref(session.agentId)
        .timeline.refetch({ direction: "tail", limit: 1, projection: "projected" });
      const at = Date.parse(String(page.entries.at(-1)?.timestamp ?? ""));
      return Number.isFinite(at) ? at : null;
    } catch {
      return null;
    }
  }

  async function check(session: AgentSession, config: StallConfig, paseo: Pick<PaseoApi, "agents"> | null) {
    const activity = await agentActivity(paseo, session);
    let current = store.sessions.get(session.id);
    if (!current || (current.state !== "working" && current.state !== "starting")) return;
    const recorded = Date.parse(current.lastActivityAt);
    if (activity !== null && activity > recorded + TOUCH_GRANULARITY_MS) {
      current = store.sessions.touchActivity(current.id, new Date(activity).toISOString());
    }
    const idleMs = now() - Date.parse(current.lastActivityAt);
    if (!current.stalledSince) {
      if (idleMs >= stallThresholdMs(config, current.currentProvider)) {
        store.sessions.markStalled(current.id, { since: new Date(now()).toISOString(), idleMs });
      }
      return;
    }
    // Already stalled: optionally nudge once.
    const key = `${current.id}:${current.stalledSince}`;
    if (
      config.autoInterruptMinutes > 0 &&
      !interrupted.has(key) &&
      now() - Date.parse(current.stalledSince) >= config.autoInterruptMinutes * 60_000 &&
      paseo
    ) {
      interrupted.add(key);
      const card = current.cardId ? store.cards.get(current.cardId) : undefined;
      // The default active-turn behaviour of send() interrupts the running turn first.
      await paseo.agents.ref(current.agentId).send(
        (options.prompts ?? defaultPrompts).resolve("board.watchdog_continue", {
          projectId: card?.projectId,
        }),
      );
      if (current.cardId) {
        store.events.add({
          cardId: current.cardId,
          type: "status",
          authorKind: "system",
          author: "watchdog",
          body: { kind: "stall_interrupted", sessionId: current.id, text: "Interrupted a stalled agent and asked it to continue." },
        });
      }
      store.sessions.touchActivity(current.id);
    }
  }

  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const config = await options.getConfig();
      if (!config.enabled) return;
      const paseo = options.getPaseo();
      const sessions = store.sessions
        .list({ states: ["starting", "working"] })
        .filter((s) => STALL_ROLES.includes(s.role));
      for (const session of sessions) {
        try {
          await check(session, config, paseo);
        } catch (error) {
          log(`check ${session.id} failed`, error);
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    tick,
    start(intervalMs = 30_000) {
      if (!timer) {
        timer = setInterval(() => void tick().catch((e) => log("tick failed", e)), intervalMs);
        (timer as unknown as { unref?: () => void }).unref?.();
      }
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

export type Watchdog = ReturnType<typeof createWatchdog>;
