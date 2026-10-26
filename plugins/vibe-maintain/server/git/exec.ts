import { execFile } from "node:child_process";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}
/** Runs `git <args>` in `cwd`. Never rejects: a failing command comes back with its exit code. */
export type GitRunner = (args: string[], cwd: string) => Promise<GitResult>;

// GIT_OPTIONAL_LOCKS=0 keeps read-only inspection from refreshing the index or taking optional
// locks, so a health check never changes a repository it is only looking at.
export const execGit: GitRunner = (args, cwd) =>
  new Promise((resolve) => {
    execFile(
      "git",
      args,
      {
        cwd,
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
        timeout: 60_000,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 128) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
