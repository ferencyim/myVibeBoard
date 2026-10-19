// Phone sync + offline reply RPCs (WP-41). The wire format is vibe-shared/sync's
// ExchangeRequest / ExchangeResponse (see server/vibe/sync/exchange.ts); this file only adds the
// runtime validation. Values are raw SQLite cells (text / integer / null), `*_json` columns stay
// JSON text. Client code (the App) never imports server/ - these schemas are the contract.

import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const hlc = z.string().min(1);

export const SyncChangeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("field"),
    table: z.string(),
    rowId: z.string(),
    column: z.string(),
    value: z.json(),
    hlc,
  }),
  z.object({ kind: z.literal("delete"), table: z.string(), rowId: z.string(), hlc }),
]);

export const SYNC_REJECT_REASONS = [
  "unknown_table",
  "read_only",
  "unknown_field",
  "column_locked",
  "clock_drift",
] as const;

export const syncExchangeRpc = defineRpc({
  name: "vibe.sync.exchange",
  /** One sync round: send unsent local changes, receive everything since `since`.
   *  Repeat with `since = cursor` and `changes: []` while the response has `more: true`.
   *  `snapshot: true` means: wipe the local synced state first, then apply `changes`.
   *  `ok: false, code: "clock_drift"` carries `serverNow`: correct the local clock and resend.
   *  `serverNow` of an ok response is the "as of hh:mm" time for read-only data. */
  input: z.object({
    deviceId: z.string().min(1),
    epoch: z.string().optional(),
    since: z.number().int().min(0),
    clientNow: z.number(),
    changes: z.array(SyncChangeSchema).max(5000),
    limit: z.number().int().min(1).max(5000).optional(),
  }),
  output: z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      epoch: z.string(),
      cursor: z.number().int(),
      more: z.boolean(),
      snapshot: z.boolean(),
      changes: z.array(SyncChangeSchema),
      rejected: z.array(z.object({ change: SyncChangeSchema, reason: z.enum(SYNC_REJECT_REASONS) })),
      serverNow: z.number(),
    }),
    z.object({ ok: z.literal(false), code: z.literal("clock_drift"), serverNow: z.number() }),
  ]),
});

const replyInput = z.object({
  /** Idempotency key (PendingReplyQueue reply id). */
  id: z.string().min(1),
  cardId: z.string().min(1),
  /** Request id from agent_session.pending_question_json.requestId. */
  questionId: z.string().min(1),
  text: z.string(),
});

export const replyCheckRpc = defineRpc({
  name: "vibe.reply.check",
  /** Is the question still waiting? pending -> send it; answered/gone -> mark the reply stale. */
  input: replyInput,
  output: z.object({ state: z.enum(["pending", "answered", "gone"]) }),
});

export const replySendRpc = defineRpc({
  name: "vibe.reply.send",
  /** Deliver the reply to the agent (permission/question response). Idempotent per `id`.
   *  Fails with [stale] if the question is no longer open, [unavailable] if the daemon handle is
   *  not ready yet (retry later). */
  input: replyInput,
  output: z.object({ sent: z.boolean(), duplicate: z.boolean() }),
});
