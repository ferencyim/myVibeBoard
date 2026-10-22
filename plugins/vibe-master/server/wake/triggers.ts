// What wakes the master. Everything arrives as vibe_event rows (the shared bus), nothing calls
// another plugin:
//   card.moved -> done                         -> card_done (memory consolidation)
//   scheduler.quota_low / paused / resumed     -> reminders only
//   maintenance.paused                         -> master.alert (maintenance_paused); .triggered is only logged
// WP-105: the master no longer takes part in the card flow (no draft review, no advice on worker
// questions, no dispatch or acceptance): planning and execution run on the models picked on the card.

import { createEventConsumer, type EventConsumer, type VibeDb, type VibeStore } from "../vibe/db";
import { isEvent } from "../vibe/contract";
import type { Clock } from "../clock";
import { defaultTuning, type TuningSource } from "../tuning";
import type { WakeQueue } from "./queue";

/** Owner switches (settings). */
export interface TriggerFlags {
  consolidateOnDone: boolean;
}

export const DEFAULT_TRIGGER_FLAGS: TriggerFlags = { consolidateOnDone: true };

export interface TriggersOptions {
  db: VibeDb;
  store: VibeStore;
  clock: Clock;
  queue: WakeQueue;
  enabled(): boolean;
  /** Automation parameters (settings); defaults when omitted. */
  tuning?: TuningSource;
  /** Read on every event; missing = everything on. */
  flags?(): TriggerFlags;
  pollIntervalMs?: number;
  /** vibe-scheduler signals: quota getting low / admission paused or resumed (memory). */
  onScheduler?(event: SchedulerSignal): void;
  /** vibe-maintain: a rule was paused after repeated rejections (the owner is reminded). */
  onMaintenancePaused?(event: { ruleName: string; rejections: number }): void;
  log?: (message: string, error?: unknown) => void;
}

export type SchedulerSignal =
  | { kind: "quota_low"; provider: string; level: "tight" | "exhausted"; remainingPct: number | null }
  | { kind: "paused" | "resumed" };

export interface Triggers {
  consumer: EventConsumer;
  /** Queue recently finished cards without a memory update. */
  sweep(): number;
  stop(): Promise<void>;
}

export function createTriggers(options: TriggersOptions): Triggers {
  const { store, queue } = options;
  const log = options.log ?? (() => undefined);
  const flags = () => options.flags?.() ?? DEFAULT_TRIGGER_FLAGS;

  const consumer = createEventConsumer({
    db: options.db,
    consumer: "vibe-master",
    types: [
      "card.moved",
      "scheduler.quota_low",
      "scheduler.paused",
      "scheduler.resumed",
      "maintenance.paused",
      "maintenance.triggered",
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
      if (isEvent(event, "maintenance.paused")) {
        const { ruleName, rejections } = event.payload;
        return options.onMaintenancePaused?.({ ruleName, rejections });
      }
      if (isEvent(event, "maintenance.triggered")) {
        return log(`maintenance rule ${event.payload.ruleId} triggered (run ${event.payload.runId})`);
      }
      if (!options.enabled()) return;
      if (isEvent(event, "card.moved") && event.cardId) {
        if (event.payload.to === "done" && flags().consolidateOnDone) {
          queue.enqueue({ kind: "card_done", cardId: event.cardId });
        }
      }
    },
  });
  consumer.start();

  return {
    consumer,

    sweep() {
      let queued = 0;
      const since = new Date(
        options.clock.now() - (options.tuning ?? defaultTuning)().sweepDoneWindowMs,
      ).toISOString();
      for (const card of flags().consolidateOnDone ? store.cards.list({ column: "done" }) : []) {
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
      await consumer.stop();
    },
  };
}
