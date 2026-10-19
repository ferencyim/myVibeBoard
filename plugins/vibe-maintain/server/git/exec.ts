import { execFile } from "node:child_process";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}
/** Runs `git <args>` in `cwd`. Never rejects: a failing command comes back with its exit code. */
export type GitRunner = (args: string[], cwd: string) => Promise<GitResult>;

export const execGit: GitRunner = (args, cwd) =>
  new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 60_000 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 128) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
