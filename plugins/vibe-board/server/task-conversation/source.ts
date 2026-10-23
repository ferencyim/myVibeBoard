import type { PaseoApi } from "@getpaseo/client";
import type { TaskConversationRow, TaskConversationSnapshot } from "@getpaseo/protocol/messages";
import { parseTaskPlan, type TaskPlanSource } from "../vibe/contract";

export const busyMember = (status: string) =>
  ["initializing", "running", "stopping", "waiting", "waiting_for_permission"].includes(status);

export function taskSource(conversationId: string, row: TaskConversationRow): TaskPlanSource {
  return {
    conversationId,
    sourceKey: row.sourceKey,
    memberId: row.source?.memberId ?? row.speaker?.memberId,
    backendAgentId: row.source?.backendAgentId ?? row.speaker?.backendAgentId,
    sourceTurnId: row.source?.sourceTurnId,
    epoch: row.epoch,
    seq: row.seq,
    messageId: row.source?.messageId,
    sourceEpoch: row.source?.epoch,
    sourceSeq: row.source?.seq,
  };
}

/** querySource returns the persisted full source, independently of the UI's current page. */
export async function latestTaskPlan(
  handle: ReturnType<PaseoApi["taskConversations"]["ref"]>,
  snapshot: TaskConversationSnapshot,
  expected?: TaskPlanSource,
) {
  const result = await handle.querySource({ role: "planner" });
  if (result.error) throw new Error("无法读取最新规划源：" + result.error);
  const row = result.row;
  if (!row || row.kind !== "assistant" || !row.completed || row.speaker?.role !== "planner")
    throw new Error("最新规划发言尚未完成，不能执行旧方案");
  const source = taskSource(handle.id, row);
  const member = snapshot.members.find((item) => item.memberId === source.memberId);
  if (!member || member.role !== "planner" || member.backendAgentId !== source.backendAgentId)
    throw new Error("方案源不属于本任务的规划成员");
  if (
    snapshot.members.some(
      (item) =>
        ["planner", "scout", "plan_reviewer"].includes(item.role) && busyMember(item.status),
    )
  )
    throw new Error("规划或方案复核仍在运行，请等待本轮完成");
  if (
    expected &&
    ["conversationId", "sourceKey", "memberId", "backendAgentId", "epoch", "seq"].some(
      (key) =>
        expected[key as keyof TaskPlanSource] !== undefined &&
        expected[key as keyof TaskPlanSource] !== source[key as keyof TaskPlanSource],
    )
  )
    throw new Error("方案来源已变化，请查看最新方案后重新执行");
  let cursor = { epoch: row.epoch, seq: row.seq };
  for (;;) {
    const response = await handle.fetch({ cursor, direction: "after", limit: 500 });
    if (response.error || !response.page) throw new Error("无法核对方案之后的公开讨论");
    if (
      response.page.rows.some(
        (item) => item.kind === "user" && item.seq > row.seq && !/^\s*\/执行\s*$/.test(item.text),
      )
    )
      throw new Error("方案后已有新讨论，请规划成员更新完整方案后重新执行");
    if (!response.page.hasNewer) break;
    const next = response.page.endCursor;
    if (!next || next.seq <= cursor.seq) throw new Error("方案来源分页不完整，请重试");
    cursor = next;
  }
  return { row, source, plan: parseTaskPlan(row.text) };
}
