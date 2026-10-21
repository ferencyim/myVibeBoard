// Chat service behind the RPCs: owner messages and the accept / reject of the master's proposals.
// Writes go through the command layer; routing of a message is the router's job (router.ts).

import type { MoveActor } from "../vibe/contract";
import type { VibeDb } from "../vibe/db";
import { BoardError, type BoardService, toBoardError } from "../service";

type UiActor = Extract<MoveActor, "user" | "phone">;

const guard = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (error) {
    throw toBoardError(error);
  }
};

export function createChatService(board: BoardService, db: VibeDb, onMessage?: () => void) {
  const { store } = board;

  /** The owner (or the phone, online) says something on a card. */
  function send(ref: string, text: string, actor: UiActor = "user") {
    return guard(() => {
      const card = board.cards.get(ref);
      const event = store.cards.addChat({ cardId: card.id, authorKind: "user", author: actor, text });
      onMessage?.();
      return { event };
    });
  }

  function proposalCard(eventId: string): string {
    const row = db
      .prepare<{ card_id: string; type: string }>("SELECT card_id, type FROM card_event WHERE id = ?")
      .get(eventId);
    if (!row || row.type !== "proposal") throw new BoardError("not_found", `Proposal not found: ${eventId}`);
    return row.card_id;
  }

  /** Apply a pending proposal to the card. The only accept path: the phone sync refuses proposal events. */
  function accept(eventId: string, actor: UiActor = "user") {
    return guard(() => {
      const cardId = proposalCard(eventId);
      const event = store.cards.acceptProposal(eventId, actor);
      return { event, card: store.cards.get(cardId)! };
    });
  }

  function reject(eventId: string, actor: UiActor = "user") {
    return guard(() => {
      proposalCard(eventId);
      return { event: store.cards.rejectProposal(eventId, actor) };
    });
  }

  return { send, accept, reject };
}

export type ChatService = ReturnType<typeof createChatService>;
