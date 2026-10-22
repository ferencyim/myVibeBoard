// Pure helpers of the card conversations (WP-92, split by WP-105 into the plan conversation and the
// execution conversation). Each is made of `chat` events of its thread, the planner's `proposal`
// events (plan) and a whitelist of status / reject events shown as small system rows (execution).
// Tool calls and other details stay in the full agent session and the timeline tab.

import {
  chatThreadOf,
  type AgentSession,
  type AuthorKind,
  type CardEvent,
  type CardView,
  type ChatKind,
  type ChatThread,
  type Preset,
  type ProposalChanges,
  type ProposalStatus,
  type RoleHint,
} from "../../shared/vibe/contract";
import { COLUMN_LABELS } from "../board/logic";
import { subtasksText } from "./subtask-logic";

export const AUTHOR_LABELS: Record<AuthorKind, string> = {
  user: "你",
  master: "规划模型",
  agent: "总 agent",
  executor: "主代理",
  reviewer: "复核模型",
  scout: "探路模型",
  system: "系统",
};

const CHAT_KIND_LABELS: Record<ChatKind, string> = {
  question: "提问",
  summary: "小结",
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

/** Author label of a chat line; a sub-agent's lines carry their subtask (WP-106). */
export function authorLabel(author: AuthorKind, subtask?: string): string {
  if (author === "executor" && subtask) return `子代理 ${subtask}`;
  return AUTHOR_LABELS[author] ?? author;
}

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
  error?: boolean;
  /** WP-106: the sub-agent's subtask (its lines), or the subtask an owner message was sent to. */
  subtask?: string;
  /** User messages only: some chat message answers it. */
  answered: boolean;
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
  /** WP-106: the line is about this sub-agent; `agentId` opens its full session. */
  subtask?: string;
  agentId?: string;
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
  [key: string]: unknown;
}

const bodyOf = (e: CardEvent): Body =>
  e.body && typeof e.body === "object" && !Array.isArray(e.body) ? (e.body as Body) : {};

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

const SYSTEM_STATUS_KINDS = new Set(["failover", "failover_failed", "dispatch_failed", "worker_unreachable", "finalized"]);
const col = (v: unknown) => COLUMN_LABELS[v as keyof typeof COLUMN_LABELS] ?? String(v);

/** Status lines worth a row in the execution conversation. */
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

/** One conversation of the card in time order. */
export function chatItemsOf(events: readonly CardEvent[], thread: ChatThread): ChatItem[] {
  const answered = new Set<string>();
  for (const e of events) {
    if (e.type === "chat") for (const id of strings(bodyOf(e).answers)) answered.add(id);
  }
  const items: ChatItem[] = [];
  for (const e of events) {
    const b = bodyOf(e);
    if (e.type === "chat") {
      if (chatThreadOf(e) !== thread) continue;
      const subtask = str(b.subtask);
      if (e.authorKind === "system") {
        items.push({
          kind: "system",
          id: e.id,
          text: typeof b.text === "string" ? b.text : "",
          at: e.createdAt,
          ...(subtask ? { subtask } : {}),
          ...(subtask && str(b.agentId) ? { agentId: str(b.agentId) } : {}),
        });
        continue;
      }
      const msgKind = b.kind as ChatKind | undefined;
      items.push({
        kind: "message",
        id: e.id,
        author: e.authorKind,
        label: e.authorKind === "user" && subtask ? `你 → 子代理 ${subtask}` : authorLabel(e.authorKind, subtask),
        subtask,
        text: typeof b.text === "string" ? b.text : "",
        at: e.createdAt,
        msgKind,
        msgKindLabel: msgKind ? CHAT_KIND_LABELS[msgKind] : undefined,
        agentId: str(b.agentId),
        detail: str(b.detail),
        error: b.error === true ? true : undefined,
        answered: e.authorKind === "user" ? answered.has(e.id) : true,
      });
    } else if (e.type === "proposal") {
      if (thread !== "plan") continue;
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
    } else if (thread === "exec") {
      const row = systemRow(e);
      if (row) items.push(row);
    }
  }
  return items;
}

/** The reviewer's conclusions (newest last), shown on the verification tab too. */
export function reviewItemsOf(events: readonly CardEvent[]): MessageItem[] {
  return chatItemsOf(events, "exec").filter(
    (i): i is MessageItem => i.kind === "message" && i.author === "reviewer",
  );
}

export interface FieldDiff {
  field: ProposalField | "subtasks";
  label: string;
  /** Undefined: the old value is unknown and must not be shown. */
  before: string | undefined;
  after: string;
}

/** Changed fields of a proposal; a pending one is compared with the card as it is now. */
export function proposalDiff(
  item: Pick<ProposalItem, "status" | "changes" | "before">,
  card: Pick<CardView, ProposalField | "plan">,
  presets: readonly Preset[] = [],
): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  // WP-106: the planning model's subtasks after the owner edited them.
  if (item.changes.subtasks !== undefined) {
    const before = item.status === "pending" ? card.plan?.subtasks : item.before?.subtasks;
    diffs.push({
      field: "subtasks",
      label: "子任务",
      before: before === undefined && item.status !== "pending" ? undefined : subtasksText(before, presets),
      after: subtasksText(item.changes.subtasks, presets),
    });
  }
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

/** An owner message the other side has not answered yet: show "thinking". */
export function waitingForReply(items: readonly ChatItem[]): boolean {
  return items.some((i) => i.kind === "message" && i.author === "user" && !i.answered);
}

/** Presets offered for a job: those whose purposes include it, or that have no purpose set. */
export function presetsFor(presets: readonly Preset[], role: RoleHint): Preset[] {
  return presets.filter((p) => p.roleHints.length === 0 || p.roleHints.includes(role));
}

const RUNNING = new Set(["starting", "working", "waiting", "idle"]);

/** The worker session executing the card now, if any. */
export function runningWorkerOf(sessions: readonly AgentSession[]): AgentSession | undefined {
  return sessions.filter((s) => s.role === "worker" && RUNNING.has(s.state)).at(-1);
}

export function plannerSessionOf(sessions: readonly AgentSession[]): AgentSession | undefined {
  return sessions.filter((s) => s.role === "planner").at(-1);
}

export function plannerStatusLabel(session: AgentSession | undefined): string {
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
      return "已结束";
  }
}

/** A message for the execution conversation goes to the main agent (null) or one sub-agent. */
export interface ChatTarget {
  subtask: string | null;
  label: string;
}

/** Who the owner can talk to in the execution conversation: the main agent, and every subtask that has a sub-agent. */
export function chatTargets(card: Pick<CardView, "plan" | "subtaskRuns">): ChatTarget[] {
  const subs = (card.plan?.subtasks ?? []).filter((s) => card.subtaskRuns[s.id]?.sessionId);
  return [{ subtask: null, label: "主代理" }, ...subs.map((s) => ({ subtask: s.id, label: `子代理 ${s.id} · ${s.title}` }))];
}

const WORKER_STATE_LABELS: Record<string, string> = {
  starting: "启动中",
  working: "执行中",
  waiting: "等待你的回复",
  idle: "本轮已结束",
};

/** "正在执行：<preset> · <provider> · <state>", or null when no worker runs. */
export function executingLabel(sessions: readonly AgentSession[], presets: readonly Preset[], card: Pick<CardView, "presetId">) {
  const worker = runningWorkerOf(sessions);
  if (!worker) return null;
  const preset = presets.find((p) => p.id === card.presetId);
  const model = preset && preset.provider === worker.currentProvider ? `${preset.name}（${preset.provider}/${preset.model}）` : worker.currentProvider;
  return `${model} · ${WORKER_STATE_LABELS[worker.state] ?? worker.state}`;
}

/** Can 立即执行 start the card now? */
export function canExecute(card: Pick<CardView, "column">): boolean {
  return card.column === "draft" || card.column === "todo";
}
