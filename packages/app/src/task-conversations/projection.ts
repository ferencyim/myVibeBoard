import type { TaskConversationRow, TaskConversationMember } from "@getpaseo/protocol/messages";
import type { SubagentRow } from "@/subagents/select";
import { createUserMessage, type StreamItem, type UserMessageItem } from "@/types/stream";

export function selectTaskConversationChildren(
  rows: readonly SubagentRow[],
  parentMemberId: string,
  members: readonly TaskConversationMember[],
): SubagentRow[] {
  const childAgentIds = new Set(
    members
      .filter((member) => member.parentMemberId === parentMemberId)
      .map((member) => member.backendAgentId),
  );
  return rows.filter((row) => row.kind === "provider" || childAgentIds.has(row.id));
}

function projectUserRow(
  row: TaskConversationRow,
  local: UserMessageItem | undefined,
): UserMessageItem {
  return createUserMessage({
    id: local?.id ?? row.id,
    clientMessageId: row.clientMessageId,
    messageId: row.id,
    timelineCursor: { epoch: row.epoch, seq: row.seq },
    text: local?.text ?? row.text,
    timestamp: local?.timestamp ?? new Date(row.createdAt),
    images: local?.images,
    attachments: local?.attachments ?? row.attachments,
  });
}

export function projectTaskConversationRows(
  rows: readonly TaskConversationRow[],
  submittedRows: readonly UserMessageItem[],
): StreamItem[] {
  const localByIdentity = new Map(submittedRows.map((row) => [row.clientMessageId, row]));
  const acknowledged = new Set<string>();
  const projected = rows.map((row): StreamItem => {
    const timestamp = new Date(row.createdAt);
    const timelineCursor = { epoch: row.epoch, seq: row.seq };
    if (row.kind === "user") {
      if (row.clientMessageId) acknowledged.add(row.clientMessageId);
      const local = row.clientMessageId ? localByIdentity.get(row.clientMessageId) : undefined;
      return projectUserRow(row, local);
    }
    const turnId = `${row.source?.memberId ?? row.speaker?.memberId ?? "system"}:${row.source?.sourceTurnId ?? row.id}`;
    if (row.kind === "assistant" || row.kind === "artifact") {
      return {
        kind: "assistant_message",
        id: row.id,
        messageId: row.id,
        turnId,
        timelineCursor,
        text: row.text,
        timestamp,
      };
    }
    return {
      kind: "notification",
      id: row.id,
      turnId,
      timelineCursor,
      timestamp,
      sourceType: "notification",
      level: "info",
      message: row.text,
    };
  });
  for (const row of submittedRows) {
    if (!acknowledged.has(row.clientMessageId ?? "") && !row.messageId) projected.push(row);
  }
  return projected;
}
