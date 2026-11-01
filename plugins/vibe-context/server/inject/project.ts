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
// Runs on every turn's hook: spawning git once per project, serially, exceeded the plugin RPC timeout.
const IDENTITY_TTL_MS = 60_000;
const identityCache = new Map<string, { at: number; value: Promise<string> }>();
function cachedIdentity(cwd: string): Promise<string> {
  const hit = identityCache.get(cwd);
  if (hit && Date.now() - hit.at < IDENTITY_TTL_MS) return hit.value;
  const value = identity(cwd);
  identityCache.set(cwd, { at: Date.now(), value });
  return value;
}

/** Linked worktrees retain the project's prompt override, without a second project catalog. */
export async function projectIdForDirectory(
  cwd: string,
  projects: readonly { id: string; repoPath: string }[],
): Promise<string | undefined> {
  const withPath = projects.filter((project) => project.repoPath);
  const [key, ...keys] = await Promise.all([
    cachedIdentity(cwd),
    ...withPath.map((project) => cachedIdentity(project.repoPath)),
  ]);
  const matches = withPath.filter((_, i) => keys[i] === key).map((project) => project.id);
  return matches.length === 1 ? matches[0] : undefined;
}
