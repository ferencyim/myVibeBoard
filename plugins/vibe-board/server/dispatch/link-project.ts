// Links a board project to a Paseo project by repository path (WP-104). The link is kept in
// `project.paseoProjectId`; dispatch, project create and project edit all go through here, so a
// project never needs a manual "associate with Paseo" step:
//   1. an existing link that still resolves wins,
//   2. else a Paseo project whose root is the repository path,
//   3. else the repository is opened in Paseo (which registers the project) and linked.
// Only a blank or non-existent path is an error, and the message says how to fix it.

import { statSync } from "node:fs";
import type { PaseoApi, PaseoProject } from "@getpaseo/client";
import type { Project } from "../vibe/contract";
import { BoardError, type BoardService } from "../service";

export type LinkPaseo = Pick<PaseoApi, "projects" | "workspaces">;

export interface LinkOptions {
  /** Test seam; default checks the file system. */
  isDirectory?: (path: string) => boolean;
}

const normalizePath = (p: string) => p.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();

const isDirectoryOnDisk = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** The Paseo project for `project`, creating it when the repository is not known to Paseo yet. */
export async function resolvePaseoProject(
  paseo: LinkPaseo,
  project: Pick<Project, "prefix" | "repoPath" | "paseoProjectId">,
  options: LinkOptions = {},
): Promise<PaseoProject> {
  const repoPath = project.repoPath.trim();
  if (!repoPath) {
    throw new BoardError(
      "invalid",
      `项目 ${project.prefix} 没有设置仓库路径，无法关联 Paseo 项目。请在“管理 → 项目”里填写本地仓库路径。`,
    );
  }
  const { projects } = await paseo.projects.list();
  const ref = project.paseoProjectId;
  const existing = ref
    ? projects.find(
        (p) => p.projectId === ref || p.projectRootPath === ref || p.projectDisplayName === ref,
      )
    : undefined;
  if (existing) return existing;
  const byPath = projects.find((p) => normalizePath(p.projectRootPath) === normalizePath(repoPath));
  if (byPath) return byPath;

  if (!(options.isDirectory ?? isDirectoryOnDisk)(repoPath)) {
    throw new BoardError(
      "invalid",
      `项目 ${project.prefix} 的仓库路径不存在或不是目录：${repoPath}。请在“管理 → 项目”里改成存在的本地仓库目录。`,
    );
  }
  let opened;
  try {
    opened = await paseo.workspaces.open(repoPath);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new BoardError("dispatch_failed", `Paseo 无法打开仓库 ${repoPath}：${reason}`);
  }
  const after = (await paseo.projects.list()).projects;
  const created =
    after.find((p) => opened.projectId && p.projectId === opened.projectId) ??
    after.find((p) => normalizePath(p.projectRootPath) === normalizePath(repoPath));
  if (!created) {
    throw new BoardError("dispatch_failed", `Paseo 打开了 ${repoPath}，但没有生成对应的项目，请在 Paseo 里手动添加该目录`);
  }
  return created;
}

/** Resolve the Paseo project and persist `paseoProjectId` when it changed. */
export async function linkPaseoProject(
  board: Pick<BoardService, "projects">,
  paseo: LinkPaseo,
  project: Project,
  options: LinkOptions = {},
): Promise<{ project: Project; paseoProject: PaseoProject }> {
  const paseoProject = await resolvePaseoProject(paseo, project, options);
  if (project.paseoProjectId === paseoProject.projectId) return { project, paseoProject };
  const { project: updated } = board.projects.update(project.id, { paseoProjectId: paseoProject.projectId });
  return { project: updated, paseoProject };
}
