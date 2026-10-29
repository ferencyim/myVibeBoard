// Completed tasks and retained scheduler, context and maintenance events wake the master.

import type { Clock } from "../clock";
import { type TuningSource } from "../tuning";
import { isEvent } from "../vibe/contract";
import { createEventConsumer, type EventConsumer, type VibeDb, type VibeStore } from "../vibe/db";
import type { WakeQueue } from "./queue";

/** Owner switches (settings). */
export type TriggerFlags = Record<string, never>;

export const DEFAULT_TRIGGER_FLAGS: TriggerFlags = {};

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
  ready?: Promise<void>;
  /** vibe-scheduler signals: quota getting low / admission paused or resumed (memory). */
  onScheduler?(event: SchedulerSignal): void;
  /** vibe-maintain: a rule was paused after repeated rejections (the owner is reminded). */
  onMaintenancePaused?(event: { ruleName: string; rejections: number }): void;
  /** vibe-scheduler has free slots and asks which waiting task goes first (never awaited: it takes a model call). */
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
  /** Queue recently finished tasks without a memory update. */
  sweep(): number;
  stop(): Promise<void>;
}

export function createTriggers(options: TriggersOptions): Triggers {
  const log = options.log ?? (() => undefined);

  const consumer = createEventConsumer({
    db: options.db,
    consumer: "vibe-master",
    types: [
      "context.continuation_requested",
      "scheduler.task_dispatch_wanted",
      "scheduler.quota_low",
      "scheduler.paused",
      "scheduler.resumed",
      "maintenance.paused",
      "maintenance.triggered",
    ],
    startAt: "now",
    pollIntervalMs: options.pollIntervalMs,
    onError: (error, seq) => log(`event ${seq} failed`, error),
    handler: async (event) => {
      await options.ready;
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
    },
  });
  consumer.start();

  return {
    consumer,

    sweep() {
      return 0;
    },

    async stop() {
      await consumer.stop();
    },
  };
}
