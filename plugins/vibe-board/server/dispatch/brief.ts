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

/** Hand-off summary written by the card's planning session (vibe-master, WP-33). */
export interface PlanHandoff {
  /** Absolute path of `<repo>/.vibe/sessions/<KEY>-plan.md`, when it exists. */
  path: string | null;
  text: string;
}

const HANDOFF_MAX_CHARS = 8000;
const DISCUSSION_KINDS = new Set(["discussion", "discussion_research", "handoff", "handoff_request"]);

export interface BriefInput {
  card: CardView;
  project: Project;
  preset: Preset;
  events: readonly CardEvent[];
  latestPlan?: PlanVersion;
  handoff?: PlanHandoff | null;
  extraInstructions?: string;
}

/** Discussion messages are carried by the hand-off summary, not repeated as notes. */
const isDiscussion = (e: CardEvent) =>
  e.type === "note" && DISCUSSION_KINDS.has(String((e.body as { kind?: unknown } | null)?.kind));

const CHAT_LIMIT = 8;
const PROPOSAL_LIMIT = 5;
const CHAT_CLIP = 600;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Recent owner / master messages of the group chat: the agreed context after the hand-off summary. */
function chatLines(events: readonly CardEvent[]): string {
  return events
    .filter((e) => e.type === "chat" && (e.authorKind === "user" || e.authorKind === "master"))
    .slice(-CHAT_LIMIT)
    .map((e) => {
      const text = (e.body as { text?: unknown } | null)?.text;
      return typeof text === "string" && text.trim()
        ? `- [${e.authorKind === "user" ? "owner" : "master"}] ${clip(text.trim(), CHAT_CLIP)}`
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

/** Pointers only, never content: vibe-context injects the text itself (WP-31). */
const MEMORY_POINTER =
  "Project goals, rules and current state live in `.vibe/` (start with `.vibe/INDEX.md` and " +
  "`.vibe/PROJECT_STATE.md`; owner rules are in `.vibe/instructions/`). These files are " +
  "authoritative and read-only for you: report needed changes in a card comment instead of editing them.";

export function buildDispatchBrief(input: BriefInput): string {
  const { card, project, preset } = input;
  const notes = input.events
    .filter((e) => e.type === "note" || e.type === "reject" || e.type === "evaluation")
    .filter((e) => !isDiscussion(e))
    .slice(-RECENT_EVENT_LIMIT)
    .map(eventLine)
    .filter(Boolean)
    .join("\n");
  const plan = input.latestPlan?.snapshot;
  const sections = [
    `# ${card.key} · ${card.title}`,
    "The title, description and acceptance criteria below are the card as it stands now, including every change the owner accepted. They are authoritative: where the plan or hand-off further down says something different, follow the card.",
    section("Description", card.description || "No description provided."),
    section("Acceptance criteria", card.acceptance),
    section("Reference images", card.refImages.map((id) => `- attachment ${id}`).join("\n")),
    input.handoff
      ? section(
          "Planning hand-off (start here)",
          [
            "The owner and the planning session agreed on the approach below; follow it and report deviations in a card comment." +
              (input.handoff.path ? ` Full file: ${input.handoff.path}` : ""),
            input.handoff.text.length > HANDOFF_MAX_CHARS
              ? `${input.handoff.text.slice(0, HANDOFF_MAX_CHARS)}\n…(truncated, see the file)`
              : input.handoff.text,
          ].join("\n\n"),
        )
      : "",
    adoptedLines(input.events) ? section("Adopted suggestions (already applied to the card)", adoptedLines(input.events)) : "",
    chatLines(input.events) ? section("Group chat (recent)", chatLines(input.events)) : "",
    plan
      ? section(
          "Plan",
          [plan.description, ...plan.checks.map((c) => `- [ ] ${c.text}`), plan.notes ?? ""]
            .filter(Boolean)
            .join("\n"),
        )
      : "",
    section("Recent notes", notes),
    section("Project", `- Name: ${project.name}\n- Type: ${project.projectTypes.join(", ")}`),
    section("Project memory", MEMORY_POINTER),
    section(
      "Report-back contract",
      `You are the worker for card ${card.key}. Read it with \`vibe-board show ${card.key}\` (MCP \`vibe_show\`). ` +
        `Report progress or ask a question with \`vibe-board comment ${card.key} --body "..."\`. ` +
        `Attach result files with \`vibe-board attachment add ${card.key} --file <path>\`. ` +
        `Commit your finished work on the worktree branch before you end the round (the board merges that branch after approval and never touches uncommitted changes). ` +
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
