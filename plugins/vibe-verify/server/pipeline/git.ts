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

function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

/**
 * Git state this worktree alone owns: commit, HEAD reflog and its own branch ref. Shared
 * refs/remotes, other worktrees and the stash list change for unrelated work, so they are not
 * compared here; a mutating staging command is caught from the verifier timeline instead.
 */
export interface GitStateSnapshot {
  head: string;
  reflogCount: number;
  reflogLatest: string;
  branch: string;
  branchHead: string;
}

export async function gitStateSnapshot(runner: Runner, cwd: string): Promise<GitStateSnapshot> {
  const read = async (args: string[]) => {
    const result = await git(runner, cwd, args);
    if (result.exitCode !== 0 || result.timedOut)
      throw new Error(
        `无法记录 Git 状态快照：git ${args.join(" ")}：${result.stderr || result.stdout || "未成功结束"}`,
      );
    return normalize(result.stdout);
  };
  const [head, reflog, branchResult] = await Promise.all([
    read(["rev-parse", "HEAD"]),
    read(["reflog", "--format=%H"]),
    git(runner, cwd, ["symbolic-ref", "--quiet", "HEAD"]),
  ]);
  // Detached HEAD is valid and has no branch ref of its own.
  const branch = branchResult.exitCode === 0 ? normalize(branchResult.stdout) : "";
  const branchHead = branch ? await read(["rev-parse", branch]) : "";
  const entries = reflog ? reflog.split("\n") : [];
  return {
    head,
    reflogCount: entries.length,
    reflogLatest: entries[0] ?? "",
    branch,
    branchHead,
  };
}

/** A human-readable difference, or undefined when every recorded state is unchanged. */
export function gitStateChange(
  before: GitStateSnapshot,
  after: GitStateSnapshot,
): string | undefined {
  if (before.head !== after.head) return `HEAD 由 ${before.head} 变为 ${after.head}`;
  if (before.reflogCount !== after.reflogCount || before.reflogLatest !== after.reflogLatest)
    return `HEAD reflog 由 ${before.reflogCount} 条（最新 ${before.reflogLatest || "无"}）变为 ${after.reflogCount} 条（最新 ${after.reflogLatest || "无"}）`;
  if (before.branch !== after.branch || before.branchHead !== after.branchHead)
    return `当前分支 ${before.branch || "（游离 HEAD）"} 由 ${before.branchHead || "无"} 变为 ${after.branch || "（游离 HEAD）"} ${after.branchHead || "无"}`;
  return undefined;
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
