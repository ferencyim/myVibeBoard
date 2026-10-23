import { describe, expect, it, vi } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import type { TaskConversationRow, TaskConversationSnapshot } from "@getpaseo/protocol/messages";
import { latestTaskPlan } from "./source";

const plan = {
  goal: "实现任务面板",
  approach: "调用任务命令",
  files: [],
  subtasks: [],
  checks: [{ text: "按钮与命令一致", method: "单测" }],
};
const output = "完整规划说明\n```vibe-plan\n" + JSON.stringify(plan) + "\n```";
function fixture() {
  const row: TaskConversationRow = {
    id: "row",
    epoch: "e",
    seq: 3,
    sourceKey: "planner-source",
    kind: "assistant",
    text: output,
    completed: true,
    createdAt: "2026-10-23T00:00:00.000Z",
    speaker: {
      role: "planner",
      provider: "codex",
      model: "test",
      memberId: "planner",
      backendAgentId: "agent",
    },
    source: {
      memberId: "planner",
      backendAgentId: "agent",
      epoch: "native-e",
      seq: 9,
      messageId: "message",
    },
  };
  const snapshot = {
    conversationId: "conversation",
    workspaceId: "workspace",
    members: [{ memberId: "planner", backendAgentId: "agent", role: "planner", status: "idle" }],
  } as TaskConversationSnapshot;
  const querySource = vi.fn(async () => ({ error: null, row }));
  const fetch = vi.fn(async () => ({
    error: null,
    page: {
      rows: [] as TaskConversationRow[],
      hasNewer: false,
      endCursor: null as { epoch: string; seq: number } | null,
    },
  }));
  const handle = { id: "conversation", querySource, fetch } as unknown as ReturnType<
    PaseoApi["taskConversations"]["ref"]
  >;
  return { row, snapshot, querySource, fetch, handle };
}
describe("任务确认的完整规划源", () => {
  it("读取完整源而不依赖当前UI页或最后一条复核发言", async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce({
      error: null,
      page: {
        rows: [{ ...f.row, seq: 4, speaker: { ...f.row.speaker!, role: "reviewer" } }],
        hasNewer: false,
        endCursor: null,
      },
    });
    const result = await latestTaskPlan(f.handle, f.snapshot);
    expect(result.plan).toEqual(plan);
    expect(result.source).toMatchObject({
      sourceKey: "planner-source",
      memberId: "planner",
      sourceEpoch: "native-e",
      sourceSeq: 9,
      epoch: "e",
      seq: 3,
    });
    expect(f.querySource).toHaveBeenCalledWith({ role: "planner" });
  });
  it("最新规划尚未完成时拒绝回退到旧方案", async () => {
    const f = fixture();
    f.row.completed = false;
    await expect(latestTaskPlan(f.handle, f.snapshot)).rejects.toThrow("尚未完成");
  });
  it("按钮指向旧源时拒绝执行", async () => {
    const f = fixture();
    await expect(
      latestTaskPlan(f.handle, f.snapshot, { conversationId: "conversation", sourceKey: "old" }),
    ).rejects.toThrow("来源已变化");
  });
  it("成员归属与真实后台agent必须匹配", async () => {
    const f = fixture();
    f.snapshot.members[0]!.backendAgentId = "other";
    await expect(latestTaskPlan(f.handle, f.snapshot)).rejects.toThrow("不属于");
  });
  it("规划或探路仍在运行时拒绝", async () => {
    const f = fixture();
    f.snapshot.members[0]!.status = "running";
    await expect(latestTaskPlan(f.handle, f.snapshot)).rejects.toThrow("仍在运行");
  });
  it("新讨论不能借旧方案获得授权", async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce({
      error: null,
      page: {
        rows: [{ ...f.row, kind: "user", seq: 4, text: "还要新增一个功能" }],
        hasNewer: false,
        endCursor: null,
      },
    });
    await expect(latestTaskPlan(f.handle, f.snapshot)).rejects.toThrow("新讨论");
  });
  it("完整检查方案之后的所有页", async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce({
      error: null,
      page: { rows: [], hasNewer: true, endCursor: { epoch: "e", seq: 500 } },
    });
    f.fetch.mockResolvedValueOnce({
      error: null,
      page: {
        rows: [{ ...f.row, kind: "user", seq: 501, text: "确认" }],
        hasNewer: false,
        endCursor: null,
      },
    });
    await expect(latestTaskPlan(f.handle, f.snapshot)).rejects.toThrow("新讨论");
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  it("截断或无效JSON不得使用旧快照兜底", async () => {
    const f = fixture();
    f.row.text = output.slice(0, -3);
    await expect(latestTaskPlan(f.handle, f.snapshot)).rejects.toThrow("不完整");
  });
  it("分页缺口或源读取失败时拒绝", async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce({
      error: null,
      page: { rows: [], hasNewer: true, endCursor: null },
    });
    await expect(latestTaskPlan(f.handle, f.snapshot)).rejects.toThrow("分页不完整");
  });
});
