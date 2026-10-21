// Messages sent to a planning session. Order follows the master's cache-friendly layout:
// rules (system prompt) -> per-project block -> memory -> the card -> the discussion.

import { defaultPromptPort, type PromptPort } from "../prompts/port";
import type { CardView, PlanSnapshot } from "../vibe/contract";
import { transcript, type ThreadMessage } from "./thread";

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function renderPlan(plan: PlanSnapshot | undefined, presetName: (id: string) => string | null): string {
  if (!plan) return "(no plan yet)";
  const checks = plan.checks.map((c) => `- ${c.text}${c.method ? ` (${c.method})` : ""}`).join("\n");
  const subCards = plan.subCards.map((s) => `- ${s.title}`).join("\n");
  const preset = plan.recommendedPresetId ? presetName(plan.recommendedPresetId) : null;
  return [
    plan.description,
    checks && `Checks:\n${checks}`,
    subCards && `Sub-cards:\n${subCards}`,
    plan.tags.length ? `Tags: ${plan.tags.join(", ")}` : "",
    preset ? `Recommended preset: ${preset}` : "",
    plan.notes ? `Notes: ${plan.notes}` : "",
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
      memory: input.memory || "(empty)",
      "card.key": card.key,
      "card.title": card.title,
      "card.priority": card.priority,
      "card.tags": input.tagNames.join(", ") || "none",
      "card.description": card.description || "(empty)",
      "card.acceptance": card.acceptance || "(empty)",
      plan: input.plan,
      discussion: input.earlier.length ? `## Discussion so far\n${transcript(input.earlier)}\n\n` : "",
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
        `### ${i + 1}. ${r.question}${r.scope ? ` (${r.scope})` : ""}\n${r.ok ? r.answer : `FAILED: ${r.answer}`}`,
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
      scope: input.scope ? `\nWhere to look: ${input.scope}` : "",
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
      lastWord: lastPlanner ? `\n\n## Last word of the planning discussion\n${clip(lastPlanner, 1500)}` : "",
    },
  });
}
