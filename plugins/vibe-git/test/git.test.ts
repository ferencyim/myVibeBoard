import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitService, createScanState } from "../server/git";
import { createProcessRunner } from "../server/process";
import { normalizePath } from "../server/parse";

const temporaryDirectories: string[] = [];
const activeRunners: ReturnType<typeof createProcessRunner>[] = [];
const activeScans: ReturnType<typeof createScanState>[] = [];

function makeRunner() {
  const runner = createProcessRunner();
  activeRunners.push(runner);
  return runner;
}

function makeScanState() {
  const state = createScanState();
  activeScans.push(state);
  return state;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

afterEach(async () => {
  for (const state of activeScans.splice(0)) state.closed = true;
  await Promise.all(activeRunners.splice(0).map((runner) => runner.cleanup()));
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

    const runner = makeRunner();
    const scanner = makeRunner();
    const scanState = makeScanState();
    const { gitStatus } = createGitService(runner, scanner, scanState);
    const result = await gitStatus(worktree);
    expect(result.status).toBe("ok");
    expect(result.branch).toBe("feature");
    expect(result.isMain).toBe(false);
    expect(normalizePath(result.mainPath!)).toBe(normalizePath(main));
    expect(result.baseCounts).toEqual({ ahead: 1, behind: 1 });
    expect(result.changes).toEqual({ staged: 1, unstaged: 1, untracked: 1, total: 3 });
    const current = result.worktrees.find((entry) => entry.current);
    const primary = result.worktrees.find((entry) => normalizePath(entry.path) === normalizePath(main));
    expect(primary?.changes).toBeNull();
    expect(result.scanning).toBe(true);
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
    });
    for (let i = 0; i < 100 && scanState.scans.get(normalizePath(main))?.scanning; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const rescanned = await gitStatus(worktree);
    expect(rescanned.worktrees.find((entry) => normalizePath(entry.path) === normalizePath(main))?.changes)
      .toEqual({ staged: 0, unstaged: 0, untracked: 1, total: 1 });
    expect(rescanned.changesScannedAt).toBeTruthy();

    const run = vi.spyOn(scanner, "run").mockRejectedValueOnce(new Error("扫描超时"));
    const forced = await gitStatus(worktree, true);
    expect(forced.scanning).toBe(true);
    for (let i = 0; i < 100 && scanState.scans.get(normalizePath(main))?.scanning; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const failed = await gitStatus(worktree);
    expect(failed.scanError).toContain("扫描超时");
    expect(failed.changesScannedAt).toBe(rescanned.changesScannedAt);
    expect(failed.worktrees.find((entry) => normalizePath(entry.path) === normalizePath(main))?.changesScannedAt)
      .toBe(rescanned.worktrees.find((entry) => normalizePath(entry.path) === normalizePath(main))?.changesScannedAt);
    expect(failed.worktrees.find((entry) => normalizePath(entry.path) === normalizePath(main))?.changes)
      .toEqual({ staged: 0, unstaged: 0, untracked: 1, total: 1 });
    expect(run).toHaveBeenCalledTimes(1);
    await gitStatus(worktree, true);
    for (let i = 0; i < 100 && scanState.scans.get(normalizePath(main))?.scanning; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect((await gitStatus(worktree)).scanError).toBeNull();
    expect(run).toHaveBeenCalledTimes(2);
    run.mockRestore();

    const second = path.join(dir, "second");
    git(main, "worktree", "add", "-b", "second", second);
    let finishSlow!: (value: string) => void;
    const slow = new Promise<string>((resolve) => { finishSlow = resolve; });
    const incremental = vi.spyOn(scanner, "run").mockImplementation(async (_command, _args, options) => {
      if (normalizePath(options!.cwd!) === normalizePath(second)) return slow;
      return "?? new-result.txt\n?? another.txt";
    });
    await gitStatus(worktree, true);
    for (let i = 0; i < 100 && incremental.mock.calls.length < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const partial = await gitStatus(worktree);
    expect(partial.scanning).toBe(true);
    expect(partial.changesScannedAt).toBeTruthy();
    expect(partial.worktrees.find((entry) => normalizePath(entry.path) === normalizePath(main))?.changes)
      .toEqual({ staged: 0, unstaged: 0, untracked: 2, total: 2 });
    expect(partial.worktrees.find((entry) => normalizePath(entry.path) === normalizePath(second))?.changes)
      .toBeNull();
    expect(partial.worktrees.find((entry) => normalizePath(entry.path) === normalizePath(main))?.changesScannedAt)
      .toBeTruthy();
    expect(partial.worktrees.find((entry) => normalizePath(entry.path) === normalizePath(second))?.changesScannedAt)
      .toBeNull();
    await gitStatus(worktree, true);
    await gitStatus(worktree, true);
    finishSlow("?? second-result.txt");
    for (let i = 0; i < 100 && scanState.scans.get(normalizePath(main))?.scanning; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect((await gitStatus(worktree)).worktrees.find(
      (entry) => normalizePath(entry.path) === normalizePath(second),
    )?.changes).toEqual({ staged: 0, unstaged: 0, untracked: 1, total: 1 });
    expect(incremental).toHaveBeenCalledTimes(4);
    expect((await gitStatus(worktree)).worktrees.find(
      (entry) => normalizePath(entry.path) === normalizePath(second),
    )?.changesScannedAt).toBeTruthy();
    incremental.mockRestore();
    const mainStatus = await gitStatus(main);
    expect(mainStatus.isMain).toBe(true);
    expect(mainStatus.worktrees.find((entry) => entry.current)?.branch).toBe("main");
    scanState.closed = true;
    await Promise.all([runner.cleanup(), scanner.cleanup()]);
  }, 30000);

  it("对非 Git 目录返回 not_git", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "vibe-git-empty-"));
    temporaryDirectories.push(dir);
    const runner = makeRunner();
    const scanner = makeRunner();
    const { gitStatus } = createGitService(runner, scanner, makeScanState());
    expect((await gitStatus(dir)).status).toBe("not_git");
    await Promise.all([runner.cleanup(), scanner.cleanup()]);
  });
});
