// Built-in "git health" check (deterministic, no model).
//
// One row per object (branch + its worktree, a detached worktree, or the main workspace), with a
// deterministic advice class per row. The planning agent only verifies this ledger and writes the
// decision-ready plan; it does not re-derive classifications from a flat list of findings.

import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { CheckContext, CheckFn, CheckOutput, Finding } from "../types";
import type { GitRunner } from "./exec";

export interface GitCheckOptions {
  /** A merged, clean, inactive object older than this can be cleaned up. */
  cleanupAfterDays: number;
  largeFileMb: number;
  /** Look for outdated npm dependencies (needs network). */
  outdated: boolean;
}

export const GIT_CHECK_DEFAULTS: GitCheckOptions = {
  cleanupAfterDays: 7,
  largeFileMb: 5,
  outdated: true,
};

export interface OutdatedPackage {
  name: string;
  current: string;
  latest: string;
}
export type OutdatedFn = (repoPath: string) => Promise<OutdatedPackage[] | null>;

/** `npm outdated --json` (exit code 1 = something is outdated). null = not an npm project / failed. */
export const npmOutdated: OutdatedFn = async (repoPath) => {
  if (!existsSync(join(repoPath, "package.json"))) return null;
  return new Promise((resolve) => {
    execFile(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["outdated", "--json"],
      { cwd: repoPath, timeout: 90_000, shell: process.platform === "win32", windowsHide: true },
      (_error, stdout) => {
        try {
          const parsed = JSON.parse(String(stdout || "{}")) as Record<
            string,
            { current?: string; latest?: string }
          >;
          resolve(
            Object.entries(parsed)
              .filter(([, v]) => v.current && v.latest && v.current !== v.latest)
              .map(([name, v]) => ({ name, current: v.current!, latest: v.latest! })),
          );
        } catch {
          resolve(null);
        }
      },
    );
  });
};

export type GitVerdict = "cleanup" | "merge" | "decide" | "keep";

export const VERDICT_LABELS: Record<GitVerdict, string> = {
  cleanup: "可清理",
  merge: "建议合并",
  decide: "需你决定",
  keep: "保留",
};

/** One ledger row: a branch (with its worktree when it has one), a detached worktree, or the main workspace. */
export interface GitLedgerRow {
  branch: string | null;
  worktreePath: string | null;
  directoryExists: boolean;
  prunable: boolean;
  locked: boolean;
  isMain: boolean;
  /** Commit time of the branch tip; null when the ref has no commit (unborn branch). */
  lastCommitUnix: number | null;
  ageDays: number | null;
  /** Commits only on the branch / only on the trunk. null = not computed. */
  ahead: number | null;
  behind: number | null;
  /** null = no trunk or not computed. */
  merged: boolean | null;
  upstream: string | null;
  /** True when git reports upstream "[gone]"; unpushed is then measured against all remote refs. */
  upstreamGone: boolean;
  /** Commits not pushed to the upstream, or (without one) not contained in any remote ref. */
  unpushed: number | null;
  /** null = no remote to compare with. */
  containedInRemote: boolean | null;
  trackedChanges: number;
  untrackedFiles: number;
  changedSample: string[];
  /** null = not applicable/not checked, [] = checked with no conflicts. */
  conflictFiles: string[] | null;
  verdict: GitVerdict;
  reasons: string[];
}

export interface GitLargeFile {
  path: string;
  size: number;
}

export interface GitOriginTrunk {
  /** Commits the local trunk has and origin does not. */
  ahead: number;
  /** Commits origin has and the local trunk does not. */
  behind: number;
  /** mtime of FETCH_HEAD; null when it does not exist. */
  fetchHeadAt: Date | null;
}

export interface GitReport {
  trunk: string | null;
  originTrunk: GitOriginTrunk | null;
  hasRemote: boolean;
  mainPath: string;
  mainClean: boolean;
  branchCount: number;
  worktreeCount: number;
  /** Activity window in days, as used to classify rows. */
  cleanupAfterDays: number;
  rows: GitLedgerRow[];
  largeFiles: GitLargeFile[];
  largeFileMb: number;
  outdated: OutdatedPackage[] | null;
  notes: string[];
}

export interface GitInspectInput {
  repoPath: string;
  now: Date;
  git: GitRunner;
  options: GitCheckOptions;
  /** null = skip the dependency check. */
  outdated: OutdatedFn | null;
}

function readOptions(raw: Record<string, unknown>): GitCheckOptions {
  const num = (v: unknown, d: number) => (typeof v === "number" && v > 0 ? v : d);
  return {
    cleanupAfterDays: num(
      raw.cleanup_after_days ?? raw.cleanupAfterDays,
      GIT_CHECK_DEFAULTS.cleanupAfterDays,
    ),
    largeFileMb: num(raw.large_file_mb ?? raw.largeFileMb, GIT_CHECK_DEFAULTS.largeFileMb),
    outdated: typeof raw.outdated === "boolean" ? raw.outdated : GIT_CHECK_DEFAULTS.outdated,
  };
}

const lines = (text: string) => text.split(/\r?\n/).filter((l) => l.length > 0);
const norm = (p: string) => p.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();

interface BranchInfo {
  name: string;
  commitUnix: number | null;
  upstream: string | null;
  track: string;
}

interface WorktreeEntry {
  path: string;
  branch: string | null;
  prunable: boolean;
  locked: boolean;
  main: boolean;
}

export async function trunkOf(git: GitRunner, cwd: string): Promise<string | null> {
  for (const name of ["main", "master"]) {
    if ((await git(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], cwd)).code === 0) {
      return name;
    }
  }
  const head = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd);
  return head.code === 0 ? head.stdout.trim() || null : null;
}

function splitCount(text: string): { left: number; right: number } {
  const [left = "0", right = "0"] = (lines(text)[0] ?? "").split(/\s+/);
  return { left: Number(left) || 0, right: Number(right) || 0 };
}

function parseWorktrees(stdout: string): WorktreeEntry[] {
  return stdout
    .split(/\r?\n\r?\n/)
    .filter((block) => block.trim())
    .map((block, index) => {
      const entries = lines(block);
      const field = (key: string) =>
        entries.find((l) => l.startsWith(`${key} `))?.slice(key.length + 1) ?? "";
      const branchRef = field("branch");
      return {
        path: field("worktree"),
        branch: branchRef ? branchRef.replace(/^refs\/heads\//, "") : null,
        prunable: entries.some((l) => l === "prunable" || l.startsWith("prunable ")),
        locked: entries.some((l) => l === "locked" || l.startsWith("locked ")),
        main: index === 0,
      };
    });
}

/** Runs up to `limit` tasks at a time; 100+ worktrees must not take one git call at a time. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await run(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const INSPECT_CONCURRENCY = 12;

interface DirtyState {
  tracked: number;
  untracked: number;
  sample: string[];
}

async function dirtyState(git: GitRunner, path: string): Promise<DirtyState> {
  const status = lines(
    (await git(["-c", "core.quotePath=false", "status", "--porcelain"], path)).stdout,
  );
  const untracked = status.filter((line) => line.startsWith("?? "));
  const tracked = status.filter((line) => !line.startsWith("?? "));
  return {
    tracked: tracked.length,
    untracked: untracked.length,
    sample: status.slice(0, 5).map((line) => line.slice(3).trim()),
  };
}

function dirtyText(row: GitLedgerRow): string {
  const parts: string[] = [];
  if (row.trackedChanges) parts.push(`${row.trackedChanges} 个已跟踪改动`);
  if (row.untrackedFiles) parts.push(`${row.untrackedFiles} 个未跟踪文件`);
  const total = row.trackedChanges + row.untrackedFiles;
  const sample = row.changedSample.length
    ? `：${row.changedSample.join("、")}${total > row.changedSample.length ? " 等" : ""}`
    : "";
  return parts.join(" / ") + sample;
}

function conflictText(row: GitLedgerRow): string {
  const files = row.conflictFiles ?? [];
  const shown = files.slice(0, 3).join("、");
  return files.length > 3 ? `${files.length} 个文件：${shown} 等` : `文件：${shown}`;
}

function classifyRow(
  row: GitLedgerRow,
  trunk: string | null,
  options: GitCheckOptions,
): { verdict: GitVerdict; reasons: string[] } {
  if (row.locked) {
    return {
      verdict: "decide",
      reasons: ["worktree 已锁定", ...(row.prunable || !row.directoryExists ? ["目录已不存在"] : [])],
    };
  }
  if (row.worktreePath && (!row.directoryExists || row.prunable)) {
    return {
      verdict: "cleanup",
      reasons: ["目录已不存在，执行 `git worktree prune` 清理登记（不删除分支）"],
    };
  }
  if (row.isMain) {
    if (row.trackedChanges + row.untrackedFiles > 0)
      return { verdict: "decide", reasons: [`主工作区有未提交改动（${dirtyText(row)}）`] };
    return { verdict: "keep", reasons: ["主工作区干净"] };
  }
  if (!row.branch) {
    const reasons: string[] = [];
    if (row.trackedChanges + row.untrackedFiles > 0)
      reasons.push(`有未提交改动（${dirtyText(row)}）`);
    if (row.unpushed !== null && row.unpushed > 0)
      reasons.push(`HEAD 有 ${row.unpushed} 个提交未被任何远端引用包含`);
    if (row.conflictFiles?.length)
      reasons.push(`合并进 ${trunk} 会冲突（${conflictText(row)}）`);
    if (row.merged === false && row.conflictFiles === null)
      reasons.push("冲突预检不可用（需要 git 2.38+）");
    if (row.merged === null) reasons.push("无法判断 HEAD 是否已合并进主干");
    if (row.ahead !== null && row.ahead > 0 && (row.unpushed ?? 0) === 0)
      reasons.push(`HEAD 有 ${row.ahead} 个不在主干中的提交`);
    if (row.ageDays === null) reasons.push("无法确定最近提交时间");
    else if (row.ageDays < options.cleanupAfterDays)
      reasons.push(
        `最近提交在 ${row.ageDays} 天前，仍在 ${options.cleanupAfterDays} 天活动窗口内，可能有会话在用`,
      );
    if (reasons.length) return { verdict: "decide", reasons: ["detached worktree 没有分支", ...reasons] };
    if (row.merged)
      return {
        verdict: "cleanup",
        reasons: [
          "detached worktree 没有分支",
          `HEAD 的提交已在 ${trunk} 中`,
          "worktree 干净",
          "没有未推送或未被远端包含的提交",
          `最近提交在 ${row.ageDays} 天前（超过 ${options.cleanupAfterDays} 天）`,
        ],
      };
    return { verdict: "decide", reasons: ["detached worktree 没有分支，需确认是否还要"] };
  }
  if (!trunk) return { verdict: "decide", reasons: ["找不到主干（main/master/origin HEAD），无法判断"] };
  if (row.branch === trunk) {
    if (row.trackedChanges + row.untrackedFiles > 0)
      return { verdict: "decide", reasons: [`主干分支的 worktree 有未提交改动（${dirtyText(row)}）`] };
    return { verdict: "keep", reasons: ["主干本身"] };
  }

  const blockers: string[] = [];
  if (row.trackedChanges + row.untrackedFiles > 0)
    blockers.push(`有未提交改动（${dirtyText(row)}）`);
  if (row.merged === null) blockers.push("无法判断是否已合并进主干");
  if (row.ahead === null) blockers.push("无法计算与主干的差距");
  if (row.conflictFiles?.length) blockers.push(`合并进 ${trunk} 会冲突（${conflictText(row)}）`);
  if (row.merged === false && row.conflictFiles === null)
    blockers.push("冲突预检不可用（需要 git 2.38+）");
  if (row.unpushed !== null && row.unpushed > 0)
    blockers.push(
      row.upstream && !row.upstreamGone
        ? `有 ${row.unpushed} 个提交未推送到 ${row.upstream}`
        : `有 ${row.unpushed} 个提交未被任何远端引用包含`,
    );
  if (row.ageDays === null) blockers.push("无法确定最近提交时间");
  else if (row.ageDays < options.cleanupAfterDays)
    blockers.push(
      `最近提交在 ${row.ageDays} 天前，仍在 ${options.cleanupAfterDays} 天活动窗口内，可能有会话在用`,
    );
  if (blockers.length) return { verdict: "decide", reasons: blockers };

  if (row.merged) {
    return {
      verdict: "cleanup",
      reasons: [
        `已合并进 ${trunk}`,
        row.worktreePath ? "worktree 干净" : "没有 worktree",
        "没有未推送或未被远端包含的独有提交",
        `最近提交在 ${row.ageDays} 天前（超过 ${options.cleanupAfterDays} 天）`,
      ],
    };
  }
  if (row.ahead !== null && row.ahead > 0) {
    return {
      verdict: "merge",
      reasons: [
        `未合并，领先 ${trunk} ${row.ahead} 个提交、落后 ${row.behind ?? 0} 个`,
        "预检无冲突",
        row.worktreePath ? "worktree 干净" : "没有 worktree",
        `最近提交在 ${row.ageDays} 天前（超过 ${options.cleanupAfterDays} 天）`,
      ],
    };
  }
  return { verdict: "decide", reasons: ["未合并，但无法确认有独有提交"] };
}

/** Reads the whole repository state. Read-only: no fetch, no ref/index changes. */
export async function inspectGitRepo(input: GitInspectInput): Promise<GitReport> {
  const { git, options } = input;
  const cwd = input.repoPath;
  const notes: string[] = [];
  if (!cwd || (await git(["rev-parse", "--git-dir"], cwd)).code !== 0) {
    throw new Error(`Not a git repository: ${cwd || "(empty path)"}`);
  }

  const trunk = await trunkOf(git, cwd);
  if (!trunk) notes.push("找不到主干分支（main/master/origin HEAD），分支状态无法完整判断。");

  const hasRemote = lines((await git(["remote"], cwd)).stdout).length > 0;
  if (!hasRemote) notes.push("仓库没有配置远端，未推送检查已跳过。");

  let originTrunk: GitOriginTrunk | null = null;
  if (trunk) {
    const originRef = `refs/remotes/origin/${trunk}`;
    if ((await git(["rev-parse", "--verify", "--quiet", originRef], cwd)).code === 0) {
      const counts = splitCount(
        (await git(["rev-list", "--left-right", "--count", `origin/${trunk}...${trunk}`], cwd))
          .stdout,
      );
      const fetchHeadPath = (await git(["rev-parse", "--git-path", "FETCH_HEAD"], cwd)).stdout
        .trim();
      const absolute = fetchHeadPath
        ? isAbsolute(fetchHeadPath)
          ? fetchHeadPath
          : resolve(cwd, fetchHeadPath)
        : "";
      originTrunk = {
        ahead: counts.right,
        behind: counts.left,
        fetchHeadAt:
          absolute && existsSync(absolute) ? statSync(absolute).mtime : null,
      };
    } else if (hasRemote) {
      notes.push(`没有 origin/${trunk} 远端引用，本地主干与远端未比较。`);
    }
  }

  const refs = await git(
    [
      "for-each-ref",
      "--format=%(refname:short)%09%(committerdate:unix)%09%(upstream:short)%09%(upstream:track)",
      "refs/heads",
    ],
    cwd,
  );
  const branches: BranchInfo[] = lines(refs.stdout).map((line) => {
    const [name = "", unix = "", upstream = "", track = ""] = line.split("\t");
    const commitUnix = Number(unix) > 0 ? Number(unix) : null;
    return { name, commitUnix, upstream: upstream || null, track };
  });
  const branchByName = new Map(branches.map((b) => [b.name, b]));

  const worktrees = parseWorktrees((await git(["worktree", "list", "--porcelain"], cwd)).stdout);
  if (worktrees.length === 0) {
    worktrees.push({ path: cwd, branch: null, prunable: false, locked: false, main: true });
  }
  const mainEntry = worktrees.find((w) => w.main) ?? worktrees[0]!;

  const seenBranches = new Set<string>();
  const rows: GitLedgerRow[] = worktrees.map((wt) => {
    if (wt.branch) seenBranches.add(wt.branch);
    return {
      branch: wt.branch,
      worktreePath: wt.path || null,
      directoryExists: Boolean(wt.path && existsSync(wt.path)),
      prunable: wt.prunable,
      locked: wt.locked,
      isMain: wt.main,
      lastCommitUnix: wt.branch ? (branchByName.get(wt.branch)?.commitUnix ?? null) : null,
      ageDays: null,
      ahead: null,
      behind: null,
      merged: null,
      upstream: wt.branch ? (branchByName.get(wt.branch)?.upstream ?? null) : null,
      upstreamGone: wt.branch
        ? (branchByName.get(wt.branch)?.track.includes("gone") ?? false)
        : false,
      unpushed: null,
      containedInRemote: null,
      trackedChanges: 0,
      untrackedFiles: 0,
      changedSample: [],
      conflictFiles: null,
      verdict: "decide",
      reasons: [],
    };
  });
  for (const branch of branches) {
    if (seenBranches.has(branch.name)) continue;
    rows.push({
      branch: branch.name,
      worktreePath: null,
      directoryExists: false,
      prunable: false,
      locked: false,
      isMain: false,
      lastCommitUnix: branch.commitUnix,
      ageDays: null,
      ahead: null,
      behind: null,
      merged: null,
      upstream: branch.upstream,
      upstreamGone: branch.track.includes("gone"),
      unpushed: null,
      containedInRemote: null,
      trackedChanges: 0,
      untrackedFiles: 0,
      changedSample: [],
      conflictFiles: null,
      verdict: "decide",
      reasons: [],
    });
  }

  let conflictUnsupported = false;
  const nowUnix = input.now.getTime() / 1000;

  await mapLimit(rows, INSPECT_CONCURRENCY, async (row) => {
    const branch = row.branch ? branchByName.get(row.branch) : undefined;
    // A detached worktree has no branch ref: read its HEAD for the commit time and counts below.
    if (!row.branch && row.worktreePath && row.directoryExists) {
      const res = await git(["log", "-1", "--format=%ct", "HEAD"], row.worktreePath);
      if (res.code === 0) row.lastCommitUnix = Number(res.stdout.trim()) || null;
    }

    if (row.lastCommitUnix !== null)
      row.ageDays = Math.max(0, Math.floor((nowUnix - row.lastCommitUnix) / 86_400));

    if (row.worktreePath && row.directoryExists) {
      const dirty = await dirtyState(git, row.worktreePath);
      row.trackedChanges = dirty.tracked;
      row.untrackedFiles = dirty.untracked;
      row.changedSample = dirty.sample;
    }

    if (!branch) {
      if (!row.branch && row.worktreePath && row.directoryExists) {
        const location = row.worktreePath;
        if (trunk) {
          const res = await git(["rev-list", "--left-right", "--count", `${trunk}...HEAD`], location);
          if (res.code === 0) {
            const counts = splitCount(res.stdout);
            row.ahead = counts.right;
            row.behind = counts.left;
            row.merged = counts.right === 0;
          }
        }
        if (hasRemote) {
          const res = await git(["rev-list", "--count", "HEAD", "--not", "--remotes"], location);
          if (res.code === 0) {
            row.unpushed = Number(res.stdout.trim()) || 0;
            row.containedInRemote = row.unpushed === 0;
          }
        }
        if (trunk && row.merged === false && !conflictUnsupported) {
          const res = await git(
            ["merge-tree", "--write-tree", "--name-only", trunk, "HEAD"],
            location,
          );
          if (res.code === 0) row.conflictFiles = [];
          else if (res.code === 1)
            row.conflictFiles = lines(res.stdout.split(/\r?\n\r?\n/)[0] ?? "").slice(1);
          else conflictUnsupported = true;
        }
      }
      return;
    }

    if (row.branch === trunk) {
      row.ahead = 0;
      row.behind = 0;
      row.merged = true;
      row.unpushed = 0;
      row.containedInRemote = true;
    } else if (trunk) {
      // The right count is the commits on the branch but not on the trunk: 0 means it is merged.
      const res = await git(["rev-list", "--left-right", "--count", `${trunk}...${row.branch}`], cwd);
      if (res.code === 0) {
        const counts = splitCount(res.stdout);
        row.ahead = counts.right;
        row.behind = counts.left;
        row.merged = counts.right === 0;
      }
    }

    if (row.branch !== trunk) {
      let resolved = false;
      if (branch.upstream && !branch.track.includes("gone")) {
        // for-each-ref already computed the upstream counts; an empty track means 0/0.
        const ahead = Number(/ahead (\d+)/.exec(branch.track)?.[1] ?? 0) || 0;
        row.unpushed = ahead;
        row.containedInRemote = ahead === 0;
        resolved = true;
      }
      if (!resolved && hasRemote) {
        const res = await git(["rev-list", "--count", row.branch!, "--not", "--remotes"], cwd);
        if (res.code === 0) {
          row.unpushed = Number(res.stdout.trim()) || 0;
          row.containedInRemote = row.unpushed === 0;
        }
      }
    }
    if (trunk && row.branch !== trunk && row.merged === false && !conflictUnsupported) {
      const res = await git(
        ["merge-tree", "--write-tree", "--name-only", trunk, row.branch!],
        cwd,
      );
      if (res.code === 0) row.conflictFiles = [];
      else if (res.code === 1) {
        row.conflictFiles = lines(res.stdout.split(/\r?\n\r?\n/)[0] ?? "").slice(1);
      } else {
        conflictUnsupported = true;
      }
    }
  });

  if (conflictUnsupported)
    notes.push("当前 git 不支持 `merge-tree --write-tree`（需要 2.38+），冲突检查已跳过。");

  for (const row of rows) {
    const classified = classifyRow(row, trunk, options);
    row.verdict = classified.verdict;
    row.reasons = classified.reasons;
  }

  const largeFiles: GitLargeFile[] = [];
  const tree = await git(["-c", "core.quotePath=false", "ls-tree", "-r", "-l", "HEAD"], cwd);
  const limit = options.largeFileMb * 1024 * 1024;
  for (const line of lines(tree.stdout)) {
    const tab = line.indexOf("\t");
    const size = Number(line.slice(0, tab).trim().split(/\s+/)[3]);
    if (size >= limit) largeFiles.push({ path: line.slice(tab + 1), size });
  }

  let outdated: OutdatedPackage[] | null = null;
  if (options.outdated && input.outdated) {
    outdated = await input.outdated(cwd).catch(() => null);
    if (outdated === null) notes.push("未检查过期依赖（不是 npm 项目或 npm outdated 失败）。");
  }

  const mainRow = rows.find((row) => row.isMain);
  return {
    trunk,
    originTrunk,
    hasRemote,
    mainPath: mainEntry.path || cwd,
    mainClean: Boolean(
      mainRow && mainRow.directoryExists && mainRow.trackedChanges + mainRow.untrackedFiles === 0,
    ),
    branchCount: branches.length,
    worktreeCount: worktrees.length,
    cleanupAfterDays: options.cleanupAfterDays,
    rows,
    largeFiles,
    largeFileMb: options.largeFileMb,
    outdated,
    notes,
  };
}

function findingKeyOfRow(row: GitLedgerRow): string {
  return row.branch
    ? `branch:${row.branch}`
    : `worktree:${norm(row.worktreePath ?? "(unknown)")}`;
}

export function findingsFromReport(report: GitReport): Finding[] {
  const findings: Finding[] = [];
  for (const row of report.rows) {
    if (row.verdict === "keep") continue;
    findings.push({
      category: row.verdict,
      subject: row.branch ?? row.worktreePath ?? "(unknown)",
      detail: row.reasons.join("；"),
      data: row,
      key: findingKeyOfRow(row),
    });
  }
  for (const file of report.largeFiles) {
    findings.push({
      category: "large_file",
      subject: file.path,
      detail: `${(file.size / 1048576).toFixed(1)} MB（阈值 ${report.largeFileMb} MB）`,
      data: { size: file.size },
      key: `large_file:${file.path}`,
    });
  }
  for (const pkg of report.outdated ?? []) {
    findings.push({
      category: "outdated_dep",
      subject: pkg.name,
      detail: `${pkg.current} -> ${pkg.latest}`,
      key: `dep:${pkg.name}`,
    });
  }
  return findings;
}

// ---- rendering ------------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");
function formatDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function formatDateTime(date: Date): string {
  return `${formatDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function formatCommit(unix: number | null, ageDays: number | null): string {
  if (unix === null) return "—";
  return `${formatDate(new Date(unix * 1000))}（${ageDays ?? "?"} 天前）`;
}
const cell = (text: string) => text.replaceAll("|", "\\|").replace(/\r?\n/g, " ");

function rowObject(row: GitLedgerRow): string {
  if (!row.branch) return "（detached）";
  return `\`${row.branch}\`${row.isMain ? "（主工作区）" : ""}`;
}

function rowWorktree(row: GitLedgerRow): string {
  if (!row.worktreePath) return "—";
  const flags = [
    ...(!row.directoryExists || row.prunable ? ["目录不存在"] : []),
    ...(row.locked ? ["locked"] : []),
  ];
  return `\`${row.worktreePath}\`${flags.length ? `（${flags.join("，")}）` : ""}`;
}

function rowPush(row: GitLedgerRow, trunk: string | null, hasRemote: boolean): string {
  if (trunk && row.branch === trunk) return "—";
  if (!hasRemote) return "无远端";
  const count = row.unpushed === null ? "?" : String(row.unpushed);
  const remote = `远端${row.containedInRemote ? "已" : "未"}包含`;
  if (!row.branch) return `无分支，未推送 ${count}（${remote}）`;
  if (row.upstream && !row.upstreamGone)
    return row.unpushed === 0 ? "已推送" : `\`${row.upstream}\`，未推送 ${count}`;
  if (row.upstreamGone) return `上游已不存在，未推送 ${count}（${remote}）`;
  return `无上游，未推送 ${count}（${remote}）`;
}

/** Relation to the trunk: merged, or ahead/behind counts. */
function rowTrunk(row: GitLedgerRow): string {
  if (row.merged) return "已合并";
  if (row.ahead === null || row.behind === null) return row.merged === null ? "—" : "未合并";
  return `未合并，领先 ${row.ahead} / 落后 ${row.behind}`;
}

function rowDirty(row: GitLedgerRow): string {
  const base = `${row.trackedChanges} / ${row.untrackedFiles}`;
  if (row.trackedChanges + row.untrackedFiles === 0) return "—";
  const sample = row.changedSample.join("、");
  return `${base}（${sample}${row.trackedChanges + row.untrackedFiles > row.changedSample.length ? " 等" : ""}）`;
}

function rowConflict(row: GitLedgerRow, trunk: string | null): string {
  if (trunk && row.branch === trunk) return "—";
  if (row.merged !== false) return "—";
  if (row.conflictFiles === null) return "未检查";
  if (row.conflictFiles.length === 0) return "无";
  return conflictText(row);
}

/** Why a "decide" row needs the user, ordered from highest to lowest risk; a row lands in the first group that fits. */
type DecideGroup =
  | "locked"
  | "dirty"
  | "conflict"
  | "unpushed"
  | "detached"
  | "unmerged"
  | "other"
  | "recent";

function decideGroupOf(row: GitLedgerRow): DecideGroup {
  if (row.locked) return "locked";
  if (row.trackedChanges + row.untrackedFiles > 0) return "dirty";
  if (row.conflictFiles?.length) return "conflict";
  if (row.unpushed !== null && row.unpushed > 0) return "unpushed";
  if (!row.branch && !row.isMain && row.merged !== true) return "detached";
  if (row.merged === false && row.ahead !== null && row.ahead > 0 && row.conflictFiles?.length === 0)
    return "unmerged";
  if (row.merged === true && !row.isMain && row.ageDays !== null) return "recent";
  return "other";
}

const DECIDE_GROUPS: {
  key: DecideGroup;
  title: string;
  short: string;
  advice: (days: number) => string;
}[] = [
  {
    key: "locked",
    short: "locked",
    title: "worktree 已锁定",
    advice: () => "先确认谁锁的、为什么锁；不要解锁或清理，需要时由你亲自处理。",
  },
  {
    key: "dirty",
    short: "有未提交改动",
    title: "有未提交改动",
    advice: () =>
      "逐个看改动（文件见台账）：要的先提交或保存，不要的由你确认丢弃；处理前不要清理或合并。",
  },
  {
    key: "conflict",
    short: "合并会冲突",
    title: "未合并、有独有提交、合并会冲突",
    advice: () => "不能直接合并；需要你决定是解决冲突后合并，还是放弃该分支。冲突文件见台账。",
  },
  {
    key: "unpushed",
    short: "有未推送提交",
    title: "有未推送 / 远端未包含的提交",
    advice: () => "这些提交只存在本机，先推送或确认可以丢弃，再谈合并或清理。",
  },
  {
    key: "detached",
    short: "detached 未并入",
    title: "detached worktree 且 HEAD 未并入主干",
    advice: () => "没有分支承载这些提交；确认是否还要，要就建分支，不要才清理。",
  },
  {
    key: "unmerged",
    short: "未合并有独有提交",
    title: "未合并、有独有提交、预检无冲突（仅因仍在活动窗口内）",
    advice: (days) =>
      `合并候选，风险低；确认没有会话在用后可一并合并，超过 ${days} 天无活动会自动归入「建议合并」。`,
  },
  {
    key: "other",
    short: "其它",
    title: "其它原因",
    advice: () => "逐个看台账里的原因列后再定。",
  },
  {
    key: "recent",
    short: "已合并干净",
    title: "已合并且干净、仅因未满活动窗口",
    advice: (days) =>
      `风险低；确认没有会话在用即可一并清理，超过 ${days} 天无活动会自动归入「建议清理」。`,
  },
];

const GROUP_ORDER = new Map(DECIDE_GROUPS.map((group, index) => [group.key, index]));

function byRecency(a: GitLedgerRow, b: GitLedgerRow): number {
  const left = a.lastCommitUnix ?? -Infinity;
  const right = b.lastCommitUnix ?? -Infinity;
  return right - left || rowName(a).localeCompare(rowName(b));
}

/** Short object name for compact lists; a detached worktree is named by its directory. */
function rowName(row: GitLedgerRow): string {
  if (row.branch) return row.branch;
  const dir = (row.worktreePath ?? "(unknown)").replace(/\/+$/, "").split("/").pop();
  return `(detached) ${dir}`;
}

function nameList(rows: GitLedgerRow[]): string {
  return rows.map((row) => `\`${rowName(row)}\``).join("，");
}

function groupDecideRows(rows: GitLedgerRow[]) {
  return DECIDE_GROUPS.map((group) => ({
    ...group,
    rows: rows.filter((row) => decideGroupOf(row) === group.key).sort(byRecency),
  })).filter((group) => group.rows.length > 0);
}

/** Short per-row tags; the full wording stays in the group advice, the columns hold the facts. */
function ledgerReason(row: GitLedgerRow, days: number): string {
  if (row.verdict === "cleanup")
    return row.prunable || !row.directoryExists ? "目录不存在，prune 登记" : "已合并，干净，无独有提交";
  if (row.verdict === "merge") return "未合并，预检无冲突，干净";
  if (row.verdict === "keep") return row.reasons[0] ?? "";
  const primary = DECIDE_GROUPS[GROUP_ORDER.get(decideGroupOf(row))!]!;
  if (primary.key === "other") return `【其它】${row.reasons.join("；")}`;
  const tags = [
    row.locked && "locked",
    row.trackedChanges + row.untrackedFiles > 0 && "有未提交改动",
    row.conflictFiles?.length && "合并会冲突",
    row.unpushed !== null && row.unpushed > 0 && "有未推送提交",
    !row.branch && !row.isMain && "detached",
    row.merged === false && row.ahead !== null && row.ahead > 0 && "未合并有独有提交",
    row.ageDays !== null && row.ageDays < days && `未满 ${days} 天`,
  ].filter((tag): tag is string => Boolean(tag));
  const rest = tags.filter((tag) => tag !== primary.short && !(primary.key === "detached" && tag === "detached"));
  return `【${primary.short}】${rest.length ? rest.join("，") : ""}`;
}

function ledgerTable(rows: GitLedgerRow[], report: GitReport): string {
  const header =
    "| 对象 | worktree | 最近提交 | 与主干 | 上游/未推送 | 未提交（已跟踪/未跟踪） | 冲突 | 原因/建议 |";
  const separator = "| --- | --- | --- | --- | --- | --- | --- | --- |";
  const body = rows.map((row) =>
    [
      rowObject(row),
      rowWorktree(row),
      formatCommit(row.lastCommitUnix, row.ageDays),
      rowTrunk(row),
      rowPush(row, report.trunk, report.hasRemote),
      rowDirty(row),
      rowConflict(row, report.trunk),
      ledgerReason(row, report.cleanupAfterDays),
    ]
      .map(cell)
      .join(" | "),
  );
  return [header, separator, ...body.map((line) => `| ${line} |`)].join("\n");
}

function whyText(ctx: Pick<CheckContext, "rule" | "project" | "trigger">): string {
  const reason =
    ctx.trigger.reason === "手动触发"
      ? "你在维护页点击了「立即运行」"
      : `触发原因：${ctx.trigger.reason}`;
  return `自动维护规则「${ctx.rule.name}」检查了项目「${ctx.project.name}」的 git 状态。${reason}。这是自动生成的维护建议，不是你提出的需求。`;
}

/** Safety rules shared by the plan, the task body and the confirmed worker's instructions. */
export const GIT_CLEANUP_SAFETY: string[] = [
  "只处理用户在确认时同意的对象；用户改过清单的，以修改后的为准。",
  "worktree 只用 `git worktree remove <path>`，不加 `--force`；分支只用 `git branch -d`，不用 `-D`；远程分支只删确实存在且已合并的。",
  "禁止 `git reset --hard`、`git clean`、`git checkout --` / `git restore`、`push --force`；禁止任何递归删除目录（`rm -rf`、`Remove-Item -Recurse`、`rmdir /s`、`\\\\?\\` 前缀等），也不要用 robocopy /MIR 清空目录（目录里有 junction 会清空外部目录）。",
  "`git worktree remove` 失败（如 Windows 长路径 Filename too long、目录不干净）就停下，如实报告「已注销/未注销、物理目录残留」，列出残留路径；物理目录是否删除、怎么删留给用户单独决定。",
  "有未提交内容或独有提交的对象不清理，列入需你决定。",
  "合并按仓库自己的 git 规则：在本地主干 `--ff-only` 对齐远端后合并，验证后再 push，不 force。",
  "结束时汇报 git 树状态（主干与 origin 对齐情况、剩余分支/worktree）。",
];

export const GIT_PLAN_INSTRUCTIONS = [
  "规划阶段不得修改文件、分支、worktree 或仓库状态；不得 fetch、commit、merge、push。",
  "先用只读 git 命令现场核实台账（每条 git 命令都带 GIT_OPTIONAL_LOCKS=0），标出与检查时不一致的对象。",
  "最终回复的主体是以下六节中文 Markdown 方案，用户只看它就能决定：",
  "①当前 git 状况简述；②未合并分支/worktree 状态表（全部列出，不截断；对象多时按建议分类分组，每组一张表）；③建议合并（附理由）；④建议清理（附理由）；⑤需你决定 / 保留（各附理由）；⑥执行步骤与安全清理要求。",
  "vibe-plan JSON 放在最后，保持简短：goal/approach 各一两句，subtasks 只按「合并」「清理」「需决定项」分组，不复述台账。",
  "执行 agent 只收到 vibe-plan JSON：在每个 subtask 的 notes 和 acceptance 里写明本次适用的安全清理要求（worktree remove 不加 --force、branch -d 不用 -D、禁止递归删除目录、remove 失败即停并报告残留、不 force push），不要假定它能看到本段指令。",
  "",
  "安全清理要求：",
  ...GIT_CLEANUP_SAFETY.map((line) => `- ${line}`),
].join("\n");

export interface GitRendered {
  title: string;
  body: string;
  acceptance: string;
}

export function renderGitOutput(
  ctx: Pick<CheckContext, "rule" | "project" | "trigger">,
  report: GitReport,
): GitRendered {
  const rowsOf = (verdict: GitVerdict) =>
    report.rows.filter((row) => row.verdict === verdict).sort(byRecency);
  const decideRows = groupDecideRows(rowsOf("decide")).flatMap((group) => group.rows);
  const groups = (["decide", "merge", "cleanup", "keep"] as const).map(
    (verdict) => [verdict, verdict === "decide" ? decideRows : rowsOf(verdict)] as const,
  );
  const count = (verdict: GitVerdict) => report.rows.filter((row) => row.verdict === verdict).length;

  const out: string[] = [];
  out.push("## 当前 git 状况");
  if (report.trunk) {
    if (report.originTrunk) {
      const fetched = report.originTrunk.fetchHeadAt
        ? `FETCH_HEAD 时间：${formatDateTime(report.originTrunk.fetchHeadAt)}`
        : "FETCH_HEAD 不存在";
      out.push(
        `- 主干：\`${report.trunk}\`；本地与 \`origin/${report.trunk}\` 相比：领先 ${report.originTrunk.ahead} 个提交，落后 ${report.originTrunk.behind} 个提交（基于上次 fetch，未现场 fetch；${fetched}）。`,
      );
    } else {
      out.push(`- 主干：\`${report.trunk}\`；没有 \`origin/${report.trunk}\` 远端引用，未比较远端差异。`);
    }
  } else {
    out.push("- 找不到主干（main/master/origin HEAD），分支状态无法完整判断。");
  }
  out.push(
    `- 主工作区：${report.mainClean ? "干净" : "有未提交改动"}。`,
    `- 共 ${report.branchCount} 个本地分支、${report.worktreeCount} 个 worktree（含主工作区）；按建议：${VERDICT_LABELS.decide} ${count("decide")}，${VERDICT_LABELS.merge} ${count("merge")}，${VERDICT_LABELS.cleanup} ${count("cleanup")}，${VERDICT_LABELS.keep} ${count("keep")}。`,
  );

  out.push("", `## 分支与 worktree 台账（全部 ${report.rows.length} 个对象）`);
  out.push(
    "同一分支的 worktree 并入一行；detached worktree 与主工作区单独一行。「未提交」为已跟踪改动数 / 未跟踪文件数，「—」表示没有；worktree 目录存在且未锁定时不加标注。",
  );
  for (const [verdict, rows] of groups) {
    if (rows.length === 0) continue;
    out.push("", `### ${VERDICT_LABELS[verdict]}（${rows.length}）`, ledgerTable(rows, report));
  }

  const days = report.cleanupAfterDays;
  const section = (title: string, rows: GitLedgerRow[], advice: string) =>
    out.push("", title, ...(rows.length ? [advice, nameList(rows)] : ["（无）"]));
  section(
    `## 建议合并（${count("merge")}）`,
    rowsOf("merge"),
    `未合并、有独有提交、预检无冲突、干净且超过 ${days} 天无活动。建议逐个确认后按仓库规则合并（本地主干 \`--ff-only\` 对齐远端、验证、再 push）。各对象状态见台账。`,
  );
  section(
    `## 建议清理（${count("cleanup")}）`,
    rowsOf("cleanup"),
    `已合并且干净、无独有提交、超过 ${days} 天无活动；或 worktree 目录已不存在（\`git worktree prune\`）。建议按第六节的安全要求逐个清理。各对象状态见台账。`,
  );
  out.push("", `## 需你决定（${count("decide")}）`);
  const decideGroups = groupDecideRows(rowsOf("decide"));
  if (decideGroups.length === 0) out.push("（无）");
  for (const group of decideGroups)
    out.push(
      "",
      `### ${group.title}（${group.rows.length}）`,
      group.advice(days),
      nameList(group.rows),
    );
  out.push(
    "",
    `## 保留（${count("keep")}）`,
    ...(rowsOf("keep").length
      ? ["主干本身和干净的主工作区，不动。", nameList(rowsOf("keep"))]
      : ["（无）"]),
  );

  out.push("", "## 执行步骤与安全清理要求");
  out.push(...GIT_CLEANUP_SAFETY.map((line, index) => `${index + 1}. ${line}`));

  if (report.largeFiles.length) {
    out.push("", `## 附加：大文件（${report.largeFiles.length}）`);
    for (const file of report.largeFiles)
      out.push(
        `- \`${file.path}\`：${(file.size / 1048576).toFixed(1)} MB（阈值 ${report.largeFileMb} MB）`,
      );
  }
  if (report.outdated?.length) {
    out.push("", `## 附加：过期依赖（${report.outdated.length}）`);
    for (const pkg of report.outdated)
      out.push(`- \`${pkg.name}\`：${pkg.current} -> ${pkg.latest}`);
  }

  if (report.notes.length) out.push("", "## 检查限制", ...report.notes.map((note) => `- ${note}`));

  out.push(
    "",
    "---",
    whyText(ctx),
    `此任务先在新的原生 workspace 中规划，等待用户显式 /执行。同规则同项目未完成任务只补充新发现，方案变化后需重新确认。不想再收到：在维护页停用或调整规则「${ctx.rule.name}」。`,
  );

  return {
    title: `Git 体检：${count("cleanup")} 可清理、${count("merge")} 建议合并、${count("decide")} 需决定`,
    body: out.join("\n"),
    acceptance: [
      "- 只处理确认时同意的对象；用户改过清单的以修改后为准。",
      "- 合并项验证通过，主干与 origin 对齐，全程未使用 force。",
      "- 清理项只用 `git worktree remove`（不加 `--force`）与 `git branch -d`（不用 `-D`）。",
      "- 有未提交改动或独有提交的对象没有被清理。",
      "- 结束时 `git worktree list` 和 `git branch` 只剩保留或需决定的对象。",
    ].join("\n"),
  };
}

export function createGitCheck(deps: { outdated?: OutdatedFn } = {}): CheckFn {
  const outdatedFn = deps.outdated ?? npmOutdated;
  return async (ctx) => {
    const options = readOptions(ctx.options);
    const report = await inspectGitRepo({
      repoPath: ctx.project.repoPath,
      now: ctx.now,
      git: ctx.git,
      options,
      outdated: options.outdated ? outdatedFn : null,
    });
    const findings = findingsFromReport(report);
    if (findings.length === 0) return null;
    return {
      ...renderGitOutput(ctx, report),
      findings,
      notes: report.notes,
      instructions: GIT_PLAN_INSTRUCTIONS,
    } satisfies CheckOutput;
  };
}

export const gitCheck: CheckFn = createGitCheck();
