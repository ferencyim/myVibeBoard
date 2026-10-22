// Messages sent to a planning session (WP-105). Order follows a cache-friendly layout:
// system prompt -> per-project block -> memory -> the card -> scouting -> the conversation.

import { defaultPromptPort, type PromptPort } from "../prompts/port";
import type { CardView, PlanSnapshot, Preset } from "../vibe/contract";
import { transcript, type ThreadMessage } from "./thread";

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The card's plan as the planner and the executor read it. */
export function renderPlan(plan: PlanSnapshot | null | undefined, presets: readonly Pick<Preset, "id" | "name">[] = []): string {
  if (!plan || (!plan.description.trim() && !plan.subtasks?.length)) return "（还没有方案）";
  const checks = plan.checks.map((c) => `- ${c.text}${c.method ? `（${c.method}）` : ""}`).join("\n");
  return [
    plan.description,
    checks && `检查项：\n${checks}`,
    plan.files?.length ? `涉及文件：${plan.files.join(", ")}` : "",
    plan.notes ? `备注：${plan.notes}` : "",
    renderSubtasks(plan, presets),
  ]
    .filter(Boolean)
    .join("\n");
}

/** WP-106: the plan's subtasks in the JSON shape the planner writes (so it can revise them). */
export function renderSubtasks(plan: PlanSnapshot, presets: readonly Pick<Preset, "id" | "name">[] = []): string {
  if (!plan.subtasks?.length) return "";
  const list = plan.subtasks.map((s) => ({
    id: s.id,
    title: s.title,
    goal: s.goal,
    method: s.method,
    notes: s.notes,
    acceptance: s.acceptance,
    files: s.files,
    dependsOn: s.dependsOn,
    preset: s.presetId ? (presets.find((p) => p.id === s.presetId)?.name ?? null) : null,
  }));
  const edited = plan.subtasksEdited ? "（负责人改过子任务：你再改时会作为建议交给负责人决定）" : "";
  return `子任务${edited}：\n\`\`\`json\n${JSON.stringify(list, null, 2)}\n\`\`\``;
}

export interface ResearchItem {
  question: string;
  scope?: string;
  answer: string;
  ok: boolean;
}

export function renderResearch(items: readonly ResearchItem[]): string {
  return items
    .map(
      (r, i) =>
        `### ${i + 1}. ${clip(r.question.split("\n")[0] ?? "", 80)}${r.scope ? `（${r.scope}）` : ""}\n${r.ok ? r.answer : `失败：${r.answer}`}`,
    )
    .join("\n\n");
}

export function buildStartMessage(input: {
  projectBlock: string;
  memory: string;
  card: CardView;
  tagNames: string[];
  earlier: ThreadMessage[];
  pending: ThreadMessage[];
  /** Results of the scouting run before planning ("" = none). */
  findings: string;
  /** Presets, to name the model a subtask was given (WP-106). */
  presets?: readonly Pick<Preset, "id" | "name">[];
  prompts?: PromptPort;
}): string {
  const { card } = input;
  return (input.prompts ?? defaultPromptPort()).resolve("master.plan.start", {
    projectId: card.projectId,
    vars: {
      project: input.projectBlock,
      memory: input.memory || "（空）",
      "card.key": card.key,
      "card.title": card.title,
      "card.priority": card.priority,
      "card.tags": input.tagNames.join(", ") || "无",
      "card.description": card.description || "（空）",
      "card.acceptance": card.acceptance || "（空）",
      plan: renderPlan(card.plan, input.presets),
      findings: input.findings ? `## 探路结果\n${input.findings}\n\n` : "",
      discussion: input.earlier.length ? `## 至今的方案对话\n${transcript(input.earlier)}\n\n` : "",
      pending: transcript(input.pending),
    },
  });
}

export function buildTurnMessage(
  pending: ThreadMessage[],
  prompts: PromptPort = defaultPromptPort(),
  projectId?: string | null,
): string {
  return prompts.resolve("master.plan.turn", { projectId, vars: { pending: transcript(pending) } });
}

export function buildResultsMessage(
  items: ResearchItem[],
  prompts: PromptPort = defaultPromptPort(),
  projectId?: string | null,
): string {
  return prompts.resolve("master.plan.research_results", {
    projectId,
    vars: { results: renderResearch(items) },
  });
}

export function buildRepairMessage(
  error: string,
  prompts: PromptPort = defaultPromptPort(),
  projectId?: string | null,
): string {
  return prompts.resolve("master.repair_json", { projectId, vars: { kind: "plan", error } });
}

/** Read-only scout: one question, a short structured answer. */
export function buildScoutMessage(input: {
  card: CardView;
  question: string;
  scope?: string;
  prompts?: PromptPort;
}): string {
  return (input.prompts ?? defaultPromptPort()).resolve("master.plan.scout", {
    projectId: input.card.projectId,
    vars: {
      "card.key": input.card.key,
      "card.title": clip(input.card.title, 80),
      question: input.question,
      scope: input.scope ? `\n查找范围：${input.scope}` : "",
    },
  });
}

/** The question of the scouting run that 制定方案 starts with. */
export function exploreQuestion(card: CardView, prompts: PromptPort = defaultPromptPort()): string {
  return prompts.resolve("master.plan.explore", {
    projectId: card.projectId,
    vars: {
      "card.key": card.key,
      "card.title": card.title,
      "card.description": clip(card.description || "（空）", 3000),
    },
  });
}
