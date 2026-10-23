import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
const run = promisify(execFile);
async function identity(cwd: string): Promise<string> {
  try {
    const { stdout } = await run(
      "git",
      ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { windowsHide: true, timeout: 5000 },
    );
    return await realpath(stdout.trim());
  } catch {
    return await realpath(cwd).catch(() => resolve(cwd));
  }
}
/** Linked worktrees retain the project's prompt override, without a second project catalog. */
export async function projectIdForDirectory(
  cwd: string,
  projects: readonly { id: string; repoPath: string }[],
): Promise<string | undefined> {
  const key = await identity(cwd);
  const matches: string[] = [];
  for (const project of projects)
    if (project.repoPath && (await identity(project.repoPath)) === key) matches.push(project.id);
  return matches.length === 1 ? matches[0] : undefined;
}
