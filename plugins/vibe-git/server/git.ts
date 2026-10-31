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


export function failedGit(cwd: string, error: unknown): Status["git"] {
  return { ...emptyGit(cwd, "error"), error: error instanceof Error ? error.message : String(error) };
}

function parseBranchHeader(header: string): { branch: string | null; upstream: string | null } {
  const match = header.match(/^## (.*?)(?:\.\.\.([^ ]+))?(?: \[.*\])?$/);
  const name = match?.[1].replace(/^(?:No commits yet on |Initial commit on )/, "") ?? null;
  return { branch: name?.startsWith("HEAD ") ? null : name, upstream: match?.[2] ?? null };
}

export function createScanState() {
  return {
    scans: new Map<string, { values: Map<string, Changes | null>; times: Map<string, string>; pendingRescan: (() => void) | null; scannedAt: string | null; scanning: boolean; error: string | null; attemptedAt: number }>(),
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
      timeoutMs: args[0] === "worktree" ? 15000 : 2500,
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

  async function gitStatus(cwd: string, force = false): Promise<Status["git"]> {
    if (!(await exists(cwd))) return emptyGit(cwd, "error");
    let paths: string;
    try {
      paths = await git(cwd, "rev-parse", "--show-toplevel", "--git-common-dir", "--git-dir");
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? "";
      return emptyGit(cwd, stderr.includes("not a git repository") ? "not_git" : "error");
    }
    const [root, common, gitDir] = paths.split(/\r?\n/);
    const mainPath = path.dirname(path.resolve(cwd, common));
    const [rawStatus, rawCommits, rawBaseRefs, rawWorktrees] =
      await Promise.all([
        maybe(cwd, "status", "--porcelain=v1", "--branch", "--untracked-files=normal"),
        maybe(cwd, "log", "-5", "--format=%h%x00%s%x00%ct"),
        maybe(cwd, "for-each-ref", "--format=%(refname)", "refs/remotes/origin/main", "refs/heads/main"),
        git(cwd, "worktree", "list", "--porcelain"),
      ]);
    const [header = "", ...statusLines] = (rawStatus ?? "").split("\n");
    const parsedBranch = parseBranchHeader(header);
    const [branch, upstream] = rawStatus === null
      ? await Promise.all([
        maybe(cwd, "symbolic-ref", "--short", "HEAD"),
        maybe(cwd, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"),
      ])
      : [parsedBranch.branch, parsedBranch.upstream];
    const commits = (rawCommits ?? "").split("\n").filter(Boolean).map((line) => {
      const [sha, subject, timestamp] = line.split("\0");
      return { sha, subject, timestamp: Number(timestamp) };
    });
    const baseRefs = new Set((rawBaseRefs ?? "").split(/\r?\n/));
    const base = baseRefs.has("refs/remotes/origin/main") ? "origin/main" : baseRefs.has("refs/heads/main") ? "main" : null;
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
    const [refs, upstreamCounts] = await Promise.all([
      base ? maybe(cwd, "for-each-ref", `--format=%(refname:short)%00%(ahead-behind:${base})`, "refs/heads") : null,
      upstream ? counts(cwd, upstream) : null,
    ]);
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
      scan = { values: new Map(), times: new Map(), pendingRescan: null, scannedAt: null, scanning: false, error: null, attemptedAt: 0 };
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
        changesScannedAt: current ? null : state.times.get(normalizePath(w.path)) ?? null,
        changes: current
          ? (rawStatus === null ? null : parseStatus(statusLines.join("\n")))
          : state.values.get(normalizePath(w.path)) ?? null,
      };
    }));
    const baseCounts = base ? (branch && refCounts.get(branch)) || await counts(cwd, base) : null;
    const startScan = () => {
      state.scanning = true;
      state.attemptedAt = Date.now();
      void (async () => {
        const candidates = worktrees.filter((w) => !w.current && !w.missing && !w.prunable);
        const failures: string[] = [];
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(3, candidates.length) }, async () => {
          while (!scanState.closed && next < candidates.length) {
            const w = candidates[next++];
            try {
              const raw = await scanRunner.run(
                "git", ["status", "--porcelain=v1", "--untracked-files=normal"],
                {
                  cwd: w.path,
                  timeoutMs: 10000,
                  env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", LANG: "C" },
                },
              );
              if (!scanState.closed) {
                state.values.set(normalizePath(w.path), parseStatus(raw));
                state.scannedAt = new Date().toISOString();
                state.times.set(normalizePath(w.path), state.scannedAt);
              }
            } catch (error) {
              failures.push(`${w.path}：${error instanceof Error ? error.message : String(error)}`);
              if (!scanState.closed) state.error = failures.join("；");
            }
          }
        }));
        if (!scanState.closed) {
          if (failures.length === 0 && candidates.length === 0) state.scannedAt = new Date().toISOString();
          state.error = failures.length ? failures.join("；") : null;
        }
      })().catch((error: unknown) => {
        state.error = error instanceof Error ? error.message : String(error);
      }).finally(() => {
        state.scanning = false;
        const pending = state.pendingRescan;
        state.pendingRescan = null;
        if (pending && isActive() && !scanState.closed) pending();
      });
    };
    if (isActive() && !scanState.closed) {
      if (state.scanning && force) state.pendingRescan = startScan;
      else if (!state.scanning && (force || Date.now() - state.attemptedAt >= 300000)) startScan();
    }
    return {
      status: "ok",
      error: null,
      workspacePath: cwd,
      mainPath,
      branch,
      headSha: commits[0]?.sha ?? null,
      headSubject: commits[0]?.subject ?? null,
      isMain: normalizePath(root) === normalizePath(mainPath),
      upstream,
      upstreamCounts,
      base,
      baseCounts,
      changes: rawStatus === null ? null : parseStatus(statusLines.join("\n")),
      operation,
      commits,
      worktrees,
      changesScannedAt: state.scannedAt,
      scanning: state.scanning,
      scanError: state.error,
    };
  }

  // Keep the first response independent of worktree enumeration and dashboard I/O.
  async function fastGitStatus(cwd: string): Promise<Status["git"]> {
    if (!(await exists(cwd))) return emptyGit(cwd, "error");
    let paths: string;
    try {
      paths = await git(cwd, "rev-parse", "--show-toplevel", "--git-common-dir");
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? "";
      return emptyGit(cwd, stderr.includes("not a git repository") ? "not_git" : "error");
    }
    const [root, common] = paths.split(/\r?\n/);
    const [statusResult, rawCommits] = await Promise.all([
      git(cwd, "status", "--porcelain=v1", "--branch", "--untracked-files=normal")
        .then((value) => ({ value, error: null }), (error: unknown) => ({
          value: null, error: error instanceof Error ? error.message : String(error),
        })),
      maybe(cwd, "log", "-5", "--format=%h%x00%s%x00%ct"),
    ]);
    if (statusResult.value === null) return { ...emptyGit(cwd, "error"), error: `读取工作区改动失败：${statusResult.error}` };
    const rawStatus = statusResult.value;
    const [header = "", ...lines] = rawStatus.split("\n");
    const { branch, upstream } = parseBranchHeader(header);
    const commits = (rawCommits ?? "").split("\n").filter(Boolean).map((line) => {
      const [sha, subject, timestamp] = line.split("\0");
      return { sha, subject, timestamp: Number(timestamp) };
    });
    const mainPath = path.dirname(path.resolve(cwd, common));
    return {
      ...emptyGit(cwd, "error"), status: "ok", mainPath,
      branch,
      headSha: commits[0]?.sha ?? null, headSubject: commits[0]?.subject ?? null,
      upstream, isMain: normalizePath(root) === normalizePath(mainPath),
      changes: parseStatus(lines.join("\n")), commits,
      scanning: true,
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

  return { gitStatus, fastGitStatus, sourceRelation };
}
