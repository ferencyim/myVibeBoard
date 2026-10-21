// Turns a master proposal into a `proposal` card event. The master never edits title, description
// or acceptance itself; fields equal to the card's current value are dropped, and a proposal that
// changes nothing is ignored.

import type { CardEvent, CardView } from "../vibe/contract";
import type { VibeStore } from "../vibe/db";
import type { ProposalInput } from "./schema";

const FIELDS = ["title", "description", "acceptance"] as const;
type Changes = Partial<Record<(typeof FIELDS)[number], string>>;

const norm = (text: string) => text.replace(/\r\n/g, "\n").trim();

/** The fields of `proposal` that differ from the card; null when nothing would change. */
export function effectiveChanges(
  card: Pick<CardView, "title" | "description" | "acceptance">,
  proposal: Partial<ProposalInput> | undefined,
): Changes | null {
  if (!proposal) return null;
  const changes: Changes = {};
  for (const field of FIELDS) {
    const value = proposal[field];
    if (typeof value !== "string" || !norm(value)) continue;
    if (norm(value) !== norm(card[field])) changes[field] = value;
  }
  return Object.keys(changes).length > 0 ? changes : null;
}

/** Writes the proposal (superseding earlier pending ones) when it changes anything. */
export function proposeChanges(
  store: VibeStore,
  card: CardView,
  proposal: ProposalInput | undefined,
  author: string,
): CardEvent | null {
  const changes = effectiveChanges(card, proposal);
  if (!changes || !proposal) return null;
  return store.cards.propose({ cardId: card.id, changes, rationale: proposal.rationale, authorKind: "master", author });
}
