// Chat router: forwards the owner's messages of the card's **execution conversation** (WP-105,
// `thread: "exec"`) to the executor. Plan-thread messages belong to the planning session
// (vibe-master/server/planning).
//
//   a live worker session (starting | working | waiting | idle) -> sent to it (an open question is
//                                                                   answered with the text)
//   only an ended worker session                                 -> its agent is resumed and gets it
//                                                                   (continues the card after a finished round)
//   no worker yet / done card / resume failed                    -> a system line says what to do
// A handled message is marked with a system chat that lists it in `answers`. The master agent is
// never involved. The router polls card_event rows (the chat lives there, not on the vibe_event
// bus) and keeps its cursor in vibe_meta, so messages written while the daemon was down are handled
// after a restart, and messages that arrive through the phone sync are handled like RPC ones.

import type { PaseoApi } from "@getpaseo/client";
import { chatThreadOf, type AgentSession, type CardView } from "../vibe/contract";
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
  author: string;
  body_json: string;
}

/** What happens to an execution-thread message on a card in this state (pure, for the tests). */
export function routeOf(
  column: CardView["column"],
  live: AgentSession | undefined,
  last: AgentSession | undefined,
): "executor" | "resume" | "none" {
  if (column === "done") return "none";
  if (live) return "executor";
  return last ? "resume" : "none";
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

  const workers = (cardId: string) => store.sessions.list({ cardId, role: "worker" });
  const liveExecutorOf = (cardId: string) =>
    store.sessions.list({ cardId, role: "worker", states: [...EXECUTOR_LIVE_STATES] }).at(-1);

  const note = (cardId: string, rowId: string, text: string, extra: { agentId?: string; sessionId?: string } = {}) =>
    postChat(
      store,
      {
        cardId,
        authorKind: "system",
        author: "chat-router",
        kind: "info",
        thread: "exec",
        text,
        answers: [rowId],
        key: `forward:${rowId}`,
        ...extra,
      },
      log,
    );

  /** "done": handled (or not ours); "retry": try again on the next poll. */
  async function handle(row: Row): Promise<"done" | "retry"> {
    let body: { text?: unknown; thread?: unknown } = {};
    try {
      body = JSON.parse(row.body_json) as typeof body;
    } catch {
      return "done";
    }
    if (chatThreadOf({ authorKind: "user", author: row.author, body }) !== "exec") return "done";
    const card = store.cards.get(row.card_id);
    if (!card || card.archivedAt) return "done";
    if (answered(card.id, row.id)) return "done";
    const text = String(body.text ?? "");
    if (!text.trim()) return "done";

    const live = liveExecutorOf(card.id);
    const last = workers(card.id).at(-1);
    const route = routeOf(card.column, live, last);
    if (route === "none") {
      note(
        card.id,
        row.id,
        card.column === "done"
          ? "卡片已完成，这条消息只作记录。"
          : "还没有执行 agent：点「立即执行」开始执行，这条消息会作为执行对话的一部分交给它。",
      );
      return "done";
    }
    const paseo = options.getPaseo();
    if (!paseo) return "retry";
    const session = (live ?? last)!;
    try {
      const agent = paseo.agents.ref(session.agentId);
      let asAnswer = false;
      if (route === "resume") {
        // The round finished (or the daemon restarted): load the agent back and continue it.
        // `resume` is the [core] handle call of WP-103; the published SDK types do not have it yet.
        const resumable = agent as { resume?: () => Promise<void> };
        if (resumable.resume) await resumable.resume();
      } else {
        const questionId = session.state === "waiting" ? questionIdOf(session) : null;
        if (questionId) {
          try {
            await options.replies.send({ id: row.id, cardId: card.id, questionId, text });
            asAnswer = true;
          } catch {
            // the question is gone or cannot be answered: send the text as a normal message instead
          }
        }
      }
      if (!asAnswer) await agent.send(text);
      note(
        card.id,
        row.id,
        asAnswer ? "已作为回答发给执行 agent 的提问。" : route === "resume" ? "已唤回执行 agent 并转给它。" : "已转发给执行 agent。",
        { agentId: session.agentId, sessionId: session.id },
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log(`could not forward ${row.id} to ${session.agentId}`, error);
      note(
        card.id,
        row.id,
        `没能发给执行 agent（${clip(reason, 200)}）。可以换一个执行模型，或重新「立即执行」。`,
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
              `SELECT rowid AS rid, id, card_id, author, body_json FROM card_event
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
