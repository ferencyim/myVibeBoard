// Token budgets and deterministic demotion. No model calls: least-recently-touched entries go first.

import { entryTokens, type MemoryEntry, type ParsedMemoryFile } from "./entries";
import type { MemoryFileRef } from "./layout";
import { estimateTokens, type TokenEstimator } from "./tokens";

/** Share of the model context window that all memory files may use together. */
export const MEMORY_WINDOW_SHARE = 0.1;
export const MIN_FILE_BUDGET = 400;

const WEIGHTS: Record<string, number> = {
  "PROJECT_STATE.md": 0.3,
  "DECISIONS.md": 0.25,
  "LESSONS.md": 0.2,
  "INDEX.md": 0.1,
  worker: 0.15, // per worker file
};

export function budgetFor(file: MemoryFileRef, contextWindowTokens: number): number {
  const weight = WEIGHTS[file] ?? WEIGHTS.worker;
  return Math.max(MIN_FILE_BUDGET, Math.floor(contextWindowTokens * MEMORY_WINDOW_SHARE * weight));
}

export interface DemoteResult {
  kept: MemoryEntry[];
  demoted: MemoryEntry[];
}

/** Least recently used first; ties broken by older `created`, then id, so the order is total. */
export const lruOrder = (a: MemoryEntry, b: MemoryEntry) =>
  a.touched.localeCompare(b.touched) ||
  a.created.localeCompare(b.created) ||
  a.id.localeCompare(b.id);

/**
 * Demote least-recently-touched entries until the file fits `budget`. The preamble counts toward
 * the budget but is never demoted. A single entry larger than the whole budget is demoted too
 * (nothing is ever dropped: it lands in the archive). `kept` preserves file order.
 */
export function demoteToBudget(
  file: ParsedMemoryFile,
  budget: number,
  estimate: TokenEstimator = estimateTokens,
): DemoteResult {
  let used =
    estimate(file.preamble) + file.entries.reduce((n, e) => n + entryTokens(e, estimate), 0);
  const kept = [...file.entries];
  const demoted: MemoryEntry[] = [];
  for (const v of [...file.entries].sort(lruOrder)) {
    if (used <= budget) break;
    kept.splice(kept.indexOf(v), 1);
    demoted.push(v);
    used -= entryTokens(v, estimate);
  }
  return { kept, demoted };
}

/** Shrink one body to roughly `budget` tokens (cut at a line boundary, keep the head). */
export function truncateBody(
  body: string,
  budget: number,
  estimate: TokenEstimator = estimateTokens,
): string {
  const note = "\n\n_(truncated; full text in the archive file)_";
  const lines = body.split("\n");
  while (lines.length > 1 && estimate(lines.join("\n") + note) > budget) lines.pop();
  return lines.join("\n") + note;
}
