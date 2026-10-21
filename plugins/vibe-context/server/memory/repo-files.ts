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
    "## 项目上下文（myVibeBoard）",
    "",
    "项目目标、指令、决策、经验教训和当前状态都在 `.vibe/` 目录。",
    "先读 `.vibe/INDEX.md` 和 `.vibe/PROJECT_STATE.md`；用户的规则在 `.vibe/instructions/`。",
    "这些文件是权威依据，对你只读：需要修改时请告知总 agent，不要自己改。",
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
