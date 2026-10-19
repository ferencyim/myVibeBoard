export const BOARD_INSTRUCTIONS_MARKER = "[vibe-board]";

export function buildBoardInstructions(): string {
  return `${BOARD_INSTRUCTIONS_MARKER}
# Vibe Board
Cards live in five columns: draft, todo, in_progress, verifying, done. You work with them through the \`vibe-board\` CLI on your PATH or the \`vibe-board\` MCP tools.
- Read a card: \`vibe-board show ABC-12\` / MCP \`vibe_show\` (description, acceptance criteria, reference images, timeline)
- List cards: \`vibe-board list [--project ABC] [--column todo]\` / MCP \`vibe_list\`
- Create a card (lands in draft): \`vibe-board create --project ABC --title "..."\` / MCP \`vibe_create\`
- Update fields: \`vibe-board update ABC-12 --acceptance "..."\` / MCP \`vibe_update\`
- Report progress or ask questions: \`vibe-board comment ABC-12 --body "..."\` / MCP \`vibe_comment\`
- Attach files: \`vibe-board attachment add ABC-12 --file ./out.png\` / MCP \`vibe_attach\`; fetch: \`vibe-board attachment get <id> --out ./file\`
- Save session progress notes when asked: MCP \`vibe_session_note\` (writes \`.vibe/sessions/<card>.md\` in your worktree, no approval needed)
You cannot move cards between columns; people and the board decide that.`;
}
