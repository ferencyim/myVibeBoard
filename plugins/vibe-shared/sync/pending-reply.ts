// Offline answers to agent questions ("pending replies").
//
// The phone may write an answer while offline. It is only a draft until reconnect: before sending,
// the question is re-checked on the daemon (RPC vibe.reply.check); if it is no longer pending
// (answered elsewhere, session ended, card moved on) the reply is marked stale and NOT sent.
//
//   pending --check ok--> sending --sent--> sent
//      |                     |--send failed--> pending (retry; same id = idempotency key)
//      '--check says gone--> stale
//   pending --cancel--> cancelled

export type PendingReplyStatus = "pending" | "sending" | "sent" | "stale" | "cancelled";

export interface PendingReply {
  /** Idempotency key, also usable as the local row id. */
  id: string;
  cardId: string;
  /** The question being answered (permission/question request id). */
  questionId: string;
  text: string;
  createdAt: number;
  status: PendingReplyStatus;
  /** Why it went stale (set with status "stale"). */
  staleReason?: string;
  attempts: number;
}

/** Answer of the daemon's check: is the question still waiting for an answer? */
export type QuestionState = "pending" | "answered" | "gone";

export interface FlushHandlers {
  check(reply: PendingReply): Promise<QuestionState>;
  /** Deliver the reply; must be idempotent per reply.id. Throw to retry later. */
  send(reply: PendingReply): Promise<void>;
}

export interface FlushResult {
  sent: string[];
  stale: string[];
  /** Left pending because check/send failed (e.g. connection dropped again). */
  failed: string[];
}

export class PendingReplyQueue {
  private readonly items = new Map<string, PendingReply>();

  constructor(initial: readonly PendingReply[] = []) {
    for (const r of initial) {
      // A reply stuck in "sending" (app killed mid-send) must be re-verified, never blindly resent.
      this.items.set(r.id, r.status === "sending" ? { ...r, status: "pending" } : { ...r });
    }
  }

  /** Write (or overwrite the text of) the pending answer for a question. */
  enqueue(input: { id: string; cardId: string; questionId: string; text: string; now: number }): PendingReply {
    const existing = this.forQuestion(input.questionId);
    if (existing && existing.status === "pending") {
      existing.text = input.text;
      return existing;
    }
    const reply: PendingReply = {
      id: input.id,
      cardId: input.cardId,
      questionId: input.questionId,
      text: input.text,
      createdAt: input.now,
      status: "pending",
      attempts: 0,
    };
    this.items.set(reply.id, reply);
    return reply;
  }

  cancel(id: string): boolean {
    const r = this.items.get(id);
    if (!r || r.status !== "pending") return false;
    r.status = "cancelled";
    return true;
  }

  /** The live (not finished) reply for a question, if any. */
  forQuestion(questionId: string): PendingReply | undefined {
    for (const r of this.items.values()) {
      if (r.questionId === questionId && (r.status === "pending" || r.status === "sending")) return r;
    }
    return undefined;
  }

  list(status?: PendingReplyStatus): PendingReply[] {
    return [...this.items.values()]
      .filter((r) => !status || r.status === status)
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  }

  /** Apply the daemon's answer to the check. Returns the reply if it may now be sent. */
  resolveCheck(id: string, state: QuestionState): PendingReply | undefined {
    const r = this.items.get(id);
    if (!r || r.status !== "pending") return undefined;
    if (state === "pending") {
      r.status = "sending";
      r.attempts++;
      return r;
    }
    r.status = "stale";
    r.staleReason = state === "answered" ? "already_answered" : "question_gone";
    return undefined;
  }

  markSent(id: string): void {
    const r = this.items.get(id);
    if (r && r.status === "sending") r.status = "sent";
  }

  /** Send failed; allow a later retry (which re-checks the question first). */
  markSendFailed(id: string): void {
    const r = this.items.get(id);
    if (r && r.status === "sending") r.status = "pending";
  }

  toJSON(): PendingReply[] {
    return this.list();
  }

  /** After reconnect: verify each pending reply, then send only those whose question is still open. */
  async flush(h: FlushHandlers): Promise<FlushResult> {
    const out: FlushResult = { sent: [], stale: [], failed: [] };
    for (const r of this.list("pending")) {
      let state: QuestionState;
      try {
        state = await h.check(r);
      } catch {
        out.failed.push(r.id);
        continue;
      }
      const toSend = this.resolveCheck(r.id, state);
      if (!toSend) {
        out.stale.push(r.id);
        continue;
      }
      try {
        await h.send(toSend);
        this.markSent(r.id);
        out.sent.push(r.id);
      } catch {
        this.markSendFailed(r.id);
        out.failed.push(r.id);
      }
    }
    return out;
  }
}
