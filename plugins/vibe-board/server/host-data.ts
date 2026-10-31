import { ensureProjectExtension } from "./project-defaults";
import type { BoardService } from "./service";
import type { PaseoApi } from "@getpaseo/client";

/** Serve the last success while an expired entry refreshes; forced reads await the refresh. */
export function cacheHostRead<T>(load: () => Promise<T>, ttlMs: number, now = Date.now) {
  let cached: { value: T; expiresAt: number } | undefined;
  let pending: Promise<T> | undefined;
  let retryAt = 0;
  const refresh = () => {
    if (pending) return pending;
    pending = Promise.resolve().then(load).then((value) => {
      cached = { value, expiresAt: now() + ttlMs };
      retryAt = 0;
      return value;
    }).catch((error) => {
      retryAt = now() + 5_000;
      throw error;
    }).finally(() => {
      pending = undefined;
    });
    return pending;
  };
  return (force = false) => {
    if (force || !cached) return refresh();
    if (now() >= cached.expiresAt && now() >= retryAt) void refresh().catch(() => {});
    return Promise.resolve(cached.value);
  };
}

type ProjectList = Awaited<ReturnType<PaseoApi["projects"]["list"]>>;
const projectBoards = new WeakMap<PaseoApi, BoardService>();

export function associateHostProjects(paseo: PaseoApi, board: BoardService) {
  projectBoards.set(paseo, board);
  return listHostProjects(paseo, true);
}

const projectLists = new WeakMap<PaseoApi, (force?: boolean) => Promise<ProjectList>>();

/** One cache per connected host API, shared by tabs, sidebar, settings and documents. */
export function listHostProjects(paseo: PaseoApi, force = false): Promise<ProjectList> {
  let read = projectLists.get(paseo);
  if (!read) {
    read = cacheHostRead(async () => {
      const result = await paseo.projects.list();
      const board = projectBoards.get(paseo);
      if (board) for (const project of result.projects) {
        try {
          ensureProjectExtension(board, {
            projectId: project.projectId,
            name: project.projectCustomName?.trim() || project.projectDisplayName || project.projectId,
            rootPath: project.projectRootPath,
          });
        } catch (error) {
          console.error("[vibe-board] 项目扩展关联失败", project.projectId, error);
        }
      }
      return result;
    }, 30_000);
    projectLists.set(paseo, read);
  }
  return read(force);
}
