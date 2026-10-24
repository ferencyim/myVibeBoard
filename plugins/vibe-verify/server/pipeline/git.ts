// Git helpers over the injectable Runner: commit hash, tree snapshots (verifier tamper check)
// and the baseline worktree for before/after comparison.

import path from "node:path";
import type { Runner } from "../vibe/contract";

async function git(runner: Runner, cwd: string, args: string[]) {
  return runner.run("git", args, { cwd, timeoutMs: 60_000 });
}

export async function headCommit(runner: Runner, cwd: string): Promise<string> {
  const r = await git(runner, cwd, ["rev-parse", "HEAD"]);
  return r.exitCode === 0 ? r.stdout.trim() : "unknown";
}

export interface Baseline {
  path: string;
  commitHash: string;
}

/**
 * Creates a detached worktree at the commit the change branched off (merge-base of HEAD with the
 * first existing candidate branch). Returns undefined when there is no such commit or HEAD is it.
 */
export async function prepareBaseline(
  runner: Runner,
  cwd: string,
  targetDir: string,
  candidates: ReadonlyArray<string | null | undefined>,
): Promise<Baseline | undefined> {
  const head = await headCommit(runner, cwd);
  for (const branch of candidates.filter((b): b is string => !!b)) {
    const mb = await git(runner, cwd, ["merge-base", "HEAD", branch]);
    const base = mb.exitCode === 0 ? mb.stdout.trim() : "";
    if (!base || base === head) continue;
    const add = await git(runner, cwd, ["worktree", "add", "--detach", targetDir, base]);
    if (add.exitCode === 0) return { path: path.resolve(targetDir), commitHash: base };
  }
  return undefined;
}

const DIFF_LIMIT = 80_000;

/**
 * The change under review: working tree against the merge-base of HEAD with the first existing
 * candidate branch (so committed and uncommitted edits are both included). Without a base,
 * falls back to the uncommitted changes only. The text is truncated, never empty-handed.
 */
export async function changeDiff(
  runner: Runner,
  cwd: string,
  candidates: ReadonlyArray<string | null | undefined>,
): Promise<{ base: string | undefined; stat: string; diff: string; truncated: boolean }> {
  let base: string | undefined;
  for (const branch of candidates.filter((b): b is string => !!b)) {
    const mb = await git(runner, cwd, ["merge-base", "HEAD", branch]);
    const hash = mb.exitCode === 0 ? mb.stdout.trim() : "";
    if (hash) {
      base = hash;
      break;
    }
  }
  const range = base ? [base] : ["HEAD"];
  const [stat, diff] = await Promise.all([
    git(runner, cwd, ["diff", "--stat", ...range, "--", ".", ":(exclude).vibe"]),
    git(runner, cwd, ["diff", ...range, "--", ".", ":(exclude).vibe"]),
  ]);
  const text = diff.stdout;
  return {
    base,
    stat: stat.stdout.trim(),
    diff: text.length > DIFF_LIMIT ? text.slice(0, DIFF_LIMIT) : text,
    truncated: text.length > DIFF_LIMIT,
  };
}
