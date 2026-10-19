// Built-in "git health" check (deterministic, no model): stale / merged-but-kept branches,
// leftover worktrees, uncommitted changes, unpushed commits, conflicts with the trunk, large
// files and outdated dependencies. Its output is both the draft card and the sub agent's input.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CheckContext, CheckFn, CheckOutput, Finding } from "../types";
import type { GitRunner } from "./exec";

export interface GitCheckOptions {
  staleDays: number;
  largeFileMb: number;
  /** Look for outdated npm dependencies (needs network). */
  outdated: boolean;
  /** Findings listed per category in the card text (all stay in the run's findings). */
  maxPerCategory: number;
}

export const GIT_CHECK_DEFAULTS: GitCheckOptions = {
  staleDays: 14,
  largeFileMb: 5,
  outdated: true,
  maxPerCategory: 15,
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

export const CATEGORY_LABELS: Record<string, string> = {
  stale_branch: "长期未合并的分支",
  merged_branch: "已合并但未删除的分支",
  leftover_worktree: "遗留 worktree",
  uncommitted: "未提交的改动",
  unpushed: "未推送的提交",
  conflict: "与主干冲突的分支",
  large_file: "大文件",
  outdated_dep: "过期依赖",
};

function readOptions(raw: Record<string, unknown>): GitCheckOptions {
  const num = (v: unknown, d: number) => (typeof v === "number" && v > 0 ? v : d);
  return {
    staleDays: num(raw.stale_days ?? raw.staleDays, GIT_CHECK_DEFAULTS.staleDays),
    largeFileMb: num(raw.large_file_mb ?? raw.largeFileMb, GIT_CHECK_DEFAULTS.largeFileMb),
    outdated: typeof raw.outdated === "boolean" ? raw.outdated : GIT_CHECK_DEFAULTS.outdated,
    maxPerCategory: num(
      raw.max_per_category ?? raw.maxPerCategory,
      GIT_CHECK_DEFAULTS.maxPerCategory,
    ),
  };
}

const lines = (text: string) => text.split(/\r?\n/).filter((l) => l.length > 0);
const norm = (p: string) => p.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();

interface BranchInfo {
  name: string;
  commitUnix: number;
  upstream: string;
  track: string;
  worktreePath: string;
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

async function isMerged(git: GitRunner, cwd: string, ref: string, trunk: string): Promise<boolean> {
  return (await git(["merge-base", "--is-ancestor", ref, trunk], cwd)).code === 0;
}

export function createGitCheck(deps: { outdated?: OutdatedFn } = {}): CheckFn {
  const outdatedFn = deps.outdated ?? npmOutdated;
  return async (ctx) => {
    const options = readOptions(ctx.options);
    const cwd = ctx.project.repoPath;
    const git = ctx.git;
    const notes: string[] = [];
    const findings: Finding[] = [];
    if (!cwd || (await git(["rev-parse", "--git-dir"], cwd)).code !== 0) {
      throw new Error(`Not a git repository: ${cwd || "(empty path)"}`);
    }
    const trunk = await trunkOf(git, cwd);
    if (!trunk) notes.push("找不到主干分支（main/master/origin HEAD），分支类检查已跳过。");

    const hasRemote = lines((await git(["remote"], cwd)).stdout).length > 0;
    const refs = await git(
      [
        "for-each-ref",
        "--format=%(refname:short)%09%(committerdate:unix)%09%(upstream:short)%09%(upstream:track)%09%(worktreepath)",
        "refs/heads",
      ],
      cwd,
    );
    const branches: BranchInfo[] = lines(refs.stdout).map((line) => {
      const [name = "", unix = "0", upstream = "", track = "", worktreePath = ""] = line.split("\t");
      return { name, commitUnix: Number(unix), upstream, track, worktreePath };
    });

    const primary = norm(cwd);
    const mergedBranches = new Set<string>();
    if (trunk) {
      for (const b of branches) {
        if (b.name !== trunk && (await isMerged(git, cwd, b.name, trunk))) mergedBranches.add(b.name);
      }
    }

    // --- branches + unpushed commits --------------------------------------------------------
    for (const b of branches) {
      const checkedOutElsewhere = b.worktreePath && norm(b.worktreePath) !== primary;
      const checkedOutHere = b.worktreePath && norm(b.worktreePath) === primary;
      if (trunk && b.name !== trunk && !checkedOutElsewhere) {
        if (mergedBranches.has(b.name)) {
          if (!checkedOutHere) {
            findings.push({
              category: "merged_branch",
              subject: b.name,
              detail: `已合并进 ${trunk}，可以删除`,
            });
          }
        } else {
          const ahead =
            Number((await git(["rev-list", "--count", `${trunk}..${b.name}`], cwd)).stdout) || 0;
          const ageDays = Math.floor((ctx.now.getTime() / 1000 - b.commitUnix) / 86_400);
          if (ageDays >= options.staleDays) {
            findings.push({
              category: "stale_branch",
              subject: b.name,
              detail: `领先 ${trunk} ${ahead} 个提交，最后提交于 ${ageDays} 天前`,
              data: { ahead, ageDays },
            });
          }
        }
      }
      if (hasRemote && !mergedBranches.has(b.name)) {
        const aheadOfUpstream = /ahead (\d+)/.exec(b.track)?.[1];
        if (aheadOfUpstream) {
          findings.push({
            category: "unpushed",
            subject: b.name,
            detail: `比 ${b.upstream} 多 ${aheadOfUpstream} 个本地提交未推送`,
            data: { ahead: Number(aheadOfUpstream) },
          });
        } else if (!b.upstream && b.name !== trunk) {
          findings.push({
            category: "unpushed",
            subject: b.name,
            detail: "没有上游分支，提交只存在本地",
          });
        }
      }
    }

    // --- conflicts with the trunk -----------------------------------------------------------
    if (trunk) {
      let unsupported = false;
      for (const b of branches) {
        if (b.name === trunk || mergedBranches.has(b.name) || unsupported) continue;
        const res = await git(["merge-tree", "--write-tree", "--name-only", trunk, b.name], cwd);
        if (res.code === 1) {
          const files = lines(res.stdout.split(/\r?\n\r?\n/)[0] ?? "").slice(1);
          findings.push({
            category: "conflict",
            subject: b.name,
            detail: `合并进 ${trunk} 会冲突：${files.slice(0, 5).join("、") || "（文件未知）"}${
              files.length > 5 ? ` 等 ${files.length} 个文件` : ""
            }`,
            data: { files },
          });
        } else if (res.code > 1) {
          unsupported = true;
          notes.push("当前 git 不支持 `merge-tree --write-tree`（需要 2.38+），冲突检查已跳过。");
        }
      }
    }

    // --- worktrees + uncommitted changes ----------------------------------------------------
    const wt = await git(["worktree", "list", "--porcelain"], cwd);
    const blocks = wt.stdout.split(/\r?\n\r?\n/).filter((b) => b.trim());
    const dirtyTargets: Array<{ label: string; path: string }> = [];
    blocks.forEach((block, index) => {
      const field = (key: string) =>
        lines(block)
          .find((l) => l.startsWith(`${key} `) || l === key)
          ?.slice(key.length + 1) ?? "";
      const path = field("worktree");
      const branch = field("branch").replace(/^refs\/heads\//, "");
      const prunable = lines(block).some((l) => l.startsWith("prunable"));
      const exists = existsSync(path);
      if (index > 0) {
        if (prunable || !exists) {
          findings.push({
            category: "leftover_worktree",
            subject: path,
            detail: `目录已不存在，需要 \`git worktree prune\`${branch ? `（分支 ${branch}）` : ""}`,
          });
          return;
        }
        if (branch && mergedBranches.has(branch)) {
          findings.push({
            category: "leftover_worktree",
            subject: path,
            detail: `分支 ${branch} 已合并进 ${trunk}，worktree 可以移除`,
          });
        }
      }
      if (exists) dirtyTargets.push({ label: index === 0 ? "主工作区" : path, path });
    });
    if (blocks.length === 0) dirtyTargets.push({ label: "主工作区", path: cwd });
    for (const target of dirtyTargets) {
      const status = lines((await git(["status", "--porcelain"], target.path)).stdout);
      if (status.length > 0) {
        findings.push({
          category: "uncommitted",
          subject: target.label,
          detail: `${status.length} 个文件有未提交改动：${status
            .slice(0, 5)
            .map((l) => l.slice(3))
            .join("、")}${status.length > 5 ? " 等" : ""}`,
          data: { count: status.length },
        });
      }
    }

    // --- large files ------------------------------------------------------------------------
    const tree = await git(["ls-tree", "-r", "-l", "HEAD"], cwd);
    const limit = options.largeFileMb * 1024 * 1024;
    for (const line of lines(tree.stdout)) {
      const tab = line.indexOf("\t");
      const size = Number(line.slice(0, tab).trim().split(/\s+/)[3]);
      if (size >= limit) {
        findings.push({
          category: "large_file",
          subject: line.slice(tab + 1),
          detail: `${(size / 1048576).toFixed(1)} MB（阈值 ${options.largeFileMb} MB）`,
          data: { size },
        });
      }
    }

    // --- outdated dependencies --------------------------------------------------------------
    if (options.outdated) {
      const packages = await outdatedFn(cwd).catch(() => null);
      if (packages === null) notes.push("未检查过期依赖（不是 npm 项目或 npm outdated 失败）。");
      else {
        for (const p of packages) {
          findings.push({
            category: "outdated_dep",
            subject: p.name,
            detail: `${p.current} -> ${p.latest}`,
          });
        }
      }
    }

    if (findings.length === 0) return null;
    return renderGitOutput(ctx, findings, notes, options);
  };
}

function renderGitOutput(
  ctx: CheckContext,
  findings: Finding[],
  notes: string[],
  options: GitCheckOptions,
): CheckOutput {
  const out = [
    `规则「${ctx.rule.name}」自动检查了 ${ctx.project.name} 的 git 状态（触发：${ctx.trigger.reason}）。` +
      "同类问题合并在本卡，仅供整理参考；这张卡不会自动改动任何分支或文件。",
  ];
  for (const [category, label] of Object.entries(CATEGORY_LABELS)) {
    const items = findings.filter((f) => f.category === category);
    if (items.length === 0) continue;
    out.push("", `## ${label}（${items.length}）`);
    for (const f of items.slice(0, options.maxPerCategory)) {
      out.push(`- \`${f.subject}\`：${f.detail}`);
    }
    if (items.length > options.maxPerCategory) {
      out.push(`- ……另有 ${items.length - options.maxPerCategory} 项，见检查明细`);
    }
  }
  if (notes.length) out.push("", "## 说明", ...notes.map((n) => `- ${n}`));
  return {
    title: `Git 体检：${findings.length} 项待整理`,
    body: out.join("\n"),
    findings,
    notes,
  };
}

export const gitCheck: CheckFn = createGitCheck();
