import { describe, expect, it } from "vitest";
import { pathInScope, subtaskScope } from "../db";
import { setup } from "./helpers";

function fixture() {
  const state = setup();
  state.store.tasks.create({ workspaceId: "ws", anchorAgentId: "main" });
  const board = state.store.taskBoard;
  board.seed("ws", "2026-01-01T00:00:00.000Z", [
    { id: "A", goal: "改 A", files: ["src/a/**"], dependsOn: [] },
    { id: "B", goal: "改 B", files: ["src/a/b.ts"], dependsOn: [] },
    { id: "C", goal: "改 C", files: ["src/c.ts"], dependsOn: ["A"], acceptance: "单测" },
  ]);
  return { ...state, board };
}

describe("WP-127 task board", () => {
  it("seeds the confirmed subtasks as todo, replacing an older board", () => {
    const { board } = fixture();
    expect(board.list("ws").map((row) => [row.id, row.status, row.source])).toEqual([
      ["A", "todo", "plan"],
      ["B", "todo", "plan"],
      ["C", "todo", "plan"],
    ]);
    board.seed("ws", "2026-01-02T00:00:00.000Z", [{ id: "X", goal: "x", files: ["x"], dependsOn: [] }]);
    expect(board.list("ws").map((row) => row.id)).toEqual(["X"]);
  });

  it("a replayed confirmation keeps the board; a new round stops running claims instead of dropping them", () => {
    const { board } = fixture();
    board.claim("ws", "A", { agentId: "sub-a", tabNumber: 3 });
    expect(board.seed("ws", "2026-01-01T00:00:00.000Z", [])).toEqual({ seeded: false, displaced: [] });
    expect(board.get("ws", "A")).toMatchObject({ status: "in_progress", claimedBy: "sub-a" });
    const next = board.seed("ws", "2026-01-02T00:00:00.000Z", [
      { id: "B", goal: "新 B", files: ["src/b.ts"], dependsOn: [] },
    ]);
    expect(next.seeded).toBe(true);
    expect(next.displaced.map((row) => [row.id, row.claimedBy])).toEqual([["A", "sub-a"]]);
    expect(board.list("ws").map((row) => [row.id, row.status, row.claimedBy])).toEqual([
      ["B", "todo", null],
      ["A", "blocked", null],
    ]);
    expect(board.get("ws", "A")!.summary).toContain("方案已重新确认");
    // A blocked leftover can be claimed again once the executor decides to.
    expect(board.claim("ws", "A", { agentId: "sub-a2", tabNumber: 3 }).ok).toBe(true);
  });

  it("read-only claims take no scope; a writer must declare one, a whole-repo writer says **", () => {
    const { board } = fixture();
    board.add("ws", { id: "R", goal: "调研", files: [], dependsOn: [], readOnly: true }, null);
    board.add("ws", { id: "W", goal: "整仓", files: ["**"], dependsOn: [] }, null);
    expect(() => board.add("ws", { id: "N", goal: "无范围", files: [" "], dependsOn: [] }, null)).toThrow(
      "没有声明文件范围",
    );
    expect(board.claim("ws", "A", { agentId: "a", tabNumber: 3 }).ok).toBe(true);
    expect(board.claim("ws", "R", { agentId: "r", tabNumber: 3 })).toMatchObject({
      ok: true,
      subtask: { readOnly: true },
    });
    // A read-only claim blocks no writer.
    expect(board.claim("ws", "W", { agentId: "w", tabNumber: 3 })).toMatchObject({
      ok: false,
      code: "overlap",
      holder: "A",
    });
    board.release("ws", "A", { status: "todo", summary: "" });
    expect(board.claim("ws", "W", { agentId: "w", tabNumber: 3 }).ok).toBe(true);
    // A plan subtask without files and without readOnly cannot be claimed until it gets a scope.
    board.seed("ws", "2026-01-03T00:00:00.000Z", [{ id: "P", goal: "p", files: [], dependsOn: [] }]);
    expect(board.claim("ws", "P", { agentId: "p", tabNumber: 3 })).toMatchObject({
      ok: false,
      code: "no_scope",
    });
  });

  it("rejects an overlapping claim, a blocked dependency and a second claimer", () => {
    const { board } = fixture();
    expect(board.claim("ws", "A", { agentId: "sub-a", tabNumber: 3, claim: { head: "h" } })).toMatchObject({
      ok: true,
      subtask: { status: "in_progress", claimedBy: "sub-a", claimedTab: 3, claim: { head: "h" } },
    });
    const overlap = board.claim("ws", "B", { agentId: "sub-b", tabNumber: 3 });
    expect(overlap).toMatchObject({ ok: false, code: "overlap" });
    expect(overlap.ok ? "" : overlap.message).toContain("A");
    const blocked = board.claim("ws", "C", { agentId: "sub-c", tabNumber: 3 });
    expect(blocked).toMatchObject({ ok: false, code: "blocked_by" });
    expect(blocked.ok ? "" : blocked.message).toContain("A（进行中");
    expect(board.claim("ws", "A", { agentId: "other", tabNumber: 3 })).toMatchObject({
      ok: false,
      code: "claimed",
    });
    // The same claimer claiming again is a no-op, not a rejection.
    expect(board.claim("ws", "A", { agentId: "sub-a", tabNumber: 3 }).ok).toBe(true);
    expect(board.claim("ws", "Z", { agentId: "sub-a", tabNumber: 3 })).toMatchObject({
      ok: false,
      code: "not_found",
    });
    board.complete("ws", "A", { summary: "完成", result: { outOfScope: [] } });
    expect(board.claim("ws", "C", { agentId: "sub-c", tabNumber: 3 }).ok).toBe(true);
    expect(board.claim("ws", "B", { agentId: "sub-b", tabNumber: 3 }).ok).toBe(true);
    expect(board.claim("ws", "A", { agentId: "sub-a", tabNumber: 3 })).toMatchObject({
      ok: false,
      code: "done",
    });
  });

  it("hands a claim to the dispatched sub-agent, releases it as blocked and lets it be claimed again", () => {
    const { board } = fixture();
    const claimedAt = board.claim("ws", "A", { agentId: "main", tabNumber: 3 }).ok
      ? board.get("ws", "A")!.claimedAt!
      : "";
    expect(board.setClaim("ws", "A", "other-time", { snapshot: null })).toBe(false);
    expect(board.setClaim("ws", "A", claimedAt, { snapshot: null })).toBe(true);
    expect(board.get("ws", "A")!.claim).toEqual({ snapshot: null });
    expect(board.assign("ws", "A", "someone-else", "sub")).toBe(false);
    expect(board.assign("ws", "A", "main", "sub")).toBe(true);
    expect(board.get("ws", "A")).toMatchObject({ claimedBy: "sub" });
    expect(board.release("ws", "A", { status: "blocked", summary: "测试失败" })).toMatchObject({
      status: "blocked",
      claimedBy: null,
      summary: "测试失败",
    });
    expect(() => board.release("ws", "A", { status: "todo", summary: "" })).toThrow("不在进行中");
    expect(board.claim("ws", "A", { agentId: "sub-2", tabNumber: 3 }).ok).toBe(true);
  });

  it("lets the executor add subtasks to an empty board and re-scope a running one only without overlap", () => {
    const state = setup();
    state.store.tasks.create({ workspaceId: "ws", anchorAgentId: "main" });
    const board = state.store.taskBoard;
    expect(board.list("ws")).toEqual([]);
    board.add("ws", { id: "one", goal: "第一", files: ["a.ts"], dependsOn: [] }, null);
    board.add("ws", { id: "two", goal: "第二", files: ["b.ts"], dependsOn: ["one"] }, null);
    expect(() =>
      board.add("ws", { id: "three", goal: "坏", files: ["x"], dependsOn: ["missing"] }, null),
    ).toThrow("不存在");
    expect(() =>
      board.add("ws", { id: "one", goal: "第一", files: ["a.ts"], dependsOn: ["two"] }, null),
    ).toThrow("成环");
    board.add("ws", { id: "solo", goal: "独立", files: ["c.ts"], dependsOn: [] }, null);
    board.claim("ws", "one", { agentId: "x", tabNumber: 3 });
    board.claim("ws", "solo", { agentId: "y", tabNumber: 3 });
    expect(() =>
      board.add("ws", { id: "solo", goal: "独立", files: ["a.ts"], dependsOn: [] }, null),
    ).toThrow("重叠");
    expect(
      board.add("ws", { id: "solo", goal: "独立", files: ["c.ts", "d.ts"], dependsOn: [] }, null).files,
    ).toEqual(["c.ts", "d.ts"]);
    expect(board.list("ws").map((row) => [row.id, row.source])).toEqual([
      ["one", "agent"],
      ["two", "agent"],
      ["solo", "agent"],
    ]);
  });

  it("an empty scope covers nothing; ** covers the whole repository", () => {
    expect(subtaskScope([" "])).toEqual([]);
    expect(pathInScope("any/file.ts", [])).toBe(false);
    expect(pathInScope("any/file.ts", ["**"])).toBe(true);
    expect(pathInScope("src/a/x.ts", ["src/a/**"])).toBe(true);
    expect(pathInScope("src/b.ts", ["src/a/**"])).toBe(false);
  });
});
