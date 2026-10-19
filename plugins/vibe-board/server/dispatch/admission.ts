// Scheduler admission (WP-34 -> WP-12). vibe-scheduler cannot call this plugin, so it publishes
// `scheduler.admitted` on the shared event bus; this consumer turns each one into
// `dispatcher.dispatch(cardId)` and answers a failure with `scheduler.dispatch_failed` so the
// scheduler releases the slot. The user's "Dispatch" button still calls the dispatcher directly
// (force) and bypasses the scheduler.

import { createEventConsumer, publishEvent, type EventConsumer, type VibeDb } from "../vibe/db";
import type { BoardService } from "../service";
import { BoardError } from "../service";
import type { Dispatcher } from ".";

export interface AdmissionOptions {
  db: VibeDb;
  board: BoardService;
  dispatcher: Pick<Dispatcher, "dispatch">;
  pollIntervalMs?: number;
  onError?: (error: unknown) => void;
}

export function startAdmissionConsumer(options: AdmissionOptions): EventConsumer {
  const { db, board, dispatcher } = options;

  const consumer = createEventConsumer({
    db,
    consumer: "vibe-board-admission",
    types: ["scheduler.admitted"],
    pollIntervalMs: options.pollIntervalMs,
    onError: options.onError,
    async handler(event) {
      if (event.type !== "scheduler.admitted") return;
      const { cardId, presetId, port } = event.payload as {
        cardId: string;
        presetId?: string | null;
        port?: number;
      };
      const card = board.store.cards.get(cardId);
      // Idempotent: a replayed event, a user dispatch or a move since admission means nothing to do.
      if (!card || card.column !== "todo") return;
      try {
        await dispatcher.dispatch(cardId, {
          ...(presetId ? { presetId } : {}),
          force: true, // the scheduler already admitted it
          ...(port
            ? {
                extraInstructions: `The scheduler reserved dev-server port ${port} for this task. Run any dev server on that port so parallel tasks do not collide.`,
              }
            : {}),
        });
      } catch (error) {
        const code = error instanceof BoardError ? error.code : "";
        if (code === "illegal_transition" || code === "conflict") return; // raced with a manual dispatch
        const message = error instanceof Error ? error.message : String(error);
        // The dispatcher records its own failures on the card; record the rest here.
        if (code !== "dispatch_failed") {
          board.store.events.add({
            cardId,
            type: "status",
            authorKind: "system",
            author: "scheduler",
            body: { kind: "admission_failed", message },
          });
        }
        publishEvent(db, {
          type: "scheduler.dispatch_failed",
          cardId,
          projectId: card.projectId,
          payload: { cardId, message },
        });
      }
    },
  });
  consumer.start();
  return consumer;
}
