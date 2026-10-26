import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGitCheck, renderGitOutput, type GitLedgerRow, type GitReport } from "../server/git/check";
import { execGit } from "../server/git/exec";
import type { CheckContext } from "../server/types";
import { commit, makeRepo, sh, tempDir, tempWorktreeDir, write } from "./helpers";

function ctxFor(
  repo: string,
  options: Record<string, unknown> = {},
  now = new Date(),
): CheckContext {
  return {
    project: { name: "Demo", repoPath: repo } as CheckContext["project"],
    rule: { name: "git-health" } as CheckContext["rule"],
    options,
    now,
    git: execGit,
    trigger: { reason: "test" },
  };
}

const old = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();

describe("git health check (real repositories)", () => {
  it("reports nothing for a tidy repository", async () => {
    const repo = makeRepo();
    const check = createGitCheck({ outdated: async () => [] });
    expect(await check(ctxFor(repo))).toBeNull();
  });

  it("keeps one ledger row per object with a deterministic advice class", async () => {
    const repo = makeRepo();
    const worktrees = tempWorktreeDir();

    // merged, clean, inactive worktree: cleanup
    sh(repo, ["checkout", "-b", "feat/merged-clean"]);
    commit(repo, "merged.txt", "x\n", "merged work", old(30));
    sh(repo, ["checkout", "main"]);
    sh(repo, ["merge", "--no-ff", "-m", "merge clean", "feat/merged-clean"]);
    const mergedWt = join(worktrees, "merged");
    sh(repo, ["worktree", "add", mergedWt, "feat/merged-clean"]);

    // merged but has an untracked file: needs a decision
    sh(repo, ["checkout", "-b", "feat/merged-dirty"]);
    commit(repo, "dirty.txt", "y\n", "dirty work", old(30));
    sh(repo, ["checkout", "main"]);
    sh(repo, ["merge", "--no-ff", "-m", "merge dirty", "feat/merged-dirty"]);
    const dirtyWt = join(worktrees, "dirty");
    sh(repo, ["worktree", "add", dirtyWt, "feat/merged-dirty"]);
    write(dirtyWt, "scratch.txt", "z\n");

    // unmerged, clean, no conflict, inactive: suggest merge
    sh(repo, ["checkout", "-b", "feat/merge-me"]);
    commit(repo, "feature.txt", "x\n", "feature work", old(10));
    sh(repo, ["checkout", "main"]);

    // unmerged and conflicts with main: needs a decision
    commit(repo, "shared.txt", "base\n", "add shared");
    sh(repo, ["checkout", "-b", "feat/conflict"]);
    commit(repo, "shared.txt", "branch side\n", "branch edit", old(10));
    sh(repo, ["checkout", "main"]);
    commit(repo, "shared.txt", "main side\n", "main edit");

    // worktree directory vanished: prune
    const gone = join(worktrees, "gone");
    sh(repo, ["worktree", "add", "-b", "wt/gone", gone, "main"]);
    renameSync(gone, join(worktrees, "gone-moved"));

    // large tracked file and an uncommitted change in the main workspace
    writeFileSync(join(repo, "big.bin"), Buffer.alloc(2 * 1024 * 1024, 1));
    sh(repo, ["add", "big.bin"]);
    sh(repo, ["commit", "-m", "add big file"]);
    write(repo, "README.md", "changed\n");

    const check = createGitCheck({
      outdated: async () => [{ name: "left-pad", current: "1.0.0", latest: "2.0.0" }],
    });
    const out = await check(ctxFor(repo, { large_file_mb: 1 }));
    expect(out).not.toBeNull();
    const by = (category: string) =>
      out!.findings.filter((f) => f.category === category).map((f) => f.subject).sort();
    const rowOf = (subject: string) =>
      out!.findings.find((f) => f.subject === subject)!.data as GitLedgerRow;

    expect(by("cleanup")).toEqual(["feat/merged-clean", "wt/gone"]);
    expect(by("merge")).toEqual(["feat/merge-me"]);
    expect(by("decide")).toEqual(["feat/conflict", "feat/merged-dirty", "main"]);
    expect(by("large_file")).toEqual(["big.bin"]);
    expect(by("outdated_dep")).toEqual(["left-pad"]);

    expect(rowOf("feat/merged-clean")).toMatchObject({
      branch: "feat/merged-clean",
      worktreePath: mergedWt.replaceAll("\\", "/"),
      directoryExists: true,
      merged: true,
      ahead: 0,
      trackedChanges: 0,
      untrackedFiles: 0,
      verdict: "cleanup",
    });
    expect(rowOf("feat/merged-dirty")).toMatchObject({
      merged: true,
      trackedChanges: 0,
      untrackedFiles: 1,
      changedSample: ["scratch.txt"],
      verdict: "decide",
    });
    expect(rowOf("feat/merge-me")).toMatchObject({
      branch: "feat/merge-me",
      worktreePath: null,
      merged: false,
      ahead: 1,
      conflictFiles: [],
      verdict: "merge",
    });
    expect(rowOf("feat/conflict")).toMatchObject({
      merged: false,
      verdict: "decide",
    });
    expect(rowOf("feat/conflict").conflictFiles).toEqual(["shared.txt"]);
    expect(rowOf("wt/gone")).toMatchObject({
      branch: "wt/gone",
      directoryExists: false,
      verdict: "cleanup",
    });
    expect(rowOf("main")).toMatchObject({
      isMain: true,
      trackedChanges: 1,
      verdict: "decide",
    });

    expect(out!.title).toBe("Git 体检：2 可清理、1 建议合并、3 需决定");
    for (const heading of [
      "## 当前 git 状况",
      "## 分支与 worktree 台账（全部 6 个对象）",
      "### 需你决定（3）",
      "### 建议合并（1）",
      "### 可清理（2）",
      "## 建议合并（1）",
      "## 建议清理（2）",
      "## 需你决定（3）",
      "## 保留（0）",
      "## 执行步骤与安全清理要求",
      "## 附加：大文件（1）",
      "## 附加：过期依赖（1）",
    ])
      expect(out!.body).toContain(heading);
    expect(out!.body).toContain("`feat/conflict`");
    expect(out!.body).toContain("会冲突");
    expect(out!.body).toContain("git worktree remove");
    expect(out!.body).not.toContain('"category"');
    expect(out!.instructions).toContain("GIT_OPTIONAL_LOCKS=0");
    expect(out!.instructions).toContain("vibe-plan");
  }, 180_000);

  it("suggests merging only outside the activity window and honors cleanup_after_days", async () => {
    const repo = makeRepo();
    sh(repo, ["checkout", "-b", "feat/old"]);
    commit(repo, "old.txt", "x\n", "old work", old(10));
    sh(repo, ["checkout", "-b", "feat/fresh"]);
    commit(repo, "fresh.txt", "y\n", "fresh work", old(1));
    sh(repo, ["checkout", "main"]);

    const out = await createGitCheck({ outdated: async () => [] })(ctxFor(repo));
    const category = (subject: string) =>
      out!.findings.find((f) => f.subject === subject)?.category;
    expect(category("feat/old")).toBe("merge");
    expect(category("feat/fresh")).toBe("decide");

    const strict = await createGitCheck({ outdated: async () => [] })(
      ctxFor(repo, { cleanup_after_days: 30 }),
    );
    expect(
      strict!.findings.find((f) => f.subject === "feat/old")?.category,
    ).toBe("decide");
    expect(strict!.findings.find((f) => f.subject === "feat/old")?.detail).toContain("活动窗口");
  });

  it("flags an uncommitted worktree separately from its branch", async () => {
    const repo = makeRepo();
    const wt = join(tempWorktreeDir(), "w");
    sh(repo, ["worktree", "add", "-b", "wt/live", wt, "main"]);
    commit(wt, "live.txt", "x\n", "live work");
    write(wt, "scratch.txt", "dirty\n");
    write(repo, "notes.txt", "dirty\n");
    const out = await createGitCheck({ outdated: async () => null })(ctxFor(repo));
    const rowOf = (subject: string) =>
      out!.findings.find((f) => f.subject === subject)!.data as GitLedgerRow;
    expect(rowOf("wt/live")).toMatchObject({
      worktreePath: wt.replaceAll("\\", "/"),
      trackedChanges: 0,
      untrackedFiles: 1,
      verdict: "decide",
    });
    expect(out!.findings.find((f) => f.subject === "main")?.category).toBe("decide");
    expect(out!.notes.join()).toContain("过期依赖");
  });

  it("marks a branch without upstream whose commits are not on any remote as a decision", async () => {
    const repo = makeRepo();
    const remote = tempDir("vibe-maintain-remote-");
    sh(remote, ["init", "--bare", "-b", "main"]);
    sh(repo, ["remote", "add", "origin", remote]);
    sh(repo, ["push", "-u", "origin", "main"]);
    sh(repo, ["checkout", "-b", "feat/local-only"]);
    commit(repo, "local.txt", "x\n", "local only", old(10));
    sh(repo, ["checkout", "main"]);

    const out = await createGitCheck({ outdated: async () => [] })(ctxFor(repo));
    const row = out!.findings.find((f) => f.subject === "feat/local-only")!
      .data as GitLedgerRow;
    expect(row).toMatchObject({
      upstream: null,
      unpushed: 1,
      containedInRemote: false,
      verdict: "decide",
    });
    expect(row.reasons.join()).toContain("未被任何远端引用包含");
  });

  it("does not count one object several times when several problems apply", async () => {
    const repo = makeRepo();
    sh(repo, ["checkout", "-b", "feat/busy"]);
    commit(repo, "busy.txt", "x\n", "busy", old(30));
    sh(repo, ["checkout", "main"]);
    sh(repo, ["merge", "--no-ff", "-m", "merge busy", "feat/busy"]);
    const wt = join(tempWorktreeDir(), "busy");
    sh(repo, ["worktree", "add", wt, "feat/busy"]);
    write(wt, "scratch.txt", "dirty\n");

    const out = await createGitCheck({ outdated: async () => [] })(ctxFor(repo));
    const matches = out!.findings.filter((f) => f.subject === "feat/busy");
    expect(matches).toHaveLength(1);
    expect(matches[0]!.key).toBe("branch:feat/busy");
  });

  it("gives a detached worktree its own row with HEAD status", async () => {
    const repo = makeRepo();
    sh(repo, ["checkout", "-b", "old-line"]);
    commit(repo, "old.txt", "x\n", "old work", old(30));
    const tip = sh(repo, ["rev-parse", "HEAD"]).trim();
    sh(repo, ["checkout", "main"]);
    sh(repo, ["merge", "--no-ff", "-m", "merge old", "old-line"]);
    const wt = join(tempWorktreeDir(), "detached");
    sh(repo, ["worktree", "add", "--detach", wt, tip]);

    const out = await createGitCheck({ outdated: async () => [] })(ctxFor(repo));
    const subject = wt.replaceAll("\\", "/");
    const row = out!.findings.find((f) => f.subject === subject)!.data as GitLedgerRow;
    expect(row).toMatchObject({
      branch: null,
      worktreePath: subject,
      directoryExists: true,
      merged: true,
      ahead: 0,
      verdict: "cleanup",
    });
    expect(row.lastCommitUnix).not.toBeNull();
    expect(row.ageDays).toBeGreaterThanOrEqual(29);
    expect(row.reasons.join()).toContain("detached worktree");
    expect(out!.body).toContain("（detached）");
  });

  it("throws for a directory that is not a git repository", async () => {
    const dir = tempDir("vibe-maintain-nogit-");
    mkdirSync(join(dir, "x"));
    await expect(createGitCheck()(ctxFor(dir))).rejects.toThrow(/Not a git repository/);
  });
});

describe("decide grouping in the rendered plan", () => {
  const day = 86_400;
  const base = Date.UTC(2026, 9, 20) / 1000;
  const row = (overrides: Partial<GitLedgerRow>): GitLedgerRow => ({
    branch: null,
    worktreePath: null,
    directoryExists: true,
    prunable: false,
    locked: false,
    isMain: false,
    lastCommitUnix: base,
    ageDays: 1,
    ahead: 0,
    behind: 0,
    merged: true,
    upstream: null,
    upstreamGone: false,
    unpushed: 0,
    containedInRemote: true,
    trackedChanges: 0,
    untrackedFiles: 0,
    changedSample: [],
    conflictFiles: null,
    verdict: "decide",
    reasons: ["最近提交在 1 天前，仍在 7 天活动窗口内，可能有会话在用"],
    ...overrides,
  });
  const report = (rows: GitLedgerRow[]): GitReport => ({
    trunk: "main",
    originTrunk: null,
    hasRemote: true,
    mainPath: "D:/repo",
    mainClean: true,
    branchCount: rows.length,
    worktreeCount: rows.length,
    cleanupAfterDays: 7,
    rows,
    largeFiles: [],
    largeFileMb: 5,
    outdated: null,
    notes: [],
  });
  const ctx = { project: { name: "Demo" }, rule: { name: "git-health" }, trigger: { reason: "手动触发" } } as Parameters<
    typeof renderGitOutput
  >[0];

  const rows = [
    row({ branch: "recent-old", lastCommitUnix: base - 3 * day, ageDays: 4 }),
    row({ branch: "recent-new", lastCommitUnix: base }),
    row({
      branch: "dirty-and-recent",
      lastCommitUnix: base - day,
      trackedChanges: 2,
      changedSample: ["a.ts", "b.ts"],
      reasons: ["有未提交改动（2 个已跟踪改动：a.ts、b.ts）", "最近提交在 1 天前，仍在 7 天活动窗口内，可能有会话在用"],
    }),
    row({
      branch: "conflicting",
      merged: false,
      ahead: 2,
      conflictFiles: ["x.ts"],
      reasons: ["合并进 main 会冲突（文件：x.ts）"],
    }),
    row({ branch: "clean-unmerged", merged: false, ahead: 1, conflictFiles: [], reasons: ["最近提交在 1 天前"] }),
    row({ branch: "unpushed-one", merged: false, ahead: 1, unpushed: 1, conflictFiles: [], reasons: ["有 1 个提交未被任何远端引用包含"] }),
    row({ branch: "locked-one", locked: true, reasons: ["worktree 已锁定"] }),
    row({ worktreePath: "D:/wt/detached-dir", merged: false, ahead: 1, reasons: ["detached worktree 没有分支"] }),
  ];

  it("splits needs-decision rows into risk-ordered groups, one row per object", () => {
    const body = renderGitOutput(ctx, report(rows)).body;
    const section = body.slice(body.indexOf("\n## 需你决定（8）"));
    const titles = [...section.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
    expect(titles).toEqual([
      "worktree 已锁定（1）",
      "有未提交改动（1）",
      "未合并、有独有提交、合并会冲突（1）",
      "有未推送 / 远端未包含的提交（1）",
      "detached worktree 且 HEAD 未并入主干（1）",
      "未合并、有独有提交、预检无冲突（仅因仍在活动窗口内）（1）",
      "已合并且干净、仅因未满活动窗口（2）",
    ]);
    // newest first inside a group, and the 7-day auto-promotion is stated
    expect(section).toContain("`recent-new`，`recent-old`");
    expect(section).toContain("超过 7 天无活动会自动归入「建议清理」");
    expect(section).toContain("`(detached) detached-dir`");
    // multi-reason row sits in the riskiest group only, with every reason inline in the ledger
    expect(section.match(/`dirty-and-recent`/g)).toHaveLength(1);
    expect(body).toContain("【有未提交改动】未满 7 天 |");
  });

  it("keeps each object's ledger status once and the sections compact", () => {
    const body = renderGitOutput(ctx, report(rows)).body;
    expect(body).toContain("| 对象 |");
    expect(body).toContain("原因/建议 |");
    // every object has exactly one ledger row; the advice sections only list names
    const ledger = body.slice(body.indexOf("## 分支与 worktree 台账"), body.indexOf("\n## 建议合并"));
    for (const name of rows.map((r) => r.branch).filter(Boolean))
      expect(ledger.split(`| \`${name}\``), name!).toHaveLength(2);
    expect(ledger).toContain("x.ts");
    expect(body.slice(body.indexOf("\n## 建议合并"))).not.toContain("x.ts");
  });
});
