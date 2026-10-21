import { defaultPrompts, type PromptResolver } from "../prompts";

/** Fixed by code (not editable): lets injectBoard skip a prompt that already carries the text. */
export const BOARD_INSTRUCTIONS_MARKER = "[vibe-board]";

/** Marker + the (possibly overridden) `board.instructions` text. Global scope: there is no card yet. */
export function buildBoardInstructions(prompts: PromptResolver = defaultPrompts): string {
  return `${BOARD_INSTRUCTIONS_MARKER}
${prompts.resolve("board.instructions")}`;
}
