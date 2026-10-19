// Prompt assembly. Three segments, ordered for prefix-cache hits:
//   static       MASTER_RULES (system prompt; identical for every wake)
//   semi-static  per-project block (project, tag vocabulary, presets, open cards): deterministic
//                order, no timestamps or counters, so wakes for the same project share a prefix
//   dynamic      the card itself, quota numbers, the scheduler hint, the reply contract reminder

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
}

export function buildProjectBlock(input: ProjectBlockInput): string {
  const { project } = input;
  const presets = [...input.presets]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(
      (p) =>
        `- ${p.name}: ${p.provider}/${p.model}${p.thinking && p.thinking !== "default" ? ` thinking=${p.thinking}` : ""}${p.runtimeEnv ? ` env=${p.runtimeEnv}` : ""}`,
    );
  const cards = [...input.openCards]
    .sort(
      (a, b) =>
        COLUMN_ORDER.indexOf(a.column) - COLUMN_ORDER.indexOf(b.column) || a.number - b.number,
    )
    .slice(0, 40)
    .map((c) => `- ${c.key} [${c.column}] ${clip(c.title, 80)} :: ${clip(c.description, 100)}`);
  return [
    `## Project ${project.prefix} (${project.name}, type ${project.projectType})`,
    `Tag vocabulary: ${[...input.tags].map((t) => t.name).sort().join(", ")}`,
    `Execution presets (use these names in recommendation.preset):\n${presets.join("\n") || "- none configured"}`,
    `Other open cards:\n${cards.join("\n") || "- none"}`,
  ].join("\n");
}

export function quotaLine(quota: QuotaMap): string {
  const parts = Object.entries(quota)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, q]) => `${id} ${q.remainingPct === null ? "?" : `${q.remainingPct}%`} left (${q.level})`);
  return parts.length ? parts.join("; ") : "unknown";
}

export function buildAssessMessage(input: {
  projectBlock: string;
  card: CardView;
  tagNames: string[];
  quota: QuotaMap;
  hint: SelectResult | null;
}): string {
  const { card } = input;
  return [
    "[wake:assess_draft]",
    input.projectBlock,
    "",
    "## Card to assess (dynamic)",
    `Key: ${card.key}`,
    `Title: ${card.title}`,
    `Priority: ${card.priority}`,
    `Tags: ${input.tagNames.join(", ") || "none"}`,
    `Preselected preset: ${card.presetId ?? "none"}`,
    `Reference images: ${card.refImages.length}`,
    `Description:\n${card.description || "(empty)"}`,
    `Acceptance criteria:\n${card.acceptance || "(empty)"}`,
    "",
    `Provider quota: ${quotaLine(input.quota)}`,
    input.hint
      ? `Scheduler hint: ${input.hint.presetName ?? input.hint.provider ?? "none"} (${input.hint.reason})`
      : "Scheduler hint: none",
    "",
    "Reply with the assess_draft JSON object only.",
  ].join("\n");
}

export function buildRepairMessage(kind: string, error: string): string {
  return `Your reply was rejected: ${error}\nReply again with only the corrected ${kind} JSON object in a \`\`\`json fence.`;
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
}): string {
  const notes = input.events
    .filter((e) => e.type === "note" || e.type === "reject" || e.type === "evaluation")
    .slice(-8)
    .map((e) => `- [${e.type}] ${e.author}: ${eventText(e)}`)
    .join("\n");
  return [
    "[wake:card_done]",
    input.projectBlock,
    "",
    "## Current project memory (entry ids in brackets)",
    input.memory || "(empty)",
    "",
    "## Finished card (dynamic)",
    `Key: ${input.card.key}`,
    `Title: ${input.card.title}`,
    `Description:\n${clip(input.card.description, 1500)}`,
    `Acceptance criteria:\n${clip(input.card.acceptance, 800)}`,
    `Recent notes:\n${notes || "(none)"}`,
    `Verification:\n${input.verification || "(none recorded)"}`,
    "",
    "Reply with the card_done JSON object only.",
  ].join("\n");
}

export function buildHelpMessage(input: {
  projectBlock: string;
  card: CardView;
  question: unknown;
  plan: string;
}): string {
  return [
    "[wake:session_help]",
    input.projectBlock,
    "",
    "## Worker question (dynamic)",
    `Card: ${input.card.key} ${input.card.title}`,
    `Acceptance criteria:\n${clip(input.card.acceptance, 800)}`,
    `Plan:\n${input.plan || "(none)"}`,
    `Question:\n${JSON.stringify(input.question ?? null, null, 2).slice(0, 2000)}`,
    "",
    "Reply with the session_help JSON object only.",
  ].join("\n");
}
