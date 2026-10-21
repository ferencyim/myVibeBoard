// Pure helpers of the card group chat (WP-92). The chat is made of `chat` and `proposal` card
// events plus a whitelist of status/reject events shown as small system rows. Who receives a user
// message is decided server-side by the card's column (see the routing rules in the WP-92 notes);
// routeHint/masterBusy mirror that rule for display only.

import type {
  AgentSession,
  AuthorKind,
  CardEvent,
  CardView,
  ChatKind,
  ProposalChanges,
  ProposalStatus,
} from "../../shared/vibe/contract";
import { COLUMN_LABELS } from "../board/logic";

export const AUTHOR_LABELS: Record<AuthorKind, string> = {
  user: "你",
  master: "总 agent",
  agent: "总 agent",
  executor: "执行 agent",
  reviewer: "复核",
  scout: "探路兵",
  system: "系统",
};

const CHAT_KIND_LABELS: Record<ChatKind, string> = {
  question: "提问",
  summary: "总结",
  verdict: "结论",
  info: "说明",
};

export const PROPOSAL_STATUS_LABELS: Record<ProposalStatus, string> = {
  pending: "待处理",
  accepted: "已采纳",
  rejected: "已拒绝",
  superseded: "已被新建议取代",
};

export type ProposalField = "title" | "description" | "acceptance";
const PROPOSAL_FIELDS: readonly { field: ProposalField; label: string }[] = [
  { field: "title", label: "标题" },
  { field: "description", label: "描述" },
  { field: "acceptance", label: "验收标准" },
];

export interface MessageItem {
  kind: "message";
  id: string;
  author: AuthorKind;
  label: string;
  text: string;
  at: string;
  msgKind?: ChatKind;
  msgKindLabel?: string;
  agentId?: string;
  detail?: string;
  ready?: boolean;
  error?: boolean;
  planVersion?: number;
  /** User messages only: some chat message answers it. */
  answered: boolean;
  /** User messages only: the router could not forward it, so the master handles it. */
  fallback: boolean;
}
export interface ProposalItem {
  kind: "proposal";
  id: string;
  status: ProposalStatus;
  statusLabel: string;
  changes: ProposalChanges;
  before?: ProposalChanges;
  rationale: string;
  at: string;
}
export interface SystemItem {
  kind: "system";
  id: string;
  text: string;
  at: string;
  link?: "verification";
}
export type ChatItem = MessageItem | ProposalItem | SystemItem;

interface Body {
  kind?: string;
  text?: string;
  reason?: string;
  message?: string;
  from?: string;
  to?: string;
  answers?: unknown;
  fallback?: unknown;
  [key: string]: unknown;
}

const bodyOf = (e: CardEvent): Body =>
  e.body && typeof e.body === "object" && !Array.isArray(e.body) ? (e.body as Body) : {};

export const HANDOFF_REQUEST_BODY = { kind: "handoff_request" } as const;

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

const SYSTEM_STATUS_KINDS = new Set([
  "failover",
  "failover_failed",
  "dispatch_failed",
  "worker_unreachable",
  "finalized",
  "assessment_failed",
]);
const col = (v: unknown) => COLUMN_LABELS[v as keyof typeof COLUMN_LABELS] ?? String(v);

function systemRow(e: CardEvent): SystemItem | null {
  const b = bodyOf(e);
  const base = { kind: "system" as const, id: e.id, at: e.createdAt };
  if (e.type === "reject") {
    const text = str(b.text) ?? str(b.reason) ?? str(b.message);
    return text ? { ...base, text: `退回：${text}` } : null;
  }
  if (e.type !== "status") return null;
  if (b.kind === "moved") {
    const reason = str(b.reason) ? `（${b.reason}）` : "";
    return { ...base, text: `${col(b.from)} → ${col(b.to)}${reason}` };
  }
  if (b.kind === "verification") {
    return { ...base, text: str(b.text) ?? "验证已完成", link: "verification" };
  }
  if (typeof b.kind === "string" && SYSTEM_STATUS_KINDS.has(b.kind)) {
    const text = str(b.text) ?? str(b.message);
    return text ? { ...base, text } : null;
  }
  return null;
}

/** The chat in time order: messages, proposals and a few derived system rows. */
export function chatItemsOf(events: readonly CardEvent[]): ChatItem[] {
  const answered = new Set<string>();
  const fallback = new Set<string>();
  for (const e of events) {
    if (e.type !== "chat") continue;
    const b = bodyOf(e);
    for (const id of strings(b.answers)) answered.add(id);
    for (const id of strings(b.fallback)) fallback.add(id);
  }
  const items: ChatItem[] = [];
  for (const e of events) {
    const b = bodyOf(e);
    if (e.type === "chat") {
      const msgKind = b.kind as ChatKind | undefined;
      items.push({
        kind: "message",
        id: e.id,
        author: e.authorKind,
        label: AUTHOR_LABELS[e.authorKind] ?? e.authorKind,
        text: typeof b.text === "string" ? b.text : "",
        at: e.createdAt,
        msgKind,
        msgKindLabel: msgKind ? CHAT_KIND_LABELS[msgKind] : undefined,
        agentId: str(b.agentId),
        detail: str(b.detail),
        ready: b.ready === true ? true : undefined,
        error: b.error === true ? true : undefined,
        planVersion: typeof b.planVersion === "number" ? b.planVersion : undefined,
        answered: e.authorKind === "user" ? answered.has(e.id) : true,
        fallback: fallback.has(e.id),
      });
    } else if (e.type === "proposal") {
      const status = (b.status as ProposalStatus | undefined) ?? "pending";
      items.push({
        kind: "proposal",
        id: e.id,
        status,
        statusLabel: PROPOSAL_STATUS_LABELS[status] ?? String(status),
        changes: (b.changes as ProposalChanges | undefined) ?? {},
        before: b.before as ProposalChanges | undefined,
        rationale: typeof b.rationale === "string" ? b.rationale : "",
        at: e.createdAt,
      });
    } else {
      const row = systemRow(e);
      if (row) items.push(row);
    }
  }
  return items;
}

export interface FieldDiff {
  field: ProposalField;
  label: string;
  /** Undefined: the old value is unknown and must not be shown. */
  before: string | undefined;
  after: string;
}

/** Changed fields of a proposal; a pending one is compared with the card as it is now. */
export function proposalDiff(
  item: Pick<ProposalItem, "status" | "changes" | "before">,
  card: Pick<CardView, ProposalField>,
): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  for (const { field, label } of PROPOSAL_FIELDS) {
    const after = item.changes[field];
    if (after === undefined) continue;
    diffs.push({
      field,
      label,
      before: item.status === "pending" ? card[field] : item.before?.[field],
      after,
    });
  }
  return diffs;
}

const WORKER_ONLINE = new Set(["starting", "working", "waiting", "idle"]);
const hasOnlineWorker = (sessions: readonly AgentSession[]) =>
  sessions.some((s) => s.role === "worker" && WORKER_ONLINE.has(s.state));

/** Who receives what the owner says now (display only; the server routes). */
export function routeHint(
  card: Pick<CardView, "column">,
  sessions: readonly AgentSession[],
): string {
  switch (card.column) {
    case "draft":
    case "todo":
      return "消息将发给总 agent（规划会话）";
    case "in_progress":
    case "verifying":
      return hasOnlineWorker(sessions)
        ? "消息将发给执行 agent"
        : "执行 agent 已不在，消息将发给总 agent";
    case "done":
      return "卡片已完成，发言只作记录";
    default:
      return "";
  }
}

/** An owner message the master still has to answer. */
export function masterBusy(
  items: readonly ChatItem[],
  card: Pick<CardView, "column">,
  sessions: readonly AgentSession[],
): boolean {
  const forMaster = (m: MessageItem) => {
    switch (card.column) {
      case "draft":
      case "todo":
        return true;
      case "in_progress":
      case "verifying":
        return m.fallback || !hasOnlineWorker(sessions);
      default:
        return false;
    }
  };
  return items.some(
    (i) => i.kind === "message" && i.author === "user" && !i.answered && forMaster(i),
  );
}

/** The newest master message says the plan can be executed and the owner said nothing since. */
export function planReady(items: readonly ChatItem[]): boolean {
  const last = items.findLast(
    (i): i is MessageItem =>
      i.kind === "message" &&
      (i.author === "user" || i.author === "master" || i.author === "agent"),
  );
  return !!last && last.author !== "user" && !!last.ready && !last.error;
}

export interface HeaderAction {
  key: "review" | "dispatch";
  label: string;
}
export function headerActions(card: Pick<CardView, "column">): HeaderAction[] {
  if (card.column === "draft") return [{ key: "review", label: "让总 agent 审查" }];
  if (card.column === "todo") return [{ key: "dispatch", label: "立即执行" }];
  return [];
}

/** The hand-off event that answers a given hand-off request, if the planner wrote it. */
export function handoffAnswering(
  events: readonly CardEvent[],
  requestId: string,
): CardEvent | undefined {
  return events.find(
    (e) =>
      e.type === "note" &&
      (e.authorKind === "agent" || e.authorKind === "master") &&
      bodyOf(e).kind === "handoff" &&
      strings(bodyOf(e).answers).includes(requestId),
  );
}

export function plannerSessionOf(sessions: readonly AgentSession[]): AgentSession | undefined {
  return sessions.filter((s) => s.role === "planner").at(-1);
}

export function sessionStatusLabel(session: AgentSession | undefined): string {
  if (!session) return "尚未开始";
  switch (session.state) {
    case "starting":
    case "working":
      return "规划中…";
    case "idle":
    case "waiting":
      return "等待你的回复";
    case "error":
      return "出错（再发一条消息重试）";
    default:
      return "已归档";
  }
}
