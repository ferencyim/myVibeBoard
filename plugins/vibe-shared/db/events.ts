// vibe_event bus: durable events in the shared SQLite file.
//
//   producers: publishEvent() (usually via the command layer, inside the same transaction as
//              the state change); a dedupeKey makes publishing idempotent.
//   consumers: createEventConsumer() polls by cursor (one cursor per consumer name). Delivery is
//              at-least-once: the cursor advances only after the handler resolved, so handlers
//              must be idempotent (use event.seq or event.dedupeKey as the natural key).
//              A handler that keeps failing is dead-lettered after maxAttempts so it cannot
//              block the stream.

import {
  EVENT_PAYLOADS,
  type EventType,
  type NewEvent,
  type VibeEvent,
  parseEvent,
} from "../contract/events";
import type { VibeDb } from "./sqlite";

interface EventRow {
  seq: number;
  ts: string;
  type: string;
  card_id: string | null;
  project_id: string | null;
  payload_json: string;
  dedupe_key: string | null;
}

/** Validate and append one event. Returns its seq (the existing seq if dedupeKey was seen). */
export function publishEvent<T extends EventType>(
  db: VibeDb,
  event: NewEvent<T>,
  now: () => Date = () => new Date(),
): number {
  const payload = EVENT_PAYLOADS[event.type].parse(event.payload);
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO vibe_event (ts, type, card_id, project_id, payload_json, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      event.ts ?? now().toISOString(),
      event.type,
      event.cardId ?? null,
      event.projectId ?? null,
      JSON.stringify(payload),
      event.dedupeKey ?? null,
    );
  if (result.changes > 0) return Number(result.lastInsertRowid);
  const existing = db
    .prepare<{ seq: number }>("SELECT seq FROM vibe_event WHERE dedupe_key = ?")
    .get(event.dedupeKey ?? null);
  if (!existing)
    throw new Error("publishEvent: insert ignored but no event with this dedupeKey exists");
  return existing.seq;
}

function rowToRaw(row: EventRow) {
  return {
    seq: row.seq,
    ts: row.ts,
    type: row.type,
    cardId: row.card_id,
    projectId: row.project_id,
    payload: JSON.parse(row.payload_json) as unknown,
    dedupeKey: row.dedupe_key,
  };
}

export function getMaxSeq(db: VibeDb): number {
  return db.prepare<{ m: number | null }>("SELECT MAX(seq) AS m FROM vibe_event").get()?.m ?? 0;
}

/** Events after `afterSeq`, oldest first. Throws if a stored event no longer validates. */
export function readEvents(
  db: VibeDb,
  afterSeq: number,
  options: { limit?: number; types?: readonly EventType[] } = {},
): VibeEvent[] {
  return fetchRaw(db, afterSeq, options.limit ?? 100, options.types).map((r) =>
    parseEvent(rowToRaw(r)),
  );
}

function fetchRaw(
  db: VibeDb,
  afterSeq: number,
  limit: number,
  types?: readonly EventType[],
): EventRow[] {
  if (types && types.length > 0) {
    const marks = types.map(() => "?").join(",");
    return db
      .prepare<EventRow>(
        `SELECT * FROM vibe_event WHERE seq > ? AND type IN (${marks}) ORDER BY seq LIMIT ?`,
      )
      .all(afterSeq, ...types, limit);
  }
  return db
    .prepare<EventRow>("SELECT * FROM vibe_event WHERE seq > ? ORDER BY seq LIMIT ?")
    .all(afterSeq, limit);
}

export function getCursor(db: VibeDb, consumer: string): number | undefined {
  return db
    .prepare<{ last_seq: number }>("SELECT last_seq FROM vibe_cursor WHERE consumer = ?")
    .get(consumer)?.last_seq;
}

/** Advance (never rewind) a consumer's cursor. */
export function advanceCursor(
  db: VibeDb,
  consumer: string,
  seq: number,
  now: () => Date = () => new Date(),
): void {
  db.prepare(
    `INSERT INTO vibe_cursor (consumer, last_seq, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(consumer) DO UPDATE SET last_seq = MAX(last_seq, excluded.last_seq),
       updated_at = excluded.updated_at`,
  ).run(consumer, seq, now().toISOString());
}

/** Drop events older than `olderThan` (ISO) that every registered consumer has already passed. */
export function pruneEvents(db: VibeDb, olderThan: string): number {
  const minCursor = db
    .prepare<{ m: number | null }>("SELECT MIN(last_seq) AS m FROM vibe_cursor")
    .get()?.m;
  const result = db
    .prepare("DELETE FROM vibe_event WHERE ts < ? AND seq <= ?")
    .run(olderThan, minCursor ?? Number.MAX_SAFE_INTEGER);
  return result.changes;
}

export interface DeadLetter {
  consumer: string;
  seq: number;
  error: string;
  failedAt: string;
}

export function listDeadLetters(db: VibeDb, consumer?: string): DeadLetter[] {
  const rows = consumer
    ? db.prepare("SELECT * FROM vibe_event_dead WHERE consumer = ? ORDER BY seq").all(consumer)
    : db.prepare("SELECT * FROM vibe_event_dead ORDER BY consumer, seq").all();
  return rows.map((r) => ({
    consumer: r.consumer as string,
    seq: r.seq as number,
    error: r.error as string,
    failedAt: r.failed_at as string,
  }));
}

export interface EventConsumerOptions {
  db: VibeDb;
  /** Unique per consuming plugin, e.g. "vibe-master". */
  consumer: string;
  handler: (event: VibeEvent) => void | Promise<void>;
  /** Only deliver these types (others are skipped but still advance the cursor). */
  types?: readonly EventType[];
  batchSize?: number;
  /** Default 500 ms. */
  pollIntervalMs?: number;
  /** Failures of the same event before it is dead-lettered. Default 5. */
  maxAttempts?: number;
  /** Where a consumer with no stored cursor begins. Default "beginning". */
  startAt?: "beginning" | "now";
  onError?: (error: unknown, seq: number) => void;
  now?: () => Date;
}

export interface EventConsumer {
  /** Process everything currently pending; resolves with the number of events handled. */
  poll(): Promise<number>;
  start(): void;
  /** Stop the timer and wait for an in-flight poll. */
  stop(): Promise<void>;
}

export function createEventConsumer(options: EventConsumerOptions): EventConsumer {
  const { db, consumer, handler } = options;
  const now = options.now ?? (() => new Date());
  const batchSize = options.batchSize ?? 100;
  const maxAttempts = options.maxAttempts ?? 5;
  const attempts = new Map<number, number>();
  let inflight: Promise<number> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  if (getCursor(db, consumer) === undefined) {
    advanceCursor(db, consumer, options.startAt === "now" ? getMaxSeq(db) : 0, now);
  }

  async function run(): Promise<number> {
    let handled = 0;
    for (;;) {
      const cursor = getCursor(db, consumer) ?? 0;
      const batch = fetchRaw(db, cursor, batchSize, options.types);
      if (batch.length === 0) {
        // Types filter may hide trailing events: still move the cursor past them.
        if (options.types) {
          const max = getMaxSeq(db);
          if (max > cursor && fetchRaw(db, cursor, 1, options.types).length === 0)
            advanceCursor(db, consumer, max, now);
        }
        return handled;
      }
      for (const row of batch) {
        try {
          await handler(parseEvent(rowToRaw(row)));
          advanceCursor(db, consumer, row.seq, now);
          attempts.delete(row.seq);
          handled++;
        } catch (error) {
          options.onError?.(error, row.seq);
          const n = (attempts.get(row.seq) ?? 0) + 1;
          attempts.set(row.seq, n);
          if (n < maxAttempts) return handled; // retry on the next poll
          db.prepare(
            "INSERT OR REPLACE INTO vibe_event_dead (consumer, seq, error, failed_at) VALUES (?, ?, ?, ?)",
          ).run(
            consumer,
            row.seq,
            error instanceof Error ? error.message : String(error),
            now().toISOString(),
          );
          advanceCursor(db, consumer, row.seq, now);
          attempts.delete(row.seq);
        }
      }
    }
  }

  function poll(): Promise<number> {
    if (!inflight) {
      inflight = run().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  }

  return {
    poll,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        poll().catch((error) => options.onError?.(error, -1));
      }, options.pollIntervalMs ?? 500);
      timer.unref?.();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await inflight?.catch(() => undefined);
    },
  };
}
