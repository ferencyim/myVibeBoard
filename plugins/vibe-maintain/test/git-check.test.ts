import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGitCheck } from "../server/git/check";
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

  it("finds every problem class and groups them in one output", async () => {
    const repo = makeRepo();
    const worktrees = tempWorktreeDir();

    // stale, unmerged branch (30 days old)
    sh(repo, ["checkout", "-b", "feat/old"]);
    commit(repo, "old.txt", "old\n", "old work", old(30));
    sh(repo, ["checkout", "main"]);

    // merged but never deleted
    sh(repo, ["checkout", "-b", "feat/done"]);
    commit(repo, "done.txt", "done\n", "done work");
    sh(repo, ["checkout", "main"]);
    sh(repo, ["merge", "--no-ff", "-m", "merge done", "feat/done"]);

    // conflicts with main
    commit(repo, "shared.txt", "base\n", "add shared");
    sh(repo, ["checkout", "-b", "feat/conflict"]);
    commit(repo, "shared.txt", "branch side\n", "branch edit");
    sh(repo, ["checkout", "main"]);
    commit(repo, "shared.txt", "main side\n", "main edit");

    // leftover worktrees: one whose branch is merged, one whose directory vanished
    const merged = join(worktrees, "merged");
    sh(repo, ["worktree", "add", "-b", "wt/merged", merged, "main"]);
    const gone = join(worktrees, "gone");
    sh(repo, ["worktree", "add", "-b", "wt/gone", gone, "main"]);
    renameSync(gone, join(worktrees, "gone-moved"));

    // large tracked file and an uncommitted change
    writeFileSync(join(repo, "big.bin"), Buffer.alloc(2 * 1024 * 1024, 1));
    sh(repo, ["add", "big.bin"]);
    sh(repo, ["commit", "-m", "add big file"]);
    write(repo, "README.md", "changed\n");

    // unpushed commits: a bare remote that is one commit behind
    const remote = tempDir("vibe-maintain-remote-");
    sh(remote, ["init", "--bare", "-b", "main"]);
    sh(repo, ["remote", "add", "origin", remote]);
    sh(repo, ["push", "-u", "origin", "main"]);
    sh(repo, ["add", "README.md"]);
    sh(repo, ["commit", "-m", "local only"]);

    const check = createGitCheck({
      outdated: async () => [{ name: "left-pad", current: "1.0.0", latest: "2.0.0" }],
    });
    const out = await check(ctxFor(repo, { large_file_mb: 1, stale_days: 14 }));
    expect(out).not.toBeNull();
    const by = (category: string) =>
      out!.findings.filter((f) => f.category === category).map((f) => f.subject);

    expect(by("stale_branch")).toEqual(["feat/old"]);
    expect(by("merged_branch")).toEqual(["feat/done"]);
    expect(by("conflict")).toEqual(["feat/conflict"]);
    expect(by("leftover_worktree").length).toBe(2);
    expect(by("large_file")).toEqual(["big.bin"]);
    expect(by("outdated_dep")).toEqual(["left-pad"]);
    expect(by("unpushed")).toContain("main");
    // everything is committed by now
    expect(by("uncommitted")).toEqual([]);
    expect(out!.title).toMatch(/^Git 体检：发现 \d+ 项待整理$/);
    expect(out!.body).toContain("### 长期未合并的分支");
    expect(out!.body).toContain("`feat/conflict`");
  });

  it("flags uncommitted changes in the main checkout and in worktrees", async () => {
    const repo = makeRepo();
    const wt = join(tempWorktreeDir(), "w");
    sh(repo, ["worktree", "add", "-b", "wt/live", wt, "main"]);
    commit(wt, "live.txt", "x\n", "live work"); // unmerged, so it is not "leftover"
    write(wt, "scratch.txt", "dirty\n");
    write(repo, "notes.txt", "dirty\n");
    const out = await createGitCheck({ outdated: async () => null })(ctxFor(repo));
    const dirty = out!.findings.filter((f) => f.category === "uncommitted").map((f) => f.subject);
    expect(dirty).toContain("主工作区");
    expect(dirty.some((s) => s.replaceAll("\\", "/").endsWith("/w"))).toBe(true);
    expect(out!.notes.join()).toContain("过期依赖");
  });

  it("throws for a directory that is not a git repository", async () => {
    const dir = tempDir("vibe-maintain-nogit-");
    mkdirSync(join(dir, "x"));
    await expect(createGitCheck()(ctxFor(dir))).rejects.toThrow(/Not a git repository/);
  });
});
