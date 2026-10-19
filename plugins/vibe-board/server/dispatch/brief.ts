// Pure helpers for dispatch: the seed prompt, worktree slug and permission-mode mapping.

import type { CardEvent, CardView, PlanVersion, Preset, Project } from "../vibe/contract";

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

function section(title: string, body: string): string {
  return `## ${title}\n${body.trim() || "None."}`;
}

export interface BriefInput {
  card: CardView;
  project: Project;
  preset: Preset;
  events: readonly CardEvent[];
  latestPlan?: PlanVersion;
  extraInstructions?: string;
}

function eventLine(e: CardEvent): string {
  const body = e.body as { text?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text : "";
  return text ? `- [${e.type}] ${e.author}: ${text}` : "";
}

export function buildDispatchBrief(input: BriefInput): string {
  const { card, project, preset } = input;
  const notes = input.events
    .filter((e) => e.type === "note" || e.type === "reject" || e.type === "evaluation")
    .slice(-RECENT_EVENT_LIMIT)
    .map(eventLine)
    .filter(Boolean)
    .join("\n");
  const plan = input.latestPlan?.snapshot;
  const sections = [
    `# ${card.key} · ${card.title}`,
    section("Description", card.description || "No description provided."),
    section("Acceptance criteria", card.acceptance),
    section("Reference images", card.refImages.map((id) => `- attachment ${id}`).join("\n")),
    plan
      ? section(
          "Plan",
          [plan.description, ...plan.checks.map((c) => `- [ ] ${c.text}`), plan.notes ?? ""]
            .filter(Boolean)
            .join("\n"),
        )
      : "",
    section("Recent notes", notes),
    section("Project", `- Name: ${project.name}\n- Type: ${project.projectType}`),
    section(
      "Report-back contract",
      `You are the worker for card ${card.key}. Read it with \`vibe-board show ${card.key}\` (MCP \`vibe_show\`). ` +
        `Report progress or ask a question with \`vibe-board comment ${card.key} --body "..."\`. ` +
        `Attach result files with \`vibe-board attachment add ${card.key} --file <path>\`. ` +
        `You cannot move the card: when your round ends with no open question, the board moves it to verifying.`,
    ),
    preset.runtimeEnv ? section("Runtime environment", preset.runtimeEnv) : "",
    section("Preset instructions", preset.instructions),
    input.extraInstructions?.trim()
      ? section("Additional instructions", input.extraInstructions)
      : "",
  ].filter(Boolean);
  return `${sections.join("\n\n")}\n`;
}
