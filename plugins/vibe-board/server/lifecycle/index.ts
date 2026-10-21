// Lifecycle linkage (WP-12): turns Paseo agent events into session state, card events and column
// moves, all through the shared command layer (so every change also lands on the vibe_event bus
// that push notifications and the stats plugin subscribe to).
//
//   turn_started            session -> working; a verifying card goes back to in_progress
//                           (the user continued the session). A turn a plugin announced with
//                           expectSystemTurn() (compaction, ...) only updates the session state.
//   turn_ended completed    session -> idle; no open question -> card in_progress -> verifying
//                           (not after a system turn); the last assistant message is written to the
//                           group chat (chat(executor, summary), once per session and turn)
//   turn_ended failed       a provider-side failure (quota, login, provider/model unavailable) of a worker is
//                           handed to options.onFailure (failover to the preset's fallback chain); otherwise,
//                           or when nothing took over, session -> error (the badge shows the error)
//   every hook above        touchActivity: feeds the stall watchdog and clears a stalled mark
//   permission_requested    a worker writing .vibe/sessions/*.md in its worktree is approved at once;
//                           otherwise session -> waiting (waiting_since + pending_question: the red dot)
//                           and the question goes to the card's group chat (chat(executor, question))
//   permission_resolved     last pending request resolved -> session -> working (session.answered)
//   agent.closed/archived   session -> ended
//   completed compaction    compaction card event
//   session_open(import)    agent switched inside the card (switch-provider): switch card event
//
// Handlers never throw into the daemon: failures are logged and swallowed.

import type { PaseoApi } from "@getpaseo/client";
import type { PluginLifecycleRegistration } from "@getpaseo/plugin/server";
import type { AgentSession, SessionState } from "../vibe/contract";
import { createHash } from "node:crypto";
import { lastAssistantText, questionSummary } from "../chat/format";
import { postChat } from "../chat/post";
import type { AgentTracker } from "../dispatch";
import type { BoardService } from "../service";
import { approveSessionNoteWrite, mayWriteFile } from "./auto-approve";
import { classifyFailure, isReassignable, type FailureCategory } from "./error-class";
import { consumeSystemTurn } from "./system-turn";

export type LifecycleRegistration = Pick<PluginLifecycleRegistration, "on" | "before">;

export interface LifecycleOptions {
  board: BoardService;
  /** Receives the SDK handle every hook carries (dispatch needs one outside hooks). */
  onPaseo?: (paseo: PaseoApi) => void;
  log?: (message: string, error?: unknown) => void;
  /** Directory of the system-turn markers (default `$VIBE_HOME/system-turns`; tests override). */
  systemTurnDir?: string;
  /**
   * A worker's turn failed for a reassignable reason. Resolve true when another agent took over
   * (the session was ended as reassigned); false/throw leaves the session in `error`.
   */
  onFailure?: (
    session: AgentSession,
    failure: { message: string; category: FailureCategory },
  ) => Promise<boolean>;
}

interface Question {
  requestId: string;
  kind: string;
  name: string;
  title?: string;
  description?: string;
  input?: unknown;
}

export interface Lifecycle extends AgentTracker {
  /** An agent was continued on another provider inside the same card session. */
  recordSwitch(input: {
    fromAgentId: string;
    toAgentId: string;
    provider: string;
    reason?: string;
  }): AgentSession | undefined;
  /** Run `fn` while `import` session opens in the workspace are not treated as a provider switch. */
  withoutSwitchRecord<T>(workspaceId: string | null, fn: () => Promise<T>): Promise<T>;
  close(): void;
}

const LIVE_STATES: SessionState[] = ["starting", "working", "waiting", "idle", "error"];

export function registerLifecycle(
  server: LifecycleRegistration,
  options: LifecycleOptions,
): Lifecycle {
  const { store } = options.board;
  const log = options.log ?? ((m, e) => console.error(`[vibe-board lifecycle] ${m}`, e ?? ""));
  /** open permission/question requests per agent */
  const pending = new Map<string, Map<string, Question>>();
  /** agents dispatch is about to bind: their early events wait here */
  const expected = new Map<string, Array<(s: AgentSession) => void>>();
  /** agents whose running turn was started by a plugin, not the user */
  const systemTurns = new Set<string>();
  /** workspaces whose `import` session opens belong to a failover, not to switch-provider */
  const importGuards = new Map<string, number>();

  function safe(label: string, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      log(`${label} failed`, error);
    }
  }

  /** Run `fn` on the agent's session; if dispatch has not bound it yet, replay after bind. */
  function withSession(agentId: string, label: string, fn: (s: AgentSession) => void): void {
    const session = store.sessions.getByAgent(agentId);
    if (session) return safe(label, () => fn(session));
    expected.get(agentId)?.push((s) => safe(label, () => fn(s)));
  }

  function setState(
    s: AgentSession,
    to: SessionState,
    opts: Parameters<typeof store.sessions.setState>[2] = {},
  ) {
    const current = store.sessions.get(s.id) ?? s;
    if (current.state === "ended") return;
    if (current.state === to && to !== "waiting" && to !== "error") return;
    store.sessions.setState(s.id, to, opts);
  }

  /** Agent output / progress: feeds the stall watchdog, clears a stalled mark. */
  function touch(s: AgentSession) {
    const current = store.sessions.get(s.id) ?? s;
    if (current.state !== "ended") store.sessions.touchActivity(s.id);
  }

  function moveCard(s: AgentSession, to: "verifying" | "in_progress", reason: string) {
    if (s.role !== "worker" || !s.cardId) return;
    const card = store.cards.get(s.cardId);
    const from = to === "verifying" ? "in_progress" : "verifying";
    if (card?.column === from) store.cards.move(card.id, { to, actor: "lifecycle", reason });
  }

  function syncCompactions(s: AgentSession, completed: number) {
    if (!s.cardId || completed === 0) return;
    const recorded = store.events
      .list(s.cardId)
      .filter((e) => e.type === "compaction" && (e.body as { sessionId?: string })?.sessionId === s.id)
      .length;
    for (let i = recorded; i < completed; i++) store.sessions.recordCompaction(s.id, "auto");
  }

  /** The executor's last message of a finished round, for the card's group chat (idempotent per turn). */
  function summarizeTurn(
    s: AgentSession,
    turnId: string | null,
    timeline: readonly { type: string; text?: unknown }[],
  ) {
    if (s.role !== "worker" || !s.cardId) return;
    const text = lastAssistantText(timeline);
    if (!text) return;
    const turn = turnId ?? createHash("sha256").update(text).digest("hex").slice(0, 12);
    postChat(
      store,
      {
        cardId: s.cardId,
        authorKind: "executor",
        author: s.currentProvider,
        kind: "summary",
        text,
        agentId: s.agentId,
        sessionId: s.id,
        key: `summary:${s.id}:${turn}`,
      },
      log,
    );
  }

  /** The executor waits for the owner: say so in the group chat (once per request). */
  function askInChat(s: AgentSession, request: Question) {
    if (s.role !== "worker" || !s.cardId) return;
    postChat(
      store,
      {
        cardId: s.cardId,
        authorKind: "executor",
        author: s.currentProvider,
        kind: "question",
        text: questionSummary(request),
        agentId: s.agentId,
        sessionId: s.id,
        key: `question:${s.id}:${request.requestId}`,
      },
      log,
    );
  }

  function end(agentId: string, outcome: string) {
    pending.delete(agentId);
    systemTurns.delete(agentId);
    withSession(agentId, outcome, (s) => setState(s, "ended", { outcome }));
  }

  const lifecycle: Lifecycle = {
    expect: (agentId) => void expected.set(agentId, []),
    async bind(agentId) {
      const queue = expected.get(agentId) ?? [];
      expected.delete(agentId);
      const session = store.sessions.getByAgent(agentId);
      if (session) for (const replay of queue) replay(session);
    },
    release: (agentId) => void expected.delete(agentId),

    recordSwitch({ fromAgentId, toAgentId, provider, reason }) {
      const from = store.sessions.getByAgent(fromAgentId);
      if (!from || store.sessions.getByAgent(toAgentId)) return undefined;
      store.sessions.switchProvider(from.id, provider, reason);
      const next = store.sessions.start({
        cardId: from.cardId,
        agentId: toAgentId,
        workspaceId: from.workspaceId,
        role: from.role,
        provider,
      });
      pending.delete(fromAgentId);
      if (from.state !== "ended") store.sessions.setState(from.id, "ended", { outcome: "switched" });
      return next;
    },

    async withoutSwitchRecord(workspaceId, fn) {
      if (!workspaceId) return fn();
      importGuards.set(workspaceId, (importGuards.get(workspaceId) ?? 0) + 1);
      try {
        return await fn();
      } finally {
        const left = (importGuards.get(workspaceId) ?? 1) - 1;
        if (left > 0) importGuards.set(workspaceId, left);
        else importGuards.delete(workspaceId);
      }
    },

    close() {
      for (const off of offs) off();
    },
  };

  const offs = [
    server.on("agent.created", (_event, { paseo }) => options.onPaseo?.(paseo)),

    server.on("agent.turn_started", ({ agent }, { paseo }) => {
      options.onPaseo?.(paseo);
      const system = consumeSystemTurn(agent.id, options.systemTurnDir);
      if (system) systemTurns.add(agent.id);
      withSession(agent.id, "turn_started", (s) => {
        pending.delete(agent.id);
        setState(s, "working");
        touch(s);
        if (!system) moveCard(s, "in_progress", "user continued the session");
      });
    }),

    server.on("agent.turn_ended", ({ agent, turnId, outcome, timeline }, { paseo }) => {
      options.onPaseo?.(paseo);
      const system = systemTurns.delete(agent.id);
      withSession(agent.id, "turn_ended", (s) => {
        if (outcome.kind === "failed") {
          pending.delete(agent.id);
          const message = outcome.error.message;
          const category = classifyFailure(message, outcome.error.code);
          if (s.role === "worker" && options.onFailure && isReassignable(category)) {
            // Async: the session stays as it is until a fallback took over or none did.
            void options
              .onFailure(s, { message, category })
              .catch((error) => {
                log("failover failed", error);
                return false;
              })
              .then((taken) => {
                if (!taken) safe("turn_failed", () => setState(s, "error", { message }));
              });
            return;
          }
          setState(s, "error", { message });
          return;
        }
        syncCompactions(
          s,
          timeline.filter((i) => i.type === "compaction" && i.status === "completed").length,
        );
        if (pending.get(agent.id)?.size) return; // still waiting for an answer
        if ((store.sessions.get(s.id) ?? s).state === "waiting") return;
        setState(s, "idle", { outcome: outcome.kind });
        touch(s);
        if (outcome.kind === "completed" && !system) {
          summarizeTurn(s, turnId, timeline);
          moveCard(s, "verifying", "round completed, no open question");
        }
      });
    }),

    server.on("agent.permission_requested", ({ agent, request }, { paseo }) => {
      options.onPaseo?.(paseo);
      const markWaiting = () =>
        withSession(agent.id, "permission_requested", (s) => {
          const question: Question = {
            requestId: request.id,
            kind: request.kind,
            name: request.name,
            title: request.title,
            description: request.description,
            ...(request.kind === "question" ? { input: request.input } : {}),
          };
          const open = pending.get(agent.id) ?? new Map<string, Question>();
          open.set(request.id, question);
          pending.set(agent.id, open);
          setState(s, "waiting", { question: { ...question, pending: open.size } });
          touch(s); // waiting for the user is never a stall
          askInChat(s, question);
        });
      // Only a worker's file-writing tool request can be a session-note write; the rest stays synchronous.
      const owner = mayWriteFile(request) ? store.sessions.getByAgent(agent.id) : undefined;
      if (owner?.role !== "worker") return markWaiting();
      const card = owner.cardId ? store.cards.get(owner.cardId) : undefined;
      return approveSessionNoteWrite({
        paseo,
        agentId: agent.id,
        request,
        roots: [agent.cwd, card?.worktree ?? ""],
      })
        .catch((error) => {
          log("session-note auto-approval failed", error);
          return false;
        })
        .then((approved) => {
          if (!approved) markWaiting();
        });
    }),

    server.on("agent.permission_resolved", ({ agent, requestId }, { paseo }) => {
      options.onPaseo?.(paseo);
      withSession(agent.id, "permission_resolved", (s) => {
        const open = pending.get(agent.id);
        open?.delete(requestId);
        if (open?.size) return;
        pending.delete(agent.id);
        if ((store.sessions.get(s.id) ?? s).state === "waiting") setState(s, "working");
        touch(s);
      });
    }),

    server.on("agent.closed", ({ agent }) => end(agent.id, "closed")),
    server.on("agent.archived", ({ agent }) => end(agent.id, "archived")),

    // switch-provider imports the converted session as a new agent in the same workspace.
    server.before("agent.session_open", ({ request }) => {
      if (request.reason !== "import" || !request.workspaceId) return;
      if (importGuards.has(request.workspaceId)) return;
      const live = store.sessions
        .list({ states: LIVE_STATES })
        .find((s) => s.workspaceId === request.workspaceId && s.agentId !== request.agentId);
      if (live && live.currentProvider !== request.provider) {
        safe("switch", () =>
          void lifecycle.recordSwitch({
            fromAgentId: live.agentId,
            toAgentId: request.agentId,
            provider: request.provider,
            reason: "switch-provider",
          }),
        );
      }
    }),
  ];

  return lifecycle;
}
