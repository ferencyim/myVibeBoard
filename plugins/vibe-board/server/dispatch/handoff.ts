// The planning session's hand-off summary (vibe-master, WP-33), found by file convention
// (`<repo>/.vibe/sessions/<KEY>-plan.md`, vibe-context `layout.sessionMd`) with the `handoff`
// card event as fallback (the worker runs in another worktree, so the text is inlined in the brief).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CardEvent, CardView, Project } from "../vibe/contract";
import type { PlanHandoff } from "./brief";

export const handoffFile = (repoPath: string, cardKey: string) =>
  join(repoPath, ".vibe", "sessions", `${cardKey}-plan.md`);

export function loadHandoff(
  project: Pick<Project, "repoPath">,
  card: Pick<CardView, "key">,
  events: readonly CardEvent[],
): PlanHandoff | null {
  if (project.repoPath) {
    const path = handoffFile(project.repoPath, card.key);
    try {
      const text = readFileSync(path, "utf8").replace(/\r\n/g, "\n").trim();
      if (text) return { path, text };
    } catch {
      // no file: fall back to the card event
    }
  }
  for (const e of [...events].reverse()) {
    const body = e.body as { kind?: string; text?: string } | null;
    if (e.type === "note" && body?.kind === "handoff" && body.text?.trim()) {
      return { path: null, text: body.text.trim() };
    }
  }
  return null;
}
