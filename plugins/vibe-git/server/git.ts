import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Status } from "../shared/rpc";
import { normalizePath, parseCounts, parseStatus, parseWorktrees } from "./parse";

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec("git", args, {
    cwd,
    timeout: 5000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", LANG: "C" },
  })).stdout.trimEnd();
}

async function maybe(cwd: string, ...args: string[]): Promise<string | null> {
  try {
    return await git(cwd, ...args);
  } catch {
    return null;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export function emptyGit(cwd: string, status: "error" | "not_git"): Status["git"] {
  return {
    status,
    error: null,
    workspacePath: cwd,
    mainPath: null,
    branch: null,
    headSha: null,
    headSubject: null,
    isMain: false,
    upstream: null,
    upstreamCounts: null,
    base: null,
    baseCounts: null,
    changes: null,
    operation: null,
    commits: [],
    worktrees: [],
  };
}

async function counts(cwd: string, base: string, ref = "HEAD") {
  const raw = await maybe(cwd, "rev-list", "--left-right", "--count", `${ref}...${base}`);
  return raw === null ? null : parseCounts(raw);
}

export async function gitStatus(cwd: string): Promise<Status["git"]> {
  if (!(await exists(cwd))) return emptyGit(cwd, "error");
  let root: string;
  try {
    root = await git(cwd, "rev-parse", "--show-toplevel");
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    return emptyGit(cwd, stderr.includes("not a git repository") ? "not_git" : "error");
  }
  const common = await git(cwd, "rev-parse", "--git-common-dir");
  const mainPath = path.dirname(path.resolve(cwd, common));
  const [branch, headSha, headSubject, upstream, origin, local, rawStatus, rawCommits, rawWorktrees, gitDir] =
    await Promise.all([
      maybe(cwd, "symbolic-ref", "--short", "HEAD"),
      maybe(cwd, "rev-parse", "--short", "HEAD"),
      maybe(cwd, "log", "-1", "--format=%s"),
      maybe(cwd, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"),
      maybe(cwd, "rev-parse", "--verify", "refs/remotes/origin/main"),
      maybe(cwd, "rev-parse", "--verify", "refs/heads/main"),
      maybe(cwd, "status", "--porcelain=v1", "--untracked-files=normal"),
      maybe(cwd, "log", "-5", "--format=%h%x00%s%x00%ct"),
      git(cwd, "worktree", "list", "--porcelain"),
      git(cwd, "rev-parse", "--git-dir"),
    ]);
  const base = origin ? "origin/main" : local ? "main" : null;
  const absoluteGitDir = path.resolve(cwd, gitDir);
  let operation: string | null = null;
  for (const [file, name] of [
    ["MERGE_HEAD", "merge"],
    ["rebase-merge", "rebase"],
    ["rebase-apply", "rebase"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
  ]) {
    if (await exists(path.join(absoluteGitDir, file))) {
      operation = name;
      break;
    }
  }
  const entries = parseWorktrees(rawWorktrees);
  const worktrees: Status["git"]["worktrees"] = new Array(entries.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, entries.length) }, async () => {
    while (next < entries.length) {
      const i = next++;
      const w = entries[i];
      const missing = !(await exists(w.path));
      const [status, comparison] = missing ? [null, null] : await Promise.all([
        maybe(w.path, "status", "--porcelain=v1", "--untracked-files=normal"),
        base ? counts(w.path, base) : Promise.resolve(null),
      ]);
      worktrees[i] = {
        ...w,
        current: normalizePath(w.path) === normalizePath(root),
        missing,
        counts: comparison,
        merged: comparison ? comparison.ahead === 0 : null,
        changes: status === null ? null : parseStatus(status),
      };
    }
  }));
  return {
    status: "ok",
    error: null,
    workspacePath: cwd,
    mainPath,
    branch,
    headSha,
    headSubject,
    isMain: normalizePath(root) === normalizePath(mainPath),
    upstream,
    upstreamCounts: upstream ? await counts(cwd, upstream) : null,
    base,
    baseCounts: base ? await counts(cwd, base) : null,
    changes: rawStatus === null ? null : parseStatus(rawStatus),
    operation,
    commits: (rawCommits ?? "").split("\n").filter(Boolean).map((line) => {
      const [sha, subject, timestamp] = line.split("\0");
      return { sha, subject, timestamp: Number(timestamp) };
    }),
    worktrees,
  };
}

export async function sourceRelation(
  cwd: string,
  sha: string | null,
): Promise<{ status: "same" | "behind" | "unknown"; count: number | null }> {
  if (!sha || !/^[a-f\d]{4,64}$/i.test(sha)) return { status: "unknown", count: null };
  const comparison = await counts(cwd, "origin/main", sha);
  if (!comparison || comparison.ahead !== 0) return { status: "unknown", count: null };
  return comparison.behind === 0
    ? { status: "same", count: 0 }
    : { status: "behind", count: comparison.behind };
}
