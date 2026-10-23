import { resolve } from "node:path";
import type { PaseoWorkspace } from "@getpaseo/client";

function pathKey(path: string) {
  const normalized = resolve(path).replace(/\\/g, "/").replace(/\/$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** Native placement must be checked before persisting a task binding. Git finalization
 * also rechecks the repository itself, since placement alone cannot authorize a merge. */
export function assertTaskWorkspace(
  workspace: Pick<
    PaseoWorkspace,
    "workspaceKind" | "projectKind" | "workspaceDirectory" | "projectRootPath"
  > | null,
) {
  if (
    !workspace ||
    workspace.workspaceKind !== "worktree" ||
    workspace.projectKind !== "git" ||
    !workspace.workspaceDirectory ||
    pathKey(workspace.workspaceDirectory) === pathKey(workspace.projectRootPath)
  )
    throw new Error("任务必须绑定独立的附加 Git worktree，不能使用项目主检出或普通目录。");
}
