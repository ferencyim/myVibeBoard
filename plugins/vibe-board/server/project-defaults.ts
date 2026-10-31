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

/** Create or adopt an extension whenever a native project is observed. */
export function ensureProjectExtension(
  board: BoardService,
  input: { projectId: string; name: string; rootPath: string },
) {
  const existing = findProjectConfig(board.store.projects.list(true), input.projectId, input.rootPath);
  if (existing) {
    if (existing.paseoProjectId !== input.projectId || existing.name !== input.name || existing.repoPath !== input.rootPath || existing.archivedAt)
      return board.store.projects.update(existing.id, {
        paseoProjectId: input.projectId, name: input.name, repoPath: input.rootPath, archived: false,
      });
    return existing;
  }
  const base = "P" + createHash("sha256").update(input.projectId).digest("hex").slice(0, 7).toUpperCase();
  const prefixes = new Set(board.store.projects.list(true).map((p) => p.prefix));
  let prefix = base;
  for (let n = 1; prefixes.has(prefix); n++) prefix = base + n;
  return board.store.projects.create({ name: input.name, prefix, repoPath: input.rootPath, paseoProjectId: input.projectId });
}

export function setProjectDefaults(
  board: BoardService,
  input: { projectId: string; defaults: ModelDefaults; name: string; rootPath: string },
) {
  // Validate first so invalid preset IDs cannot partially change an existing extension.
  for (const id of Object.values(input.defaults).flat()) {
    if (typeof id === "string" && !board.store.presets.get(id)) throw new Error(`Preset not found: ${id}`);
  }
  const project = ensureProjectExtension(board, input);
  board.store.projects.update(project.id, { defaultPresets: input.defaults });
  return getProjectDefaults(board, input.projectId);
}
