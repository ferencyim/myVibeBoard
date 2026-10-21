// Pure helpers for dispatch: the seed prompt, worktree slug and permission-mode mapping.

import type { CardEvent, CardView, PlanVersion, Preset, Project } from "../vibe/contract";
import { defaultPrompts, type PromptResolver } from "../prompts";

const RECENT_EVENT_LIMIT = 5;
const TITLE_WIDTH = 80;

export function threadTitle(card: Pick<CardView, "key" | "title">): string {
  const raw = `${card.key} · ${card.title}`;
  return raw.length > TITLE_WIDTH ? `${raw.slice(0, TITLE_WIDTH - 1)}…` : raw;
}

/** `<key>-<title>` slug for the worktree branch (ARCHITECTURE 3.6). */
export function worktreeSlug(card: Pick<CardView, "key" | "title">): string {
  const part =
    card.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32)
      .replace(/-+$/g, "") || "card";
  return `${card.key.toLowerCase()}-${part}`;
}

/** Preset permission mode -> provider mode id (undefined: provider default, i.e. accept-edits). */
export function modeIdFor(provider: string, mode: Preset["permissionMode"]): string | undefined {
  const p = provider.toLowerCase();
  if (mode === "full") {
    if (p === "claude") return "bypassPermissions";
    if (p === "codex") return "full-access";
    return "auto";
  }
  return mode === "auto" ? "auto" : undefined;
}

/** `provider/model` as the SDK expects it; tolerates a model id that already carries the prefix. */
export function providerSpec(preset: Pick<Preset, "provider" | "model">): string {
  return preset.model.startsWith(`${preset.provider}/`)
    ? preset.model
    : `${preset.provider}/${preset.model}`;
}

/** A self-contained brief segment: heading, body and the trailing blank line. */
function section(title: string, body: string): string {
  return `## ${title}\n${body.trim() || "无。"}\n\n`;
}

/** Limits of the brief; the defaults equal the board settings defaults. */
export interface BriefLimits {
  recentEvents: number;
  chatLimit: number;
  handoffMaxChars: number;
}
export const DEFAULT_BRIEF_LIMITS: BriefLimits = {
  recentEvents: RECENT_EVENT_LIMIT,
  chatLimit: 8,
  handoffMaxChars: 8000,
};

/** Hand-off summary written by the card's planning session (vibe-master, WP-33). */
export interface PlanHandoff {
  /** Absolute path of `<repo>/.vibe/sessions/<KEY>-plan.md`, when it exists. */
  path: string | null;
  text: string;
}

const DISCUSSION_KINDS = new Set(["discussion", "discussion_research", "handoff", "handoff_request"]);

export interface BriefInput {
  card: CardView;
  project: Project;
  preset: Preset;
  events: readonly CardEvent[];
  latestPlan?: PlanVersion;
  handoff?: PlanHandoff | null;
  extraInstructions?: string;
  /** Prompt registry; default texts when omitted. */
  prompts?: PromptResolver;
  limits?: Partial<BriefLimits>;
}

/** Discussion messages are carried by the hand-off summary, not repeated as notes. */
const isDiscussion = (e: CardEvent) =>
  e.type === "note" && DISCUSSION_KINDS.has(String((e.body as { kind?: unknown } | null)?.kind));

const PROPOSAL_LIMIT = 5;
const CHAT_CLIP = 600;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Recent owner / master messages of the group chat: the agreed context after the hand-off summary. */
function chatLines(events: readonly CardEvent[], limit: number): string {
  if (limit <= 0) return "";
  return events
    .filter((e) => e.type === "chat" && (e.authorKind === "user" || e.authorKind === "master"))
    .slice(-limit)
    .map((e) => {
      const text = (e.body as { text?: unknown } | null)?.text;
      return typeof text === "string" && text.trim()
        ? `- [${e.authorKind === "user" ? "主人" : "主控"}] ${clip(text.trim(), CHAT_CLIP)}`
        : "";
    })
    .filter(Boolean)
    .join("\n");
}

/** Accepted master suggestions: why the card text says what it says now (the changes are already in the card). */
function adoptedLines(events: readonly CardEvent[]): string {
  return events
    .filter((e) => e.type === "proposal" && (e.body as { status?: unknown } | null)?.status === "accepted")
    .slice(-PROPOSAL_LIMIT)
    .map((e) => {
      const b = e.body as { rationale?: unknown; changes?: Record<string, unknown> };
      const fields = Object.keys(b.changes ?? {}).join(", ");
      return `- (${fields}) ${clip(String(b.rationale ?? "").trim(), CHAT_CLIP)}`;
    })
    .join("\n");
}

function eventLine(e: CardEvent): string {
  const body = e.body as { text?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text : "";
  return text ? `- [${e.type}] ${e.author}: ${text}` : "";
}

export function buildDispatchBrief(input: BriefInput): string {
  const { card, project, preset } = input;
  const prompts = input.prompts ?? defaultPrompts;
  const limits = { ...DEFAULT_BRIEF_LIMITS, ...input.limits };
  const notes = input.events
    .filter((e) => e.type === "note" || e.type === "reject" || e.type === "evaluation")
    .filter((e) => !isDiscussion(e))
    .slice(-limits.recentEvents)
    .map(eventLine)
    .filter(Boolean)
    .join("\n");
  const plan = input.latestPlan?.snapshot;
  const adopted = adoptedLines(input.events);
  const chat = chatLines(input.events, limits.chatLimit);
  const contract = prompts.resolve("board.brief_contract", {
    projectId: card.projectId,
    vars: { "card.key": card.key },
  });
  const vars: Record<string, string> = {
    "card.key": card.key,
    "card.title": card.title,
    description: section("描述", card.description || "未提供描述。"),
    acceptance: section("验收标准", card.acceptance),
    referenceImages: section("参考图片", card.refImages.map((id) => `- 附件 ${id}`).join("\n")),
    handoff: input.handoff
      ? section(
          "规划交接（从这里开始）",
          [
            "主人和规划会话已就下面的方案达成一致；请按此执行，有偏差时在卡片评论里说明。" +
              (input.handoff.path ? ` 完整文件：${input.handoff.path}` : ""),
            input.handoff.text.length > limits.handoffMaxChars
              ? `${input.handoff.text.slice(0, limits.handoffMaxChars)}\n…（已截断，见文件）`
              : input.handoff.text,
          ].join("\n\n"),
        )
      : "",
    adopted: adopted ? section("已采纳的建议（已应用到卡片）", adopted) : "",
    chat: chat ? section("群聊（最近）", chat) : "",
    plan: plan
      ? section(
          "计划",
          [plan.description, ...plan.checks.map((c) => `- [ ] ${c.text}`), plan.notes ?? ""]
            .filter(Boolean)
            .join("\n"),
        )
      : "",
    notes: section("最近备注", notes),
    project: section("项目", `- 名称：${project.name}\n- 类型：${project.projectTypes.join(", ")}`),
    contract: section("回报约定", contract),
    runtimeEnv: preset.runtimeEnv ? section("运行环境", preset.runtimeEnv) : "",
    presetInstructions: section("预设指令", preset.instructions),
    extra: input.extraInstructions?.trim() ? section("附加指令", input.extraInstructions) : "",
  };
  return `${prompts.resolve("board.brief", { projectId: card.projectId, vars }).trimEnd()}\n`;
}
