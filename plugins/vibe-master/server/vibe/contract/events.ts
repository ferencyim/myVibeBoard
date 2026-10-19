// GENERATED FROM plugins/vibe-shared — DO NOT EDIT (run: node scripts/vibe/sync-shared.mjs)
// vibe_event: the persistent event bus between plugins (docs/vibe/ARCHITECTURE.md section 3.4).
// The event type list is fixed here; add types only by changing this file (and the docs).

import { z } from "zod";
import { CardColumnSchema, CardOriginSchema, JudgementSchema } from "./enums";
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
  "verification.started": z.object({ verificationId: z.string() }),
  "verification.finished": z.object({
    verificationId: z.string(),
    conclusion: JudgementSchema,
  }),
  "maintenance.triggered": z.object({ ruleId: z.string(), runId: z.string() }),
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
