// Messages sent to a planning session. Order follows the master's cache-friendly layout:
// rules (system prompt) -> per-project block -> memory -> the card -> the discussion.

import { defaultPromptPort, type PromptPort } from "../prompts/port";
import type { CardView, PlanSnapshot } from "../vibe/contract";
import { transcript, type ThreadMessage } from "./thread";

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function renderPlan(plan: PlanSnapshot | undefined, presetName: (id: string) => string | null): string {
  if (!plan) return "（还没有计划）";
  const checks = plan.checks.map((c) => `- ${c.text}${c.method ? ` (${c.method})` : ""}`).join("\n");
  const subCards = plan.subCards.map((s) => `- ${s.title}`).join("\n");
  const preset = plan.recommendedPresetId ? presetName(plan.recommendedPresetId) : null;
  return [
    plan.description,
    checks && `检查项：\n${checks}`,
    subCards && `子卡片：\n${subCards}`,
    plan.tags.length ? `标签：${plan.tags.join(", ")}` : "",
    preset ? `推荐预设：${preset}` : "",
    plan.notes ? `备注：${plan.notes}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildStartMessage(input: {
  projectBlock: string;
  memory: string;
  card: CardView;
  tagNames: string[];
  plan: string;
  earlier: ThreadMessage[];
  pending: ThreadMessage[];
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
      plan: input.plan,
      discussion: input.earlier.length ? `## 至今的讨论\n${transcript(input.earlier)}\n\n` : "",
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

export interface ResearchItem {
  question: string;
  scope?: string;
  answer: string;
  ok: boolean;
}

export function buildResultsMessage(
  items: ResearchItem[],
  prompts: PromptPort = defaultPromptPort(),
  projectId?: string | null,
): string {
  const results = items
    .map(
      (r, i) =>
        `### ${i + 1}. ${r.question}${r.scope ? ` (${r.scope})` : ""}\n${r.ok ? r.answer : `失败：${r.answer}`}`,
    )
    .join("\n\n");
  return prompts.resolve("master.plan.research_results", { projectId, vars: { results } });
}

export function buildHandoffMessage(
  prompts: PromptPort = defaultPromptPort(),
  projectId?: string | null,
): string {
  return prompts.resolve("master.plan.handoff", { projectId });
}

export function buildRepairMessage(
  error: string,
  prompts: PromptPort = defaultPromptPort(),
  projectId?: string | null,
): string {
  return prompts.resolve("master.repair_json", { projectId, vars: { kind: "plan_discussion", error } });
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

/** Deterministic hand-off when the planner cannot write one. */
export function fallbackHandoff(input: {
  card: CardView;
  plan: string;
  messages: ThreadMessage[];
  prompts?: PromptPort;
}): string {
  const lastPlanner = input.messages.filter((m) => m.role === "planner").at(-1)?.text;
  return (input.prompts ?? defaultPromptPort()).resolve("master.plan.fallback_handoff", {
    projectId: input.card.projectId,
    vars: {
      "card.key": input.card.key,
      "card.title": input.card.title,
      goal: input.card.description || input.card.title,
      plan: input.plan,
      lastWord: lastPlanner ? `\n\n## 规划讨论的最后一条回复\n${clip(lastPlanner, 1500)}` : "",
    },
  });
}
