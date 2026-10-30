import { access } from "node:fs/promises";
import path from "node:path";
import type { Changes, Status } from "../shared/rpc";
import { normalizePath, parseCounts, parseStatus, parseWorktrees } from "./parse";
import type { ProcessRunner } from "./process";

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


export function createScanState() {
  return {
    scans: new Map<string, { values: Map<string, Changes | null>; scannedAt: string | null; scanning: boolean }>(),
    closed: false,
  };
}
export function createGitService(
  runner: ProcessRunner,
  scanRunner: ProcessRunner,
  scanState: ReturnType<typeof createScanState>,
  isActive: () => boolean = () => true,
) {
  const scans = scanState.scans;
  async function git(cwd: string, ...args: string[]): Promise<string> {
    return runner.run("git", args, {
      cwd,
      timeoutMs: 2500,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", LANG: "C" },
    });
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


  async function counts(cwd: string, base: string, ref = "HEAD") {
    const raw = await maybe(cwd, "rev-list", "--left-right", "--count", `${ref}...${base}`);
    return raw === null ? null : parseCounts(raw);
  }

  async function gitStatus(cwd: string): Promise<Status["git"]> {
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
    const refs = base
      ? await maybe(cwd, "for-each-ref", `--format=%(refname:short)%00%(ahead-behind:${base})`, "refs/heads")
      : null;
    const refCounts = new Map<string, { ahead: number; behind: number }>();
    for (const line of (refs ?? "").split("\n")) {
      const [name, raw] = line.split("\0");
      const parsed = raw ? parseCounts(raw) : null;
      if (parsed) refCounts.set(name, parsed);
    }
    const detachedHeads = new Map(rawWorktrees.trim().split(/\r?\n\r?\n/).map((block) => {
      const lines = block.split(/\r?\n/);
      return [
        lines.find((line) => line.startsWith("worktree "))?.slice(9) ?? "",
        lines.find((line) => line.startsWith("HEAD "))?.slice(5, 12) ?? "",
      ];
    }));
    const key = normalizePath(mainPath);
    let scan = scans.get(key);
    if (!scan) {
      scan = { values: new Map(), scannedAt: null, scanning: false };
      scans.set(key, scan);
    }
    const state = scan;
    const worktrees = await Promise.all(entries.map(async (w) => {
      const current = normalizePath(w.path) === normalizePath(root);
      const missing = !(await exists(w.path));
      const comparison = w.branch ? refCounts.get(w.branch) ?? null : null;
      return {
        ...w,
        branch: w.branch ?? (w.detached ? detachedHeads.get(w.path) || null : null),
        current,
        missing,
        counts: comparison,
        merged: comparison ? comparison.ahead === 0 : null,
        changes: current
          ? (rawStatus === null ? null : parseStatus(rawStatus))
          : state.values.get(normalizePath(w.path)) ?? null,
      };
    }));
    const upstreamCounts = upstream ? await counts(cwd, upstream) : null;
    const baseCounts = base ? await counts(cwd, base) : null;
    if (
      isActive() && !scanState.closed && !state.scanning &&
      (!state.scannedAt || Date.now() - Date.parse(state.scannedAt) >= 300000)
    ) {
      state.scanning = true;
      void (async () => {
        const values = new Map<string, Changes | null>();
        for (const w of worktrees) {
          if (scanState.closed) return;
          if (w.current || w.missing || w.prunable) continue;
          try {
            const raw = await scanRunner.run(
              "git", ["status", "--porcelain=v1", "--untracked-files=normal"],
              {
                cwd: w.path,
                timeoutMs: 10000,
                env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", LANG: "C" },
              },
            );
            values.set(normalizePath(w.path), parseStatus(raw));
          } catch {
            values.set(normalizePath(w.path), null);
          }
        }
        if (!scanState.closed) {
          state.values = values;
          state.scannedAt = new Date().toISOString();
        }
      })().finally(() => {
        state.scanning = false;
      });
    }
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
      upstreamCounts,
      base,
      baseCounts,
      changes: rawStatus === null ? null : parseStatus(rawStatus),
      operation,
      commits: (rawCommits ?? "").split("\n").filter(Boolean).map((line) => {
        const [sha, subject, timestamp] = line.split("\0");
        return { sha, subject, timestamp: Number(timestamp) };
      }),
      worktrees,
      changesScannedAt: state.scannedAt,
      scanning: state.scanning,
    };
  }

  async function sourceRelation(
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

  return { gitStatus, sourceRelation };
}
