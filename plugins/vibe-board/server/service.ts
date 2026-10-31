import type { Project } from "./vibe/contract";
import { createVibeStore, migrateOwner, openVibeDb, type VibeDb, type VibeStore } from "./vibe/db";
export class BoardError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`[${code}] ${message}`);
  }
}
export interface BoardRuntime {
  db: VibeDb;
  store: VibeStore;
  close(): void;
}
export function openBoardRuntime(options: { path?: string; now?: () => Date } = {}): BoardRuntime {
  const db = openVibeDb(options.path ? { path: options.path } : {});
  migrateOwner(db, "vibe-board");
  const store = createVibeStore(db, options.now ? { now: options.now } : {});
  return { db, store, close: () => db.close() };
}
export function createBoardService({ store }: BoardRuntime) {
  function project(ref: string): Project {
    const found =
      store.projects.get(ref) ??
      store.projects.list(true).find((p) => p.paseoProjectId === ref || p.prefix === ref.toUpperCase() || p.name === ref);
    if (!found) throw new BoardError("not_found", `找不到项目：${ref}`);
    return found;
  }
  return {
    projects: {
      resolve: project,
    },
    presets: {
      list: () => ({ presets: store.presets.list() }),
      create(input: Parameters<typeof store.presets.create>[0]) {
        if (!input.model?.trim()) throw new BoardError("invalid", "预设必须填写模型");
        return { preset: store.presets.create(input) };
      },
      update(id: string, patch: Parameters<typeof store.presets.update>[1]) {
        if (patch.model !== undefined && !patch.model.trim())
          throw new BoardError("invalid", "预设必须填写模型");
        return { preset: store.presets.update(id, patch) };
      },
      delete(id: string) {
        store.presets.delete(id);
        return { deleted: true };
      },
    },
    defaults: {
      get: () => ({ global: store.modelDefaults.global() }),
      set: (global: Parameters<typeof store.modelDefaults.setGlobal>[0]) => ({
        global: store.modelDefaults.setGlobal(global),
      }),
    },
    prompts: {
      list: (projectId?: string | null) => ({
        prompts: store.prompts.list({ projectId: projectId ?? null }),
        projects: store.projects
          .list(false)
          .map((p) => ({ id: p.paseoProjectId ?? p.id, name: p.name, prefix: p.prefix })),
        orphans: store.prompts.orphans(),
      }),
      set(key: string, text: string, projectId?: string | null) {
        store.prompts.setOverride(key, text, { projectId: projectId ?? null });
        return { ok: true as const };
      },
      clear(key: string, projectId?: string | null) {
        store.prompts.clearOverride(key, { projectId: projectId ?? null });
        return { ok: true as const };
      },
    },
    store,
  };
}
export type BoardService = ReturnType<typeof createBoardService>;
