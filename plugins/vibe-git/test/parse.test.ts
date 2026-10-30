import { describe, expect, it } from "vitest";
import {
  matchesRepo,
  normalizePath,
  parseCounts,
  parseStatus,
  parseWorktrees,
  selectDashboard,
} from "../server/parse";

describe("Git 和 dashboard 解析", () => {
  it("规范路径并以主检出匹配 worktree 的仓库", () => {
    expect(normalizePath("D:\\Repo\\App\\")).toBe("d:/repo/app");
    expect(matchesRepo(["d:/repo/app/", "d:/other"], "D:\\Repo\\App")).toBe(true);
  });

  it("统计 porcelain 文件而非状态数", () => {
    expect(parseStatus("MM file\nA  added\n?? new\n")).toEqual({
      staged: 2,
      unstaged: 1,
      untracked: 1,
      total: 3,
    });
  });

  it("解析 worktree 与 ahead/behind", () => {
    expect(parseWorktrees(
      "worktree /a\nbranch refs/heads/main\n\nworktree /b\ndetached\nprunable missing\n",
    )).toEqual([
      { path: "/a", branch: "main", detached: false, prunable: false },
      { path: "/b", branch: null, detached: true, prunable: true },
    ]);
    expect(parseCounts("2\t3")).toEqual({ ahead: 2, behind: 3 });
    expect(parseCounts("bad")).toBeNull();
  });

  it("区分 dashboard 不可达、未配置和旧数据", () => {
    expect(selectDashboard(null, "products", "/a", true).status).toBe("dashboard_down");
    expect(selectDashboard({ products: [] }, "products", "/a").status).toBe("not_configured");
    const result = selectDashboard({
      products: [{ repo: "/a", stale: true, status: "unreachable" }],
    }, "products", "/a");
    expect(result.values[0]).toMatchObject({ stale: true, status: "unreachable" });
  });
});
