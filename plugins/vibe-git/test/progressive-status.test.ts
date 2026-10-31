import { describe, expect, it, vi } from "vitest";
import { emptyGit } from "../server/git";
import { createProgressiveStatus } from "../server/progressive-status";
import type { Status } from "../shared/rpc";

function status(branch: string, scanning = false): Status {
  return {
    git: { ...emptyGit("/repo", "error"), status: "ok", branch, scanning },
    build: { status: "dashboard_down", pipelines: [] },
    release: { status: "dashboard_down", products: [] },
  };
}

describe("渐进式 Git 状态", () => {
  it("先返回当前 worktree，后台完成后返回缓存并继续获取扫描结果", async () => {
    const fast = vi.fn(async () => status("current", true));
    let finish!: (value: Status) => void;
    const complete = vi.fn(() => new Promise<Status>((resolve) => { finish = resolve; }));
    let scanning = true;
    const service = createProgressiveStatus({ fast, complete, snapshot: (value) => ({ ...value, git: { ...value.git, scanning } }) });
    const first = await service.get("workspace");
    expect(first.git.branch).toBe("current");
    expect(first.git.scanning).toBe(true);
    expect(complete).toHaveBeenCalledTimes(1);
    finish(status("old", true));
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await service.get("workspace");
    expect(second.git.branch).toBe("current");
    expect(second.git.scanning).toBe(true);
    expect(complete).toHaveBeenCalledTimes(1);
    scanning = false;
    expect((await service.get("workspace")).git.scanning).toBe(false);
    expect(fast).toHaveBeenCalledTimes(1);
    service.clear();
  });

  it("手动刷新绕过缓存，进行中的后台请求完成后仍执行强制刷新", async () => {
    const fast = vi.fn(async () => status("current"));
    let finish!: (value: Status) => void;
    const complete = vi.fn(() => new Promise<Status>((resolve) => { finish = resolve; }));
    const service = createProgressiveStatus({ fast, complete });
    await service.get("workspace");
    await service.get("workspace", true);
    expect(fast).toHaveBeenCalledTimes(2);
    expect(complete).toHaveBeenCalledTimes(1);
    finish(status("old"));
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
    expect(complete.mock.calls[1][1]).toBe(true);
    finish(status("old"));
    service.clear();
  });
  it("慢请求在时限内返回明确错误，并在已有完整结果时保留旧数据", async () => {
    const fast = vi.fn().mockResolvedValueOnce(status("current"))
      .mockImplementation(() => new Promise<Status>(() => {}));
    const complete = vi.fn(async () => status("previous"));
    const service = createProgressiveStatus({ fast, complete }, 20);
    await service.get("workspace");
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await service.get("workspace", true)).git.branch).toBe("current");
    const cold = createProgressiveStatus({ fast: () => new Promise(() => {}), complete }, 20);
    const timedOut = await cold.get("cold");
    expect(timedOut.git.status).toBe("error");
    expect(timedOut.git.error).toContain("超时");
    service.clear();
    cold.clear();
  });

  it("超时后复用进行中的请求，迟到成功自动启动后台并更新缓存", async () => {
    let finish!: (value: Status) => void;
    const fast = vi.fn(() => new Promise<Status>((resolve) => { finish = resolve; }));
    const complete = vi.fn(async () => status("complete"));
    const service = createProgressiveStatus({ fast, complete }, 10);
    expect((await service.get("workspace")).git.error).toContain("超时");
    expect((await service.get("workspace")).git.error).toContain("超时");
    expect(fast).toHaveBeenCalledTimes(1);
    finish(status("late"));
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    expect((await service.get("workspace")).git.branch).toBe("late");
    service.clear();
  });

  it("后台刷新失败保留上次结果并显示原因", async () => {
    const fast = vi.fn(async () => status("current"));
    const complete = vi.fn().mockResolvedValueOnce(status("previous"))
      .mockResolvedValueOnce({ ...status("failed"), git: { ...emptyGit("/repo", "error"), error: "Git 失败" } });
    const service = createProgressiveStatus({ fast, complete });
    await service.get("workspace");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await service.get("workspace", true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = await service.get("workspace");
    expect(result.git.branch).toBe("current");
    expect(result.git.scanError).toBe("Git 失败");
    service.clear();
  });

});
