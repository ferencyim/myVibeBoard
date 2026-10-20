// The injected context text, ordered for prefix caching: user directives -> project instructions
// -> project memory (most stable first). The "current task" part is the dispatch brief itself,
// which comes after this block in the conversation. Pure: reads through a MemoryStore only.

import { existsSync } from "node:fs";
import { estimateTokens } from "../memory/tokens";
import type { MemoryStore } from "../memory/store";
import type { ProjectMemoryFile } from "../memory/layout";

export const CONTEXT_START = "<!-- vibe:context:start -->";
export const CONTEXT_END = "<!-- vibe:context:end -->";

/** Inline order: current state first, then the index, then the append-only logs. */
const MEMORY_ORDER: readonly ProjectMemoryFile[] = [
  "PROJECT_STATE.md",
  "INDEX.md",
  "DECISIONS.md",
  "LESSONS.md",
];

/** Only meaningful when the board MCP offers `vibe_scout` (execution and planning sessions). */
export const SCOUT_GUIDANCE =
  "## Scouting (if the `vibe_scout` tool is available)\n" +
  "Before editing in a large repo, call `vibe_scout` once with several independent questions " +
  "(`kind`: locate / inventory / research) so cheap read-only sub-agents search in parallel; you get back " +
  "short findings with path:line anchors instead of reading everything yourself. Good for: locating code " +
  "in an unfamiliar repo, counting/listing usages in bulk, gathering facts from several sources. " +
  "Skip it for a small change in one or two known files. Verify anchors you rely on before editing.";

export const DEFAULT_MEMORY_TOKENS = 6000;

export interface ContextOptions {
  /** Total tokens of memory file text to inline; files that do not fit are listed as pointers. */
  maxMemoryTokens?: number;
}

/** Null when the project has no `.vibe/` directory (not a myVibeBoard project: inject nothing). */
export function buildContextBlock(store: MemoryStore, options: ContextOptions = {}): string | null {
  if (!existsSync(store.layout.vibeDir)) return null;
  let remaining = options.maxMemoryTokens ?? DEFAULT_MEMORY_TOKENS;
  const parts: string[] = [
    CONTEXT_START,
    "# Project context (myVibeBoard)",
    "Generated from the files under `.vibe/` when this session started. It is authoritative and " +
      "read-only for you: never edit these files; report needed corrections to the master agent " +
      "(for a board task, in a card comment).",
  ];

  parts.push(SCOUT_GUIDANCE);

  const directives = store.readUserDirectives()?.trim();
  if (directives) parts.push("## User directives", directives);

  const instructions = store.readInstructions().filter((f) => f.text.trim());
  if (instructions.length) {
    parts.push("## Project instructions");
    for (const f of instructions) parts.push(`### ${f.name}`, f.text.trim());
  }

  const memory: string[] = [];
  for (const file of MEMORY_ORDER) {
    const { entries } = store.read(file);
    if (!entries.length) continue;
    const body = entries.map((e) => e.body).join("\n\n");
    const cost = estimateTokens(body);
    if (cost > remaining) {
      memory.push(`### ${file}`, `(${entries.length} entries, too large to inline: read \`.vibe/${file}\`)`);
    } else {
      remaining -= cost;
      memory.push(`### ${file}`, body);
    }
  }
  if (memory.length) {
    parts.push(
      "## Project memory",
      "Demoted older entries are in `.vibe/*_ARCHIVE.md`; read them only when needed.",
      ...memory,
    );
  }
  parts.push(CONTEXT_END);
  return parts.join("\n\n");
}
