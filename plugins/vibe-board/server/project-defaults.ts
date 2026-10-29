import { findProjectConfig } from "./vibe/db/project-config";
import { createHash } from "node:crypto";
import type { BoardService } from "./service";
import type { ModelDefaults } from "./vibe/contract";

export function getProjectDefaults(board: BoardService, projectId: string, rootPath?: string) {
  return {
    global: board.store.modelDefaults.global(),
    project:
      findProjectConfig(board.store.projects.list(true), projectId, rootPath)?.defaultPresets ?? {},
  };
}

/** Native projects need no separate setup in the legacy project manager. */
export function setProjectDefaults(
  board: BoardService,
  input: { projectId: string; defaults: ModelDefaults; name: string; rootPath: string },
) {
  const existing = findProjectConfig(
    board.store.projects.list(true),
    input.projectId,
    input.rootPath,
  );
  if (existing)
    board.store.projects.update(existing.id, {
      paseoProjectId: input.projectId,
      defaultPresets: input.defaults,
    });
  else {
    const base =
      "P" + createHash("sha256").update(input.projectId).digest("hex").slice(0, 7).toUpperCase();
    const prefixes = new Set(board.store.projects.list(true).map((p) => p.prefix));
    let prefix = base;
    for (let n = 1; prefixes.has(prefix); n++) prefix = base + n;
    board.store.projects.create({
      name: input.name,
      prefix,
      repoPath: input.rootPath,
      paseoProjectId: input.projectId,
      defaultPresets: input.defaults,
    });
  }
  return getProjectDefaults(board, input.projectId);
}
