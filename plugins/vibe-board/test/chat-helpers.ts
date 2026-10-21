import type { CardEvent } from "../shared/vibe/contract";

let n = 0;
export const resetEvents = () => {
  n = 0;
};
export function chatEv(
  authorKind: CardEvent["authorKind"],
  body: unknown,
  type: CardEvent["type"] = "chat",
): CardEvent {
  n++;
  return {
    id: `e${n}`,
    cardId: "c1",
    type,
    authorKind,
    author: authorKind,
    body,
    createdAt: `2026-01-01T00:00:${String(n).padStart(2, "0")}.000Z`,
    updatedHlc: "",
  };
}
