import { describe, expect, it, vi } from "vitest";
import { createGitService, createScanState, failedGit } from "../server/git";

describe("当前 worktree 快速状态", () => {
  it.each([
    ["## feature...origin/feature [ahead 1]", "feature", "origin/feature"],
    ["## feature", "feature", null],
    ["## HEAD (no branch)", null, null],
    ["## No commits yet on main", "main", null],
    ["## Initial commit on main", "main", null],
  ])("从 Git 状态头读取分支和上游：%s", async (header, branch, upstream) => {
    const runner = {
      run: vi.fn(async (_command: string, args: string[]) => {
        if (args[0] === "rev-parse") return `${process.cwd()}\n.git\n.git`;
        if (args[0] === "status") return `${header}\n?? file.txt`;
        if (args[0] === "log") return "abc123\x00subject\x001700000000";
        return "";
      }),
      cleanup: vi.fn(async () => {}),
    };
    const service = createGitService(runner, runner, createScanState());
    expect(await service.gitStatus(process.cwd())).toMatchObject({
      branch, upstream, headSha: "abc123", headSubject: "subject",
      changes: { staged: 0, unstaged: 0, untracked: 1, total: 1 },
    });
  });
  it("必需的 status 命令失败时返回明确错误，不伪装成功", async () => {
    const runner = {
      run: vi.fn(async (_command: string, args: string[]) => {
        if (args[0] === "rev-parse") return `${process.cwd()}\n.git`;
        if (args[0] === "status") throw new Error("timed out");
        return "abc123\0subject\01700000000";
      }),
      cleanup: vi.fn(async () => {}),
    };
    const service = createGitService(runner, runner, createScanState());
    const result = await service.fastGitStatus(process.cwd());
    expect(result.status).toBe("error");
    expect(result.error).toContain("读取工作区改动失败");
  });
  it("完整 worktree 列表读取失败时保留具体原因", () => {
    expect(failedGit("/repo", new Error("worktree list timed out"))).toMatchObject({
      status: "error", workspacePath: "/repo", error: "worktree list timed out",
    });
  });

});
