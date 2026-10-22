// One master, one conversation: wake jobs run strictly one at a time. A job that cannot run now
// (no daemon handle yet, quota exhausted) is parked as "blocked" and re-queued by `resume()`
// (new daemon handle, subscription switch) instead of being dropped, which is what lets a switch
// carry on with the same batch of cards.

import { jobKey, type WakeJob } from "../types";

export type FailureAction = "block" | "drop";

export interface WakeQueueOptions {
  run(job: WakeJob): Promise<void>;
  /** Decide what happens to a job whose run threw. */
  onFailure(job: WakeJob, error: unknown): FailureAction;
}

export interface WakeQueue {
  /** Add a job; a job with the same kind+card that is still pending is merged. */
  enqueue(job: WakeJob): void;
  /** Run `fn` between jobs (never while one is running), e.g. a subscription switch. */
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
  /** Move blocked jobs back to pending. */
  resume(): void;
  snapshot(): { running: WakeJob | null; pending: WakeJob[]; blocked: WakeJob[] };
  /** Resolves when nothing is running or pending (blocked jobs do not count). */
  idle(): Promise<void>;
}

export function createWakeQueue(options: WakeQueueOptions): WakeQueue {
  const pending: WakeJob[] = [];
  let blocked: WakeJob[] = [];
  let running: WakeJob | null = null;
  let draining = false;
  let exclusiveTail: Promise<unknown> = Promise.resolve();
  let holds = 0;
  const waiters: Array<() => void> = [];

  const settle = () => {
    if (!running && pending.length === 0 && !draining) for (const w of waiters.splice(0)) w();
  };

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (holds === 0 && pending.length > 0) {
        const job = pending.shift()!;
        running = job;
        try {
          await options.run(job);
        } catch (error) {
          if (options.onFailure(job, error) === "block") blocked.push(job);
        } finally {
          running = null;
        }
      }
    } finally {
      draining = false;
      settle();
    }
  }

  return {
    enqueue(job) {
      const same = pending.find((p) => jobKey(p) === jobKey(job));
      if (same) {
        same.force = same.force || job.force;
      } else {
        pending.push({ ...job });
      }
      blocked = blocked.filter((b) => jobKey(b) !== jobKey(job));
      void drain();
    },

    exclusive<T>(fn: () => Promise<T>): Promise<T> {
      holds++;
      const run = exclusiveTail.then(async () => {
        // Wait for the job that is running right now (the drain loop stops taking new ones).
        while (running || draining) await new Promise((r) => setTimeout(r, 5));
        return fn();
      });
      exclusiveTail = run.catch(() => undefined);
      return run.finally(() => {
        holds--;
        void drain();
      });
    },

    resume() {
      const parked = blocked;
      blocked = [];
      for (const job of parked) {
        if (!pending.some((p) => jobKey(p) === jobKey(job))) pending.push(job);
      }
      void drain();
    },

    snapshot: () => ({ running, pending: [...pending], blocked: [...blocked] }),

    idle() {
      if (!running && pending.length === 0 && !draining) return Promise.resolve();
      return new Promise<void>((resolve) => waiters.push(resolve));
    },
  };
}
