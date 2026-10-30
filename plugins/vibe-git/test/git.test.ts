import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitStatus } from "../server/git";
import { normalizePath } from "../server/parse";

const temporaryDirectories: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("真实 Git 仓库状态", () => {
  it("识别主检出、附加 worktree、分叉和未提交改动", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "vibe-git-test-"));
    temporaryDirectories.push(dir);
    const main = path.join(dir, "main");
    const origin = path.join(dir, "origin.git");
    const worktree = path.join(dir, "worktree");
    git(dir, "init", "--bare", origin);
    git(dir, "init", "-b", "main", main);
    git(main, "config", "user.email", "test@example.com");
    git(main, "config", "user.name", "Test");
    await writeFile(path.join(main, "tracked.txt"), "initial\n");
    git(main, "add", "tracked.txt");
    git(main, "commit", "-m", "initial");
    git(main, "remote", "add", "origin", origin);
    git(main, "push", "-u", "origin", "main");
    git(main, "worktree", "add", "-b", "feature", worktree);
    await writeFile(path.join(worktree, "feature.txt"), "feature\n");
    git(worktree, "add", "feature.txt");
    git(worktree, "commit", "-m", "feature");
    await writeFile(path.join(main, "main.txt"), "main\n");
    git(main, "add", "main.txt");
    git(main, "commit", "-m", "main change");
    git(main, "push");
    await writeFile(path.join(worktree, "tracked.txt"), "modified\n");
    await writeFile(path.join(worktree, "new.txt"), "new\n");
    git(worktree, "add", "new.txt");
    await writeFile(path.join(worktree, "untracked.txt"), "untracked\n");
    await writeFile(path.join(main, "untracked-main.txt"), "untracked\n");

    const result = await gitStatus(worktree);
    expect(result.status).toBe("ok");
    expect(result.branch).toBe("feature");
    expect(result.isMain).toBe(false);
    expect(normalizePath(result.mainPath!)).toBe(normalizePath(main));
    expect(result.baseCounts).toEqual({ ahead: 1, behind: 1 });
    expect(result.changes).toEqual({ staged: 1, unstaged: 1, untracked: 1, total: 3 });
    const current = result.worktrees.find((entry) => entry.current);
    const primary = result.worktrees.find((entry) => normalizePath(entry.path) === normalizePath(main));
    expect(current).toMatchObject({
      branch: "feature",
      counts: { ahead: 1, behind: 1 },
      merged: false,
      changes: { staged: 1, unstaged: 1, untracked: 1, total: 3 },
    });
    expect(primary).toMatchObject({
      current: false,
      merged: true,
      counts: { ahead: 0, behind: 0 },
      changes: { staged: 0, unstaged: 0, untracked: 1, total: 1 },
    });
    const mainStatus = await gitStatus(main);
    expect(mainStatus.isMain).toBe(true);
    expect(mainStatus.worktrees.find((entry) => entry.current)?.branch).toBe("main");
  }, 30000);

  it("对非 Git 目录返回 not_git", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "vibe-git-empty-"));
    temporaryDirectories.push(dir);
    expect((await gitStatus(dir)).status).toBe("not_git");
  });
});
