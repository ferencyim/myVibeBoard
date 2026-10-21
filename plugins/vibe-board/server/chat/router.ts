// Chat router: forwards the owner's group-chat messages to the executor while it works.
//
// Routing of an unanswered user chat message (the planner in vibe-master applies the same rule to
// decide what is its own; keep both in step, see docs/vibe/USER-GUIDE.md "群聊"):
//   draft / todo                 -> the master's planning session (vibe-master)
//   in_progress / verifying      -> the executor when a worker session is live
//                                   (starting | working | waiting | idle), else the master
//   done                         -> recorded only
// A forwarded message is marked with a system chat that lists it in `answers`; a message that
// could not be delivered gets a system chat with `fallback`, which hands it to the master.
// The router polls card_event rows (the chat lives there, not on the vibe_event bus) and keeps its
// cursor in vibe_meta, so messages written while the daemon was down are handled after a restart,
// and messages that arrive through the phone sync are handled like RPC ones.

import type { PaseoApi } from "@getpaseo/client";
import type { AgentSession, CardView } from "../vibe/contract";
import type { VibeDb } from "../vibe/db";
import type { BoardService } from "../service";
import type { ReplyService } from "../sync";
import { postChat } from "./post";
import { clip } from "./format";

/** Worker session states in which the executor can receive a message. */
export const EXECUTOR_LIVE_STATES = ["starting", "working", "waiting", "idle"] as const;
const CURSOR_KEY = "chat_router_rowid";
const BATCH = 50;

export type ChatRouterPaseo = Pick<PaseoApi, "agents">;

export interface ChatRouterOptions {
  db: VibeDb;
  board: BoardService;
  getPaseo: () => ChatRouterPaseo | null;
  replies: Pick<ReplyService, "send">;
  pollIntervalMs?: number;
  log?: (message: string, error?: unknown) => void;
}

interface Row {
  rid: number;
  id: string;
  card_id: string;
  body_json: string;
}

/** Who gets a user message on a card in this state: pure, shared by the router and its tests. */
export function routeOf(
  column: CardView["column"],
  executor: AgentSession | undefined,
): "master" | "executor" | "none" {
  if (column === "draft" || column === "todo") return "master";
  if (column === "done") return "none";
  return executor ? "executor" : "master";
}

function questionIdOf(session: AgentSession): string | null {
  const q = session.pendingQuestion as { requestId?: unknown } | null;
  return typeof q?.requestId === "string" ? q.requestId : null;
}

export function createChatRouter(options: ChatRouterOptions) {
  const { db, board } = options;
  const { store } = board;
  const log = options.log ?? ((m, e) => console.error(`[vibe-board chat] ${m}`, e ?? ""));
  let timer: ReturnType<typeof setInterval> | null = null;
  let inflight: Promise<number> | null = null;

  const advance = (rowid: number) =>
    void db
      .prepare(
        "INSERT INTO vibe_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(CURSOR_KEY, String(rowid));

  const cursor = (): number => {
    const stored = db
      .prepare<{ value: string }>("SELECT value FROM vibe_meta WHERE key = ?")
      .get(CURSOR_KEY);
    if (stored) return Number(stored.value);
    // First run: start at the end, never replay the whole history.
    const max = db.prepare<{ m: number | null }>("SELECT MAX(rowid) AS m FROM card_event").get()?.m ?? 0;
    advance(max);
    return max;
  };

  /** A chat event of this card lists the message in `answers`. */
  function answered(cardId: string, messageId: string): boolean {
    return store.events.list(cardId).some((e) => {
      if (e.type !== "chat") return false;
      const answers = (e.body as { answers?: unknown } | null)?.answers;
      return Array.isArray(answers) && answers.includes(messageId);
    });
  }

  const executorOf = (cardId: string) =>
    store.sessions.list({ cardId, role: "worker", states: [...EXECUTOR_LIVE_STATES] }).at(-1);

  /** "done": handled (or not ours); "retry": try again on the next poll. */
  async function handle(row: Row): Promise<"done" | "retry"> {
    const card = store.cards.get(row.card_id);
    if (!card || card.archivedAt) return "done";
    const session = executorOf(card.id);
    if (!session || routeOf(card.column, session) !== "executor") return "done";
    if (answered(card.id, row.id)) return "done";
    const paseo = options.getPaseo();
    if (!paseo) return "retry";

    let text = "";
    try {
      text = String((JSON.parse(row.body_json) as { text?: unknown }).text ?? "");
    } catch {
      return "done";
    }
    if (!text.trim()) return "done";

    const questionId = session.state === "waiting" ? questionIdOf(session) : null;
    try {
      let asAnswer = false;
      if (questionId) {
        try {
          await options.replies.send({ id: row.id, cardId: card.id, questionId, text });
          asAnswer = true;
        } catch {
          // the question is gone or cannot be answered: send the text as a normal message instead
        }
      }
      if (!asAnswer) await paseo.agents.ref(session.agentId).send(text);
      postChat(
        store,
        {
          cardId: card.id,
          authorKind: "system",
          author: "chat-router",
          kind: "info",
          text: asAnswer ? "已作为回答发给执行 agent 的提问。" : "已转发给执行 agent。",
          agentId: session.agentId,
          sessionId: session.id,
          answers: [row.id],
          key: `forward:${row.id}`,
        },
        log,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log(`could not forward ${row.id} to ${session.agentId}`, error);
      postChat(
        store,
        {
          cardId: card.id,
          authorKind: "system",
          author: "chat-router",
          kind: "info",
          text: `没能发给执行 agent（${clip(reason, 200)}），已交给总 agent 处理。`,
          fallback: [row.id],
          key: `forward-failed:${row.id}`,
        },
        log,
      );
    }
    return "done";
  }

  /** Handle new user messages; resolves with the number of rows consumed. */
  function poll(): Promise<number> {
    if (!inflight) {
      inflight = (async () => {
        let consumed = 0;
        for (;;) {
          const rows = db
            .prepare<Row>(
              `SELECT rowid AS rid, id, card_id, body_json FROM card_event
               WHERE rowid > ? AND type = 'chat' AND author_kind = 'user' ORDER BY rowid LIMIT ?`,
            )
            .all(cursor(), BATCH);
          if (rows.length === 0) return consumed;
          for (const row of rows) {
            if ((await handle(row)) === "retry") return consumed;
            advance(row.rid);
            consumed++;
          }
        }
      })()
        .catch((error) => {
          log("chat poll failed", error);
          return 0;
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  }

  return {
    poll,
    start() {
      if (timer) return;
      cursor(); // pin the starting point now
      timer = setInterval(() => void poll(), options.pollIntervalMs ?? 1000);
      (timer as unknown as { unref?: () => void }).unref?.();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await inflight;
    },
  };
}

export type ChatRouter = ReturnType<typeof createChatRouter>;
