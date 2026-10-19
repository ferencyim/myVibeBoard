// Pure helpers for the files myVibeBoard asks of a user repository. They only compute text;
// callers decide whether to write it.

export const GITIGNORE_RULES = [".vibe/sessions/", ".vibe/workers/"] as const;

const GITIGNORE_HEADER = "# myVibeBoard: local session logs and per-agent notes (memory files are committed)";

/** Return `existing` with the myVibeBoard rules appended if missing. Idempotent. */
export function mergeGitignore(existing: string): string {
  const have = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const missing = GITIGNORE_RULES.filter((r) => !have.has(r));
  if (!missing.length) return existing;
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const sep = existing === "" || existing.endsWith("\n") ? "" : eol;
  const gap = existing === "" ? "" : eol;
  return `${existing}${sep}${gap}${[GITIGNORE_HEADER, ...missing].join(eol)}${eol}`;
}

export const AGENTS_BLOCK_START = "<!-- vibe:agents-guide:start -->";
export const AGENTS_BLOCK_END = "<!-- vibe:agents-guide:end -->";

/** The only text myVibeBoard puts in a repo-root AGENTS.md: a pointer to .vibe/. */
export function renderAgentsGuide(): string {
  return [
    AGENTS_BLOCK_START,
    "## Project context (myVibeBoard)",
    "",
    "Project goals, instructions, decisions, lessons and current state live in `.vibe/`.",
    "Start with `.vibe/INDEX.md` and `.vibe/PROJECT_STATE.md`; read `.vibe/instructions/` for the",
    "owner's rules. These files are authoritative and read-only for you: report changes to the",
    "master agent instead of editing them.",
    AGENTS_BLOCK_END,
  ].join("\n");
}

/** Insert or refresh the guide block in an existing AGENTS.md (or create the text). Idempotent. */
export function mergeAgentsMd(existing: string): string {
  const block = renderAgentsGuide();
  const start = existing.indexOf(AGENTS_BLOCK_START);
  const end = existing.indexOf(AGENTS_BLOCK_END);
  if (start >= 0 && end > start) {
    return existing.slice(0, start) + block + existing.slice(end + AGENTS_BLOCK_END.length);
  }
  if (existing.trim() === "") return `${block}\n`;
  return `${existing.replace(/\s+$/, "")}\n\n${block}\n`;
}
