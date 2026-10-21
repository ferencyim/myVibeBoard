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
      ? `${content.slice(0, maxChars)}\n[... truncated: ${content.length - maxChars} more characters, complete file is ${doc.path}]`
      : content;
    return {
      text: `Requirements document (${doc.path}${truncated ? ", TRUNCATED" : ", complete"}):\n${body}`,
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
        `- ${p.name}: ${p.provider}/${p.model}${p.thinking && p.thinking !== "default" ? ` thinking=${p.thinking}` : ""}${p.runtimeEnv ? ` env=${p.runtimeEnv}` : ""}${p.roleHints.length ? ` role=${p.roleHints.join("+")}` : ""}`,
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
    `## Project ${project.prefix} (${project.name}, type ${project.projectTypes.join("+")})`,
    ...(project.description.trim() ? [`Description: ${project.description.trim()}`] : []),
    ...(excerpt ? [excerpt.text] : []),
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
    "card.tags": input.tagNames.join(", ") || "none",
    "card.preset": card.presetId ?? "none",
    "card.refImages": String(card.refImages.length),
    "card.description": card.description || "(empty)",
    "card.acceptance": card.acceptance || "(empty)",
    quota: quotaLine(input.quota),
    hint: input.hint ? `${input.hint.presetName ?? input.hint.provider ?? "none"} (${input.hint.reason})` : "none",
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
      memory: input.memory || "(empty)",
      "card.key": input.card.key,
      "card.title": input.card.title,
      "card.description": clip(input.card.description, 1500),
      "card.acceptance": clip(input.card.acceptance, 800),
      notes: notes || "(none)",
      verification: input.verification || "(none recorded)",
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
      plan: input.plan || "(none)",
      question: JSON.stringify(input.question ?? null, null, 2).slice(0, 2000),
    },
  });
}
