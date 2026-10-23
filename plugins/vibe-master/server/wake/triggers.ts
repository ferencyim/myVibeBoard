// What wakes the master. Everything arrives as vibe_event rows (the shared bus), nothing calls
// another plugin:
//   card.moved -> done                         -> card_done (memory consolidation)
//   scheduler.quota_low / paused / resumed     -> reminders only
//   maintenance.paused                         -> master.alert (maintenance_paused); .triggered is only logged
// WP-105: the master no longer takes part in the card flow (no draft review, no advice on worker
// questions, no acceptance): planning and execution run on the models picked on the card.
// WP-109: the one card-flow job the master has is the dispatch pick (`scheduler.dispatch_wanted`).

import { createEventConsumer, type EventConsumer, type VibeDb, type VibeStore } from "../vibe/db";
import { isEvent } from "../vibe/contract";
import type { Clock } from "../clock";
import { type TuningSource } from "../tuning";
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
  /** vibe-scheduler has free slots and asks which waiting card goes first (never awaited: it takes a model call). */
  onMasterContinuation?(request: {
    requestId: string;
    sessionId: string;
    agentId: string;
    role: string;
    reason: string;
    summary: string;
    message: string;
  }): void;
  taskConsolidated?(workspaceId: string): boolean;
  onTaskDispatchWanted?(request: {
    requestId: string;
    slots: number;
    workspaceIds: string[];
  }): void;
  onDispatchWanted?(request: { requestId: string; slots: number; cardIds: string[] }): void;
  log?: (message: string, error?: unknown) => void;
}

export type SchedulerSignal =
  | {
      kind: "quota_low";
      provider: string;
      level: "tight" | "exhausted";
      remainingPct: number | null;
    }
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

  function onCompletedTask(workspaceId: string) {
    if (!options.enabled() || !flags().consolidateOnDone) return;
    const task = store.tasks.get(workspaceId);
    if (task?.phase === "completed" && !options.taskConsolidated?.(workspaceId)) {
      queue.enqueue({ kind: "task_done", workspaceId });
    }
  }

  const consumer = createEventConsumer({
    db: options.db,
    consumer: "vibe-master",
    types: [
      "task.updated",
      "context.continuation_requested",
      "scheduler.task_dispatch_wanted",
      "scheduler.quota_low",
      "scheduler.paused",
      "scheduler.resumed",
      "scheduler.dispatch_wanted",
      "maintenance.paused",
      "maintenance.triggered",
    ],
    startAt: "now",
    pollIntervalMs: options.pollIntervalMs,
    onError: (error, seq) => log(`event ${seq} failed`, error),
    handler: (event) => {
      if (isEvent(event, "context.continuation_requested")) {
        if (event.payload.role === "master") options.onMasterContinuation?.(event.payload);
        return;
      }
      if (isEvent(event, "scheduler.quota_low")) {
        const { provider, level, remainingPct } = event.payload;
        options.onScheduler?.({ kind: "quota_low", provider, level, remainingPct });
        return;
      }
      if (isEvent(event, "scheduler.task_dispatch_wanted"))
        return options.onTaskDispatchWanted?.(event.payload);
      if (isEvent(event, "scheduler.paused")) return options.onScheduler?.({ kind: "paused" });
      if (isEvent(event, "scheduler.resumed")) return options.onScheduler?.({ kind: "resumed" });
      if (isEvent(event, "maintenance.paused")) {
        const { ruleName, rejections } = event.payload;
        return options.onMaintenancePaused?.({ ruleName, rejections });
      }
      if (isEvent(event, "maintenance.triggered")) {
        return log(
          `maintenance rule ${event.payload.ruleId} triggered (run ${event.payload.runId})`,
        );
      }
      if (isEvent(event, "task.updated") && event.payload.fields.includes("phase")) {
        onCompletedTask(event.payload.workspaceId);
      }
    },
  });
  consumer.start();

  return {
    consumer,

    sweep() {
      let queued = 0;
      for (const task of flags().consolidateOnDone
        ? store.tasks.list({ phase: "completed" })
        : []) {
        if (!task.confirmedAt || options.taskConsolidated?.(task.workspaceId)) continue;
        queue.enqueue({ kind: "task_done", workspaceId: task.workspaceId });
        queued++;
      }
      return queued;
    },

    async stop() {
      await consumer.stop();
    },
  };
}
