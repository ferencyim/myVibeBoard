// Offline replies to agent questions. The phone queues the answer while offline (PendingReplyQueue,
// vibe-shared/sync); after reconnecting it calls `vibe.reply.check` and, only when the question is
// still open, `vibe.reply.send`. The daemon re-verifies in `send` as well (the question may have
// been answered between the two calls) and delivers each reply id at most once.

import type { PaseoApi } from "@getpaseo/client";
import type { VibeDb, VibeStore } from "../vibe/db";
import type { QuestionState } from "../vibe/sync";

export interface ReplyInput {
  /** Idempotency key (the queue's reply id). */
  id: string;
  cardId: string;
  /** Permission/question request id as shown in agent_session.pending_question_json. */
  questionId: string;
  text: string;
}

interface OpenQuestion {
  agentId: string;
  kind: string;
  input: unknown;
}

interface SessionRow {
  agent_id: string;
  state: string;
  pending_question_json: string | null;
}

const ALLOW = /^(y|yes|ok|allow|approve|同意|允许|是|好)$/i;

export class ReplyError extends Error {
  constructor(
    readonly code: "stale" | "unavailable",
    message: string,
  ) {
    super(`[${code}] ${message}`);
  }
}

export interface ReplyServiceOptions {
  db: VibeDb;
  store: VibeStore;
  getPaseo: () => PaseoApi | null;
}

export function createReplyService({ db, store, getPaseo }: ReplyServiceOptions) {
  function liveSessions(cardId: string): SessionRow[] {
    return db
      .prepare<SessionRow>(
        "SELECT agent_id, state, pending_question_json FROM agent_session WHERE card_id = ? AND state NOT IN ('ended','error')",
      )
      .all(cardId);
  }

  /** Where is the question? `open` when it still waits; `live` says whether any session is left. */
  async function locate(
    cardId: string,
    questionId: string,
  ): Promise<{ open?: OpenQuestion; live: boolean }> {
    const sessions = liveSessions(cardId);
    const paseo = getPaseo();
    for (const s of sessions) {
      if (paseo) {
        try {
          const handle = paseo.agents.ref(s.agent_id);
          await handle.refresh();
          const perms = (handle.current()?.pendingPermissions ?? []) as unknown as Array<{
            id: string;
            kind?: string;
            input?: unknown;
          }>;
          const hit = perms.find((p) => p.id === questionId);
          if (hit) return { open: { agentId: s.agent_id, kind: hit.kind ?? "tool", input: hit.input }, live: true };
          continue; // authoritative: the agent has no such request pending
        } catch {
          // daemon cannot tell: fall back to what the lifecycle recorded
        }
      }
      try {
        const q = s.pending_question_json ? JSON.parse(s.pending_question_json) : null;
        if (s.state === "waiting" && q?.requestId === questionId) {
          return { open: { agentId: s.agent_id, kind: q.kind ?? "tool", input: q.input }, live: true };
        }
      } catch {
        // malformed record: treat as not pending
      }
    }
    return { live: sessions.length > 0 };
  }

  const sentKey = (id: string) => `reply_sent:${id}`;

  return {
    /** Is the question still waiting for an answer? */
    async check(input: ReplyInput): Promise<{ state: QuestionState }> {
      if (db.prepare("SELECT 1 AS x FROM vibe_meta WHERE key = ?").get(sentKey(input.id))) {
        return { state: "answered" };
      }
      const { open, live } = await locate(input.cardId, input.questionId);
      return { state: open ? "pending" : live ? "answered" : "gone" };
    },

    /** Deliver the reply to the agent. Idempotent per reply id; throws [stale] if no longer open. */
    async send(input: ReplyInput): Promise<{ sent: boolean; duplicate: boolean }> {
      if (db.prepare("SELECT 1 AS x FROM vibe_meta WHERE key = ?").get(sentKey(input.id))) {
        return { sent: true, duplicate: true };
      }
      const { open } = await locate(input.cardId, input.questionId);
      if (!open) throw new ReplyError("stale", "The question is no longer waiting for an answer");
      const paseo = getPaseo();
      if (!paseo) throw new ReplyError("unavailable", "The daemon handle is not available yet; retry");

      const base = (open.input && typeof open.input === "object" ? open.input : {}) as {
        questions?: Array<{ question?: string }>;
      };
      const response =
        open.kind === "question"
          ? {
              behavior: "allow" as const,
              updatedInput: {
                ...base,
                answers: Object.fromEntries(
                  (base.questions ?? []).map((q) => [q.question ?? "", input.text]),
                ),
              },
            }
          : ALLOW.test(input.text.trim())
            ? { behavior: "allow" as const }
            : { behavior: "deny" as const, message: input.text };
      await paseo.agents
        .ref(open.agentId)
        .respondToPermission({ requestId: input.questionId, response: response as never });

      db.prepare("INSERT OR IGNORE INTO vibe_meta (key, value) VALUES (?, ?)").run(
        sentKey(input.id),
        new Date().toISOString(),
      );
      try {
        store.events.add({
          cardId: input.cardId,
          type: "note",
          authorKind: "user",
          author: "phone",
          body: { kind: "reply", questionId: input.questionId, text: input.text },
        });
      } catch {
        // the card vanished meanwhile; the answer itself was delivered
      }
      return { sent: true, duplicate: false };
    },
  };
}

export type ReplyService = ReturnType<typeof createReplyService>;
