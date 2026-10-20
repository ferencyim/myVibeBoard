// GENERATED FROM plugins/vibe-shared — DO NOT EDIT (run: node scripts/vibe/sync-shared.mjs)
// vibe_event: the persistent event bus between plugins (docs/vibe/ARCHITECTURE.md section 3.4).
// The event type list is fixed here; add types only by changing this file (and the docs).

import { z } from "zod";
import {
  CardColumnSchema,
  CardOriginSchema,
  JudgementSchema,
  ReviewVerdictSchema,
  SessionComplexitySchema,
} from "./enums";
import { MOVE_ACTORS } from "./state-machine";

const SessionRef = z.object({ sessionId: z.string(), agentId: z.string().optional() });

/** payload schema per event type */
export const EVENT_PAYLOADS = {
  "card.created": z.object({
    key: z.string(),
    title: z.string(),
    column: CardColumnSchema,
    origin: CardOriginSchema,
  }),
  "card.updated": z.object({ fields: z.array(z.string()) }),
  "card.deleted": z.object({ key: z.string() }),
  "card.moved": z.object({
    from: CardColumnSchema,
    to: CardColumnSchema,
    actor: z.enum(MOVE_ACTORS),
    reason: z.string().optional(),
  }),
  "card.assessed": z.object({ cardEventId: z.string() }),
  "card.dispatched": z.object({
    sessionId: z.string(),
    agentId: z.string(),
    worktree: z.string().nullable(),
    presetId: z.string().nullable(),
  }),
  "session.started": SessionRef.extend({ role: z.string(), provider: z.string() }),
  "session.waiting": SessionRef.extend({ question: z.unknown().optional() }),
  "session.answered": SessionRef,
  "session.ended": SessionRef.extend({ outcome: z.string().optional() }),
  "session.error": SessionRef.extend({ message: z.string() }),
  "session.switched": SessionRef.extend({ from: z.string(), to: z.string() }),
  "session.compacted": SessionRef.extend({ strategy: z.string().optional() }),
  // Round 2. Stall detection: stalled_since is a marker, not a session state.
  "session.stalled": SessionRef.extend({
    stalledSince: z.string(),
    /** ms without output when detected. */
    idleMs: z.number().int().optional(),
  }),
  "session.unstalled": SessionRef,
  // Failure reassignment: `fromSessionId` was ended and `sessionId` (the new one) replaces it.
  "session.reassigned": SessionRef.extend({
    fromSessionId: z.string(),
    fromAgentId: z.string().optional(),
    fromProvider: z.string(),
    provider: z.string(),
    presetId: z.string().nullable().optional(),
    reason: z.string(),
  }),
  "session.complexity_changed": SessionRef.extend({
    from: SessionComplexitySchema.nullable(),
    to: SessionComplexitySchema.nullable(),
  }),
  // Model review of a card's result (after the worker finishes). Published by the reviewer plugin.
  "review.started": z.object({
    reviewerPresetId: z.string().nullable().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    sessionId: z.string().optional(),
    commitHash: z.string().optional(),
  }),
  "review.finished": z.object({
    verdict: ReviewVerdictSchema,
    /** Short issue summaries; empty when verdict=pass. */
    issues: z.array(z.string()).default([]),
    summary: z.string().optional(),
    reviewerPresetId: z.string().nullable().optional(),
    sessionId: z.string().optional(),
    verificationId: z.string().optional(),
  }),
  // Cheap-model scouting before dispatch (complexity / files / plan hints).
  "scout.started": z.object({
    scoutPresetId: z.string().nullable().optional(),
    sessionId: z.string().optional(),
  }),
  "scout.finished": z.object({
    scoutPresetId: z.string().nullable().optional(),
    sessionId: z.string().optional(),
    outcome: z.enum(["ok", "failed"]),
    complexity: SessionComplexitySchema.nullable().optional(),
    files: z.array(z.string()).optional(),
    summary: z.string().optional(),
  }),
  "verification.started": z.object({ verificationId: z.string() }),
  "verification.finished": z.object({
    verificationId: z.string(),
    conclusion: JudgementSchema,
  }),
  // The UI (vibe-board, which cannot call another plugin's RPC) asks vibe-verify to act on a
  // card in `verifying`: send the user's rejection to the worker, or start a new verification.
  "verification.decision_requested": z.object({
    action: z.enum(["reject", "rerun"]),
    comment: z.string().optional(),
  }),
  "maintenance.triggered": z.object({ ruleId: z.string(), runId: z.string() }),
  // vibe-maintain (WP-36): a rule was paused after consecutive rejections; the master/UI should tell the user.
  "maintenance.paused": z.object({
    ruleId: z.string(),
    ruleName: z.string(),
    reason: z.enum(["rejections"]),
    rejections: z.number().int(),
  }),
  "plan.updated": z.object({ version: z.number().int() }),
  // vibe-scheduler (WP-34). `scheduler.admitted` asks vibe-board to dispatch the card now;
  // vibe-board answers a failed dispatch with `scheduler.dispatch_failed`.
  "scheduler.admitted": z.object({
    cardId: z.string(),
    presetId: z.string().nullable().optional(),
    provider: z.string().optional(),
    /** Dev-server port reserved for this card. */
    port: z.number().int().optional(),
    deviceIds: z.array(z.string()).optional(),
  }),
  "scheduler.dispatch_failed": z.object({ cardId: z.string(), message: z.string() }),
  "scheduler.quota_low": z.object({
    provider: z.string(),
    level: z.enum(["tight", "exhausted"]),
    remainingPct: z.number().nullable(),
    resetsAt: z.string().nullable().optional(),
  }),
  "scheduler.paused": z.object({
    reason: z.enum(["memory"]),
    mem: z.number(),
    top: z.array(
      z.object({
        sessionId: z.string(),
        cardKey: z.string().nullable().optional(),
        memBytes: z.number(),
      }),
    ),
  }),
  "scheduler.resumed": z.object({ reason: z.enum(["memory"]) }),
  // vibe-master (WP-50): a reminder for the owner (quota low, quota error, ...). `message` is the
  // full text; the push notifier only sends the kind, never the message.
  "master.alert": z.object({
    kind: z.string(),
    provider: z.string().optional(),
    message: z.string(),
    sessionId: z.string().optional(),
  }),
} as const;

export type EventType = keyof typeof EVENT_PAYLOADS;
export const EVENT_TYPES = Object.keys(EVENT_PAYLOADS) as EventType[];
export type EventPayload<T extends EventType> = z.infer<(typeof EVENT_PAYLOADS)[T]>;

export interface NewEvent<T extends EventType = EventType> {
  type: T;
  cardId?: string | null;
  projectId?: string | null;
  payload: EventPayload<T>;
  /** Optional idempotency key: publishing the same key twice stores one event. */
  dedupeKey?: string;
  /** Override timestamp (tests). */
  ts?: string;
}

/** A stored event as consumers see it. `type` is `string` until narrowed with parseEvent. */
export interface VibeEvent<T extends EventType = EventType> {
  seq: number;
  ts: string;
  type: T;
  cardId: string | null;
  projectId: string | null;
  payload: EventPayload<T>;
  dedupeKey: string | null;
}

export function isEventType(value: string): value is EventType {
  return Object.hasOwn(EVENT_PAYLOADS, value);
}

/** Validate a raw stored event; throws on unknown type or invalid payload. */
export function parseEvent(raw: {
  seq: number;
  ts: string;
  type: string;
  cardId: string | null;
  projectId: string | null;
  payload: unknown;
  dedupeKey: string | null;
}): VibeEvent {
  if (!isEventType(raw.type)) throw new Error(`Unknown vibe event type: ${raw.type}`);
  const payload = EVENT_PAYLOADS[raw.type].parse(raw.payload);
  return { ...raw, type: raw.type, payload } as VibeEvent;
}

/** Narrowing helper: `if (isEvent(e, "card.moved")) e.payload.to` */
export function isEvent<T extends EventType>(event: VibeEvent, type: T): event is VibeEvent<T> {
  return event.type === type;
}
