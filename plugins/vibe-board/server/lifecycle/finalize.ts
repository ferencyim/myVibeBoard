// Card done (user pressed "pass" in verifying): merge or open a PR, clean up the worktree.
// ARCHITECTURE 3.5 assigns no work package to the git side, so this is an interface: a
// `Finalizer` is called once per card that reaches `done`. The default only leaves a card event
// saying a worktree still needs handling, so nothing is merged or deleted by surprise.

import { createEventConsumer, type VibeDb } from "../vibe/db";
import { isEvent, type CardView } from "../vibe/contract";
import type { BoardService } from "../service";

export type Finalizer = (card: CardView) => Promise<{ summary: string } | void>;

export const noteOnlyFinalizer =
  (board: BoardService): Finalizer =>
  async (card) => {
    if (!card.worktree) return;
    board.store.events.add({
      cardId: card.id,
      type: "status",
      authorKind: "system",
      author: "finalizer",
      body: {
        kind: "finalize_pending",
        worktree: card.worktree,
        text: "Merge or PR and worktree cleanup are not configured.",
      },
    });
  };

export function startFinalizer(options: {
  db: VibeDb;
  board: BoardService;
  finalize?: Finalizer;
  pollIntervalMs?: number;
}) {
  const finalize = options.finalize ?? noteOnlyFinalizer(options.board);
  const consumer = createEventConsumer({
    db: options.db,
    consumer: "vibe-board-finalize",
    types: ["card.moved"],
    startAt: "now",
    pollIntervalMs: options.pollIntervalMs,
    handler: async (event) => {
      if (!isEvent(event, "card.moved") || event.payload.to !== "done" || !event.cardId) return;
      const card = options.board.store.cards.get(event.cardId);
      if (!card) return;
      const result = await finalize(card);
      if (result) {
        options.board.store.events.add({
          cardId: card.id,
          type: "status",
          authorKind: "system",
          author: "finalizer",
          body: { kind: "finalized", text: result.summary },
        });
      }
    },
    onError: (error) => console.error("[vibe-board finalize]", error),
  });
  consumer.start();
  return consumer;
}
