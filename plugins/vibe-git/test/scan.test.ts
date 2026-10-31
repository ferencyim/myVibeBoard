import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createGitService, createScanState } from "../server/git";
import { normalizePath } from "../server/parse";
import type { ProcessRunner } from "../server/process";

it("逐项发布，合并强制刷新，失败时保留旧结果和时间", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vibe-git-scan-"));
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  await Promise.all([mkdir(first), mkdir(second)]);
  const listing = [root, first, second].map((p, i) => `worktree ${p}\nbranch refs/heads/b${i}`).join("\n\n");
  const runner: ProcessRunner = { async cleanup() {}, async run(_command, args) {
    if (args[0] === "worktree") return listing;
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return `${root}\n.git\n.git`;
    return "";
  } };
  let release!: (value: string) => void;
  const blocked = new Promise<string>((resolve) => { release = resolve; });
  let firstCalls = 0;
  const scan = vi.fn<ProcessRunner["run"]>(async (_command, _args, options) => {
    if (options?.cwd === first) {
      if (++firstCalls === 2) throw new Error("扫描失败示例");
      return "?? first.txt";
    }
    return blocked;
  });
  const state = createScanState();
  const service = createGitService(runner, { run: scan, async cleanup() {} }, state);
  try {
    await service.gitStatus(root);
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(2));
    const partial = await service.gitStatus(root);
    const saved = partial.worktrees.find((w) => w.path === first)!;
    expect(partial.scanning).toBe(true);
    expect(saved.changes?.total).toBe(1);
    expect(saved.changesScannedAt).toBeTruthy();
    expect(partial.worktrees.find((w) => w.path === second)?.changes).toBeNull();
    await service.gitStatus(root, true);
    await service.gitStatus(root, true);
    release("?? second.txt");
    await vi.waitFor(() => expect(state.scans.get(normalizePath(root))?.scanning).toBe(false));
    expect(scan).toHaveBeenCalledTimes(4);
    const result = await service.gitStatus(root);
    expect(result.scanError).toContain("扫描失败示例");
    expect(result.worktrees.find((w) => w.path === first)?.changes).toEqual(saved.changes);
    expect(result.worktrees.find((w) => w.path === first)?.changesScannedAt).toBe(saved.changesScannedAt);
    expect(result.worktrees.find((w) => w.path === second)?.changes?.total).toBe(1);
  } finally {
    state.closed = true;
    release("");
    await rm(root, { recursive: true, force: true });
  }
});
