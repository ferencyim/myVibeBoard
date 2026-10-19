// What wakes the master. Everything arrives as vibe_event rows (the shared bus), nothing calls
// another plugin:
//   card.created (draft) / card.updated (owner fields of a draft) / card.moved -> draft
//        -> assess_draft after a quiet period (default 30 s), restarted by every further edit
//   card.moved -> done                         -> card_done (memory consolidation)
//   session.waiting of a worker with a card    -> session_help
// The master's own write-back (suggested preset, plan version, evaluation event) does not
// restart the debounce: only owner fields count, and the content hash is the final arbiter.

import { createEventConsumer, type EventConsumer, type VibeDb, type VibeStore } from "../vibe/db";
import { isEvent } from "../vibe/contract";
import { contentHash, lastAssessmentMarker } from "../assess/assess";
import type { Clock } from "../clock";
import type { WakeJob } from "../types";
import { createDebouncer, type Debouncer } from "./debounce";
import type { WakeQueue } from "./queue";

/** card.updated field names (DB columns) that change what the owner asked for. */
const OWNER_FIELDS = new Set(["title", "description", "acceptance", "ref_images_json", "tags"]);
const SWEEP_DRAFTS = 10;
const SWEEP_DONE_WINDOW_MS = 48 * 60 * 60_000;

export interface TriggersOptions {
  db: VibeDb;
  store: VibeStore;
  clock: Clock;
  queue: WakeQueue;
  enabled(): boolean;
  debounceMs(): number;
  pollIntervalMs?: number;
  /** vibe-scheduler signals: quota getting low / admission paused or resumed (memory). */
  onScheduler?(event: SchedulerSignal): void;
  log?: (message: string, error?: unknown) => void;
}

export type SchedulerSignal =
  | { kind: "quota_low"; provider: string; level: "tight" | "exhausted"; remainingPct: number | null }
  | { kind: "paused" | "resumed" };

export interface Triggers {
  consumer: EventConsumer;
  debouncer: Debouncer<string>;
  /** Assess now (manual wake): cancels a pending debounce. */
  assessNow(cardId: string, force?: boolean): void;
  /** Queue drafts without an up-to-date assessment and recently finished cards without a memory update. */
  sweep(): number;
  stop(): Promise<void>;
}

export function createTriggers(options: TriggersOptions): Triggers {
  const { store, queue } = options;
  const log = options.log ?? (() => undefined);

  const debouncer = createDebouncer<string>(options.clock, options.debounceMs, (cardId) => {
    if (options.enabled()) queue.enqueue({ kind: "assess_draft", cardId });
  });

  function isDraft(cardId: string): boolean {
    const card = store.cards.get(cardId);
    return !!card && card.column === "draft" && !card.archivedAt;
  }

  const consumer = createEventConsumer({
    db: options.db,
    consumer: "vibe-master",
    types: [
      "card.created",
      "card.updated",
      "card.moved",
      "session.waiting",
      "scheduler.quota_low",
      "scheduler.paused",
      "scheduler.resumed",
    ],
    startAt: "now",
    pollIntervalMs: options.pollIntervalMs,
    onError: (error, seq) => log(`event ${seq} failed`, error),
    handler: (event) => {
      if (isEvent(event, "scheduler.quota_low")) {
        const { provider, level, remainingPct } = event.payload;
        options.onScheduler?.({ kind: "quota_low", provider, level, remainingPct });
        return;
      }
      if (isEvent(event, "scheduler.paused")) return options.onScheduler?.({ kind: "paused" });
      if (isEvent(event, "scheduler.resumed")) return options.onScheduler?.({ kind: "resumed" });
      if (!options.enabled()) return;
      const cardId = event.cardId;
      if (isEvent(event, "card.created")) {
        if (cardId && event.payload.column === "draft") debouncer.touch(cardId);
      } else if (isEvent(event, "card.updated")) {
        if (cardId && event.payload.fields.some((f) => OWNER_FIELDS.has(f)) && isDraft(cardId)) {
          debouncer.touch(cardId);
        }
      } else if (isEvent(event, "card.moved")) {
        if (!cardId) return;
        if (event.payload.to === "draft") debouncer.touch(cardId);
        else {
          debouncer.cancel(cardId);
          if (event.payload.to === "done") queue.enqueue({ kind: "card_done", cardId });
        }
      } else if (isEvent(event, "session.waiting")) {
        const session = store.sessions.get(event.payload.sessionId);
        if (session && session.role === "worker" && session.cardId) {
          const job: WakeJob = {
            kind: "session_help",
            cardId: session.cardId,
            sessionId: session.id,
            question: event.payload.question,
          };
          queue.enqueue(job);
        }
      }
    },
  });
  consumer.start();

  return {
    consumer,
    debouncer,

    assessNow(cardId, force = true) {
      debouncer.cancel(cardId);
      queue.enqueue({ kind: "assess_draft", cardId, force });
    },

    sweep() {
      let queued = 0;
      const drafts = store.cards
        .list({ column: "draft" })
        .filter((card) => {
          const names = card.tags
            .map((id) => store.tags.list().find((t) => t.id === id)?.name)
            .filter((n): n is string => !!n);
          return lastAssessmentMarker(store.events.list(card.id))?.hash !== contentHash(card, names);
        })
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, SWEEP_DRAFTS);
      for (const card of drafts) {
        queue.enqueue({ kind: "assess_draft", cardId: card.id });
        queued++;
      }
      const since = new Date(options.clock.now() - SWEEP_DONE_WINDOW_MS).toISOString();
      for (const card of store.cards.list({ column: "done" })) {
        if (card.updatedAt < since) continue;
        const consolidated = store.events
          .list(card.id)
          .some((e) => (e.body as { kind?: string } | null)?.kind === "memory_update");
        if (!consolidated) {
          queue.enqueue({ kind: "card_done", cardId: card.id });
          queued++;
        }
      }
      return queued;
    },

    async stop() {
      debouncer.dispose();
      await consumer.stop();
    },
  };
}
