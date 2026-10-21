// Chat write-back helper: every automatic message goes through the command layer (addChat) with an
// idempotency key, and a failed write-back never breaks the flow that triggered it.

import type { AuthorKind, ChatKind } from "../vibe/contract";
import type { VibeStore } from "../vibe/db";

export interface PostChatInput {
  cardId: string;
  authorKind: AuthorKind;
  author: string;
  text: string;
  kind?: ChatKind;
  sessionId?: string;
  agentId?: string;
  detail?: string;
  answers?: string[];
  fallback?: string[];
  /** Idempotency key, unique per card: the same key is written once. */
  key: string;
}

export function postChat(
  store: Pick<VibeStore, "cards">,
  input: PostChatInput,
  log?: (message: string, error?: unknown) => void,
) {
  try {
    return store.cards.addChat(input);
  } catch (error) {
    (log ?? ((m, e) => console.error(`[vibe-board chat] ${m}`, e ?? "")))(
      `could not write chat message ${input.key}`,
      error,
    );
    return undefined;
  }
}
