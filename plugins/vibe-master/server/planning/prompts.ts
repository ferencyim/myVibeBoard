// Messages sent to a planning session. Order follows the master's cache-friendly layout:
// rules (system prompt) -> per-project block -> memory -> the card -> the discussion.

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
}): string {
  const { card } = input;
  return [
    "[plan:start]",
    `You are the planning session of card ${card.key}. Discuss the plan with the owner until it is executable.`,
    input.projectBlock,
    "",
    "## Project memory (read-only)",
    input.memory || "(empty)",
    "",
    `## Card ${card.key}`,
    `Title: ${card.title}`,
    `Priority: ${card.priority}`,
    `Tags: ${input.tagNames.join(", ") || "none"}`,
    `Description:\n${card.description || "(empty)"}`,
    `Acceptance criteria:\n${card.acceptance || "(empty)"}`,
    "",
    "## Latest plan version",
    input.plan,
    "",
    input.earlier.length ? `## Discussion so far\n${transcript(input.earlier)}\n` : "",
    "## Owner message(s) to answer now",
    transcript(input.pending),
    "",
    "Reply with the plan_discussion JSON object only.",
  ].join("\n");
}

export function buildTurnMessage(pending: ThreadMessage[]): string {
  return [
    "[plan:turn]",
    transcript(pending),
    "",
    "Reply with the plan_discussion JSON object only.",
  ].join("\n");
}

export interface ResearchItem {
  question: string;
  scope?: string;
  answer: string;
  ok: boolean;
}

export function buildResultsMessage(items: ResearchItem[]): string {
  return [
    "[plan:research_results]",
    ...items.map(
      (r, i) =>
        `### ${i + 1}. ${r.question}${r.scope ? ` (${r.scope})` : ""}\n${r.ok ? r.answer : `FAILED: ${r.answer}`}`,
    ),
    "",
    "Continue the discussion with the plan_discussion JSON object only (no further research unless it is essential).",
  ].join("\n\n");
}

export function buildHandoffMessage(): string {
  return [
    "[plan:handoff]",
    "The owner is moving this card to todo. Write the hand-off summary for the executing agent.",
    'Reply with `{ "summary": "<markdown>" }` only, in a ```json fence.',
  ].join("\n");
}

export function buildRepairMessage(error: string): string {
  return `Your reply was rejected: ${error}\nReply again with only the corrected plan_discussion JSON object in a \`\`\`json fence.`;
}

/** Read-only scout: one question, a short structured answer. */
export function buildScoutMessage(input: { card: CardView; question: string; scope?: string }): string {
  return [
    `You are a read-only scout for card ${input.card.key} (${clip(input.card.title, 80)}).`,
    "Answer the question below by reading code, logs or documents in this repository.",
    "Do NOT modify, create or delete any file, do not run builds or install anything, do not use git commands that write.",
    "Answer in at most 20 lines: findings with file paths, then the effort/risks if the question asks for an estimate.",
    "",
    `Question: ${input.question}`,
    input.scope ? `Where to look: ${input.scope}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Deterministic hand-off when the planner cannot write one. */
export function fallbackHandoff(input: {
  card: CardView;
  plan: string;
  messages: ThreadMessage[];
}): string {
  const lastPlanner = input.messages.filter((m) => m.role === "planner").at(-1)?.text;
  return [
    `# Hand-off: ${input.card.key} ${input.card.title}`,
    "",
    "## Goal",
    input.card.description || input.card.title,
    "",
    "## Agreed plan (latest plan version)",
    input.plan,
    lastPlanner ? `\n## Last word of the planning discussion\n${clip(lastPlanner, 1500)}` : "",
  ].join("\n");
}
