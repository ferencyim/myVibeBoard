// Human readable one-liners for card timeline events. Pure.

import type { CardEvent, CardEventType } from "../../shared/vibe/contract";
import { COLUMN_LABELS } from "../board/logic";

export const EVENT_TYPE_LABELS: Record<CardEventType, string> = {
  evaluation: "评估",
  status: "状态",
  switch_agent: "切换 agent",
  compaction: "压缩",
  reject: "退回",
  note: "备注",
  maintenance: "维护",
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const col = (v: unknown) => COLUMN_LABELS[v as keyof typeof COLUMN_LABELS] ?? String(v);

export function describeEvent(event: Pick<CardEvent, "type" | "body">): string {
  const body = event.body;
  if (typeof body === "string") return body;
  if (!isRecord(body)) return body == null ? "" : String(body);
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
    return `会话${body.kind.slice("session_".length)}${message}`;
  }
  if (event.type === "switch_agent") return `${String(body.from)} → ${String(body.to)}`;
  if (event.type === "compaction") return `已压缩上下文（${String(body.strategy ?? "")}）`;
  const json = JSON.stringify(body);
  return json.length > 200 ? `${json.slice(0, 200)}…` : json;
}
