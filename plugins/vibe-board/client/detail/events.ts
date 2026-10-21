// Human readable one-liners for card timeline events. Pure.

import type { CardEvent, CardEventType, ProposalStatus } from "../../shared/vibe/contract";
import { COLUMN_LABELS } from "../board/logic";
import { AUTHOR_LABELS, PROPOSAL_STATUS_LABELS } from "../planning/logic";

export const EVENT_TYPE_LABELS: Record<CardEventType, string> = {
  evaluation: "评估",
  status: "状态",
  switch_agent: "切换 agent",
  compaction: "压缩",
  reject: "退回",
  note: "备注",
  maintenance: "维护",
  chat: "群聊",
  proposal: "修改建议",
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const SESSION_STATE_LABELS: Record<string, string> = {
  waiting: "会话在等你回复",
  error: "会话出错",
  ended: "会话已结束",
};

const col = (v: unknown) => COLUMN_LABELS[v as keyof typeof COLUMN_LABELS] ?? String(v);

export function describeEvent(event: Pick<CardEvent, "type" | "body"> & { authorKind?: string }): string {
  const body = event.body;
  if (typeof body === "string") return body;
  if (!isRecord(body)) return body == null ? "" : String(body);
  if (body.kind === "reply") return `已回复：${String(body.text ?? "")}`;
  if (body.kind === "reply_stale") {
    const why = body.reason === "already_answered" ? "问题已被回答" : "问题已不存在";
    return `离线回复未发送（${why}）：${String(body.text ?? "")}`;
  }
  if (event.type === "chat" && typeof body.text === "string") {
    return `[${(AUTHOR_LABELS as Record<string, string>)[event.authorKind ?? ""] ?? event.authorKind ?? "?"}] ${body.text}`;
  }
  if (event.type === "proposal") {
    const status = PROPOSAL_STATUS_LABELS[body.status as ProposalStatus] ?? "";
    return `修改建议（${status}）：${String(body.rationale ?? "")}`;
  }
  if (typeof body.text === "string") return body.text;
  switch (body.kind) {
    case "created":
      return `创建于「${col(body.column)}」`;
    case "moved": {
      const reason = typeof body.reason === "string" && body.reason ? `（${body.reason}）` : "";
      return `${col(body.from)} → ${col(body.to)}${reason}`;
    }
    case "session_started":
      return `会话已启动：${String(body.role ?? "")} / ${String(body.provider ?? "")}`;
    default:
      break;
  }
  if (typeof body.kind === "string" && body.kind.startsWith("session_")) {
    const message = typeof body.message === "string" && body.message ? `：${body.message}` : "";
    return `${SESSION_STATE_LABELS[body.kind.slice("session_".length)] ?? body.kind}${message}`;
  }
  if (event.type === "switch_agent") return `${String(body.from)} → ${String(body.to)}`;
  if (event.type === "compaction") return `已压缩上下文（${String(body.strategy ?? "")}）`;
  const json = JSON.stringify(body);
  return json.length > 200 ? `${json.slice(0, 200)}…` : json;
}
