// Offline answers to agent questions (WP-43). The plugin UI calls `vibe.reply.send` like online; with
// no connection the call lands here: the answer is checked against the question as of the last sync
// and queued on the replica (PendingReplyQueue, persisted). The sync engine sends it after
// reconnecting, once `vibe.reply.check` says the question is still open. Discussion messages and
// handoff requests are NOT replies to a question: they are plain card notes (`vibe.events.add`) that
// travel with the normal sync changes.

import { newId } from "../generated/contract";
import type { PendingReply } from "../generated/sync";
import { liveRows, toSession } from "../rpc/rows";
import type { LocalReplica } from "../store/replica";

export interface ReplyInput {
  id?: string;
  cardId: string;
  questionId: string;
  text: string;
}

export class ReplyQueueError extends Error {
  constructor(message: string) {
    super(`[stale] ${message}`);
  }
}

/** Does the replica (as of the last sync) show this question waiting for an answer? */
export function questionIsOpen(replica: LocalReplica, cardId: string, questionId: string): boolean {
  return liveRows(replica.store, "agent_session")
    .map(toSession)
    .some((s) => {
      if (s.cardId !== cardId || s.state !== "waiting") return false;
      const q = s.pendingQuestion as { requestId?: unknown } | null;
      return q?.requestId === questionId;
    });
}

export function queueReply(replica: LocalReplica, input: ReplyInput, now: number): PendingReply {
  if (!input.text.trim()) throw new ReplyQueueError("The answer is empty");
  if (!questionIsOpen(replica, input.cardId, input.questionId)) {
    throw new ReplyQueueError("The question is no longer waiting for an answer");
  }
  const reply = replica.replies.enqueue({
    id: input.id ?? newId(now),
    cardId: input.cardId,
    questionId: input.questionId,
    text: input.text.trim(),
    now,
  });
  replica.persistReplies();
  return reply;
}

/** Replies the user still has to be told about: waiting to be sent, or refused as stale. */
export function visibleReplies(replica: LocalReplica): PendingReply[] {
  return replica.replies
    .list()
    .filter((r) => r.status === "pending" || r.status === "sending" || r.status === "stale");
}

/** Toast text for the outcome of a reconnect flush (null when there is nothing to tell). */
export function replyOutcomeMessage(
  result: { sent: string[]; stale: string[] } | null,
): string | null {
  if (!result) return null;
  const parts: string[] = [];
  if (result.sent.length > 0) parts.push(`已发送 ${result.sent.length} 条离线回复`);
  if (result.stale.length > 0) {
    parts.push(`${result.stale.length} 条离线回复未发送（问题已被回答或已结束）`);
  }
  return parts.length > 0 ? parts.join("；") : null;
}
