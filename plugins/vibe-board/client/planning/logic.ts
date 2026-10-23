// Pure helpers of the card conversations (WP-92, split by WP-105 into the plan conversation and the
// execution conversation). Each is made of `chat` events of its thread, the planner's `proposal`
// events (plan) and a whitelist of status / reject events shown as small system rows (execution).
// Tool calls and other details stay in the full agent session and the timeline tab.

import {
  chatThreadOf,
  resolveModel,
  type AgentSession,
  type AuthorKind,
  type CardEvent,
  type CardView,
  type ChatKind,
  type ChatThread,
  type ModelDefaults,
  type ModelRole,
  type Preset,
  type Project,
  type ProposalChanges,
  type ProposalStatus,
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

/** Author label of a chat line; a sub-agent's lines carry their subtask (WP-106); in the plan
 *  conversation the reviewer is the plan reviewer (WP-108). */
export function authorLabel(author: AuthorKind, subtask?: string, thread?: ChatThread): string {
  if (author === "executor" && subtask) return `子代理 ${subtask}`;
  if (author === "reviewer" && thread === "plan") return "方案复核";
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
        label: e.authorKind === "user" && subtask ? `你 → 子代理 ${subtask}` : authorLabel(e.authorKind, subtask, thread),
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
    } else if (thread === "review" && e.type === "reject" && b.reviewReturn === true) {
      // WP-108: the returns a review caused belong to the review history too.
      const row = systemRow(e);
      if (row) items.push(row);
    }
  }
  return items;
}

/** The reviewer's conclusions (newest last). */
export function reviewItemsOf(events: readonly CardEvent[]): MessageItem[] {
  return chatItemsOf(events, "review").filter(
    (i): i is MessageItem => i.kind === "message" && i.author === "reviewer",
  );
}

// --- model jobs (WP-108) ---------------------------------------------------------------------

export const MODEL_ROLE_LABELS: Record<ModelRole, string> = {
  scout: "探路",
  planner: "规划方案",
  plan_reviewer: "方案复核",
  worker: "执行主代理",
  subagent: "执行子代理",
  reviewer: "复核",
  verifier: "验证",
};

/** Where the defaults of a card come from: its project and the global settings. */
export interface ModelScope {
  project: Pick<Project, "defaultPresets"> | null | undefined;
  global: ModelDefaults;
  presets: readonly Preset[];
}

const existsIn = (presets: readonly Preset[]) => (id: string) => presets.some((p) => p.id === id);

/** The preset a job of this card runs with (card -> project -> global), or null. */
export function resolvedPreset(role: ModelRole, card: CardView | null, scope: ModelScope): Preset | null {
  const { presetId } = resolveModel(role, card, scope.project, scope.global, existsIn(scope.presets));
  return scope.presets.find((p) => p.id === presetId) ?? null;
}

/** "名称（项目默认）" of the default a job falls back to when the card has no pick; null = none. */
export function defaultChoice(role: ModelRole, scope: ModelScope, ownerLevel: "card" | "project" = "card"): string | null {
  const project = ownerLevel === "card" ? scope.project : null;
  const { presetId, source } = resolveModel(role, null, project, scope.global, existsIn(scope.presets));
  const name = scope.presets.find((p) => p.id === presetId)?.name;
  if (!name) return null;
  return `${name}（${source === "project" ? "项目默认" : "全局默认"}）`;
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

/** 立即执行 needs a verification model (every card is verified, WP-108). */
export function missingVerifier(card: CardView, scope: ModelScope): boolean {
  return resolvedPreset("verifier", card, scope) === null;
}

/** Can 立即执行 start the card now? */
export function canExecute(card: Pick<CardView, "column">): boolean {
  return card.column === "draft" || card.column === "todo";
}
