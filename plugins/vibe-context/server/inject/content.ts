// The injected context text, ordered for prefix caching: user directives -> project instructions
// -> project memory (most stable first). The "current task" part is the dispatch brief itself,
// which comes after this block in the conversation. Pure: reads through a MemoryStore only.

import { existsSync } from "node:fs";
import { estimateTokens } from "../memory/tokens";
import type { MemoryStore } from "../memory/store";
import type { ProjectMemoryFile } from "../memory/layout";
import { DEFAULT_MEMORY_TOKENS } from "./settings";
import { defaultPrompts, type PromptResolver } from "../prompts";

export const CONTEXT_START = "<!-- vibe:context:start -->";
export const CONTEXT_END = "<!-- vibe:context:end -->";

/** Inline order: current state first, then the index, then the append-only logs. */
const MEMORY_ORDER: readonly ProjectMemoryFile[] = [
  "PROJECT_STATE.md",
  "INDEX.md",
  "DECISIONS.md",
  "LESSONS.md",
];

export interface ContextOptions {
  projectId?: string | null;
  /** Text of the frame (registry); defaults to the registered default. Execution-phase scouting was removed by WP-105. */
  prompts?: PromptResolver;
  /** Total tokens of memory file text to inline; files that do not fit are listed as pointers. */
  maxMemoryTokens?: number;
}

/** Null when the project has no `.vibe/` directory (not a myVibeBoard project: inject nothing). */
export function buildContextBlock(store: MemoryStore, options: ContextOptions = {}): string | null {
  if (!existsSync(store.layout.vibeDir)) return null;
  let remaining = options.maxMemoryTokens ?? DEFAULT_MEMORY_TOKENS;
  const prompts = options.prompts ?? defaultPrompts;
  const parts: string[] = [
    CONTEXT_START,
    prompts.resolve("context.inject_frame", { projectId: options.projectId }),
  ];

  const directives = store.readUserDirectives()?.trim();
  if (directives) parts.push("## 用户的指令", directives);

  const instructions = store.readInstructions().filter((f) => f.text.trim());
  if (instructions.length) {
    parts.push("## 项目指令");
    for (const f of instructions) parts.push(`### ${f.name}`, f.text.trim());
  }

  const memory: string[] = [];
  for (const file of MEMORY_ORDER) {
    const { entries } = store.read(file);
    if (!entries.length) continue;
    const body = entries.map((e) => e.body).join("\n\n");
    const cost = estimateTokens(body);
    if (cost > remaining) {
      memory.push(
        `### ${file}`,
        `（共 ${entries.length} 条，太长无法内联：请读 \`.vibe/${file}\`）`,
      );
    } else {
      remaining -= cost;
      memory.push(`### ${file}`, body);
    }
  }
  if (memory.length) {
    parts.push("## 项目记忆", "已降级的旧条目在 `.vibe/*_ARCHIVE.md`，需要时再读。", ...memory);
  }
  parts.push(CONTEXT_END);
  return parts.join("\n\n");
}
