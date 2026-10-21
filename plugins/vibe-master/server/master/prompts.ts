// Prompt assembly. Three segments, ordered for prefix-cache hits:
//   static       MASTER_RULES (system prompt; identical for every wake)
//   semi-static  per-project block (project, tag vocabulary, presets, open cards): deterministic
//                order, no timestamps or counters, so wakes for the same project share a prefix
//   dynamic      the card itself, quota numbers, the scheduler hint, the reply contract reminder

import { readRequirementsDoc } from "../vibe/db";
import { defaultPromptPort, type PromptPort } from "../prompts/port";
import type { CardEvent, CardView, Preset, Project, Tag } from "../vibe/contract";
import type { SelectResult } from "../select";
import type { QuotaMap } from "../subscription/quota";

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const COLUMN_ORDER = ["draft", "todo", "in_progress", "verifying", "done"] as const;

export interface ProjectBlockInput {
  project: Project;
  tags: Tag[];
  presets: Preset[];
  /** Other open (not done, not archived) cards of the project. */
  openCards: CardView[];
  /** Max characters of the requirements document to include (0 = none). Default 6000. */
  requirementsChars?: number;
  /** Max other open cards listed. Default 40. */
  cardLimit?: number;
}

export const DEFAULT_REQUIREMENTS_CHARS = 6000;

/** The requirements document as an excerpt block; `truncated` tells the master it must not rewrite it. */
export function requirementsExcerpt(
  project: Pick<Project, "repoPath" | "requirementsPath">,
  maxChars: number,
): { text: string; truncated: boolean } | null {
  if (maxChars <= 0 || !project.repoPath) return null;
  try {
    const doc = readRequirementsDoc(project.repoPath, project.requirementsPath);
    if (!doc.exists || !doc.content.trim()) return null;
    const content = doc.content.replace(/\r\n/g, "\n").trim();
    const truncated = content.length > maxChars;
    const body = truncated
      ? `${content.slice(0, maxChars)}\n[…… 已截断：还有 ${content.length - maxChars} 个字符，完整文件见 ${doc.path}]`
      : content;
    return {
      text: `需求文档（${doc.path}${truncated ? "，TRUNCATED" : "，完整"}）：\n${body}`,
      truncated,
    };
  } catch {
    return null;
  }
}

export function buildProjectBlock(input: ProjectBlockInput): string {
  const { project } = input;
  const presets = [...input.presets]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(
      (p) =>
        `- ${p.name}: ${p.provider}/${p.model}${p.thinking && p.thinking !== "default" ? ` 思考档=${p.thinking}` : ""}${p.runtimeEnv ? ` env=${p.runtimeEnv}` : ""}${p.roleHints.length ? ` role=${p.roleHints.join("+")}` : ""}`,
    );
  const cards = [...input.openCards]
    .sort(
      (a, b) =>
        COLUMN_ORDER.indexOf(a.column) - COLUMN_ORDER.indexOf(b.column) || a.number - b.number,
    )
    .slice(0, input.cardLimit ?? 40)
    .map((c) => `- ${c.key} [${c.column}] ${clip(c.title, 80)} :: ${clip(c.description, 100)}`);
  const excerpt = requirementsExcerpt(project, input.requirementsChars ?? DEFAULT_REQUIREMENTS_CHARS);
  return [
    `## 项目 ${project.prefix}（${project.name}，类型 ${project.projectTypes.join("+")}）`,
    ...(project.description.trim() ? [`简介：${project.description.trim()}`] : []),
    ...(excerpt ? [excerpt.text] : []),
    `标签词表：${[...input.tags].map((t) => t.name).sort().join(", ")}`,
    `执行预设（recommendation.preset 请使用这些名称）：\n${presets.join("\n") || "- 未配置"}`,
    `其它未完成卡片：\n${cards.join("\n") || "- 无"}`,
  ].join("\n");
}

export function quotaLine(quota: QuotaMap): string {
  const parts = Object.entries(quota)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, q]) => `${id} ${q.remainingPct === null ? "?" : `${q.remainingPct}%`} 剩余（${q.level}）`);
  return parts.length ? parts.join("; ") : "未知";
}

export function buildAssessMessage(input: {
  projectBlock: string;
  card: CardView;
  tagNames: string[];
  quota: QuotaMap;
  hint: SelectResult | null;
  prompts?: PromptPort;
}): string {
  const { card } = input;
  return (input.prompts ?? defaultPromptPort()).resolve("master.wake.assess_draft", {
    projectId: card.projectId,
    vars: {
    project: input.projectBlock,
    "card.key": card.key,
    "card.title": card.title,
    "card.priority": card.priority,
    "card.tags": input.tagNames.join(", ") || "无",
    "card.preset": card.presetId ?? "无",
    "card.refImages": String(card.refImages.length),
    "card.description": card.description || "（空）",
    "card.acceptance": card.acceptance || "（空）",
    quota: quotaLine(input.quota),
    hint: input.hint ? `${input.hint.presetName ?? input.hint.provider ?? "无"}（${input.hint.reason}）` : "无",
    },
  });
}

export function buildRepairMessage(
  kind: string,
  error: string,
  prompts: PromptPort = defaultPromptPort(),
  projectId?: string | null,
): string {
  return prompts.resolve("master.repair_json", { projectId, vars: { kind, error } });
}

function eventText(e: CardEvent): string {
  const body = e.body as { text?: unknown } | null;
  return typeof body?.text === "string" ? clip(body.text, 300) : "";
}

export function buildDoneMessage(input: {
  projectBlock: string;
  card: CardView;
  events: CardEvent[];
  verification: string;
  memory: string;
  prompts?: PromptPort;
}): string {
  const notes = input.events
    .filter((e) => e.type === "note" || e.type === "reject" || e.type === "evaluation")
    .slice(-8)
    .map((e) => `- [${e.type}] ${e.author}: ${eventText(e)}`)
    .join("\n");
  return (input.prompts ?? defaultPromptPort()).resolve("master.wake.card_done", {
    projectId: input.card.projectId,
    vars: {
      project: input.projectBlock,
      memory: input.memory || "（空）",
      "card.key": input.card.key,
      "card.title": input.card.title,
      "card.description": clip(input.card.description, 1500),
      "card.acceptance": clip(input.card.acceptance, 800),
      notes: notes || "（无）",
      verification: input.verification || "（无记录）",
    },
  });
}

export function buildHelpMessage(input: {
  projectBlock: string;
  card: CardView;
  question: unknown;
  plan: string;
  prompts?: PromptPort;
}): string {
  return (input.prompts ?? defaultPromptPort()).resolve("master.wake.session_help", {
    projectId: input.card.projectId,
    vars: {
      project: input.projectBlock,
      "card.key": input.card.key,
      "card.title": input.card.title,
      "card.acceptance": clip(input.card.acceptance, 800),
      plan: input.plan || "（无）",
      question: JSON.stringify(input.question ?? null, null, 2).slice(0, 2000),
    },
  });
}
