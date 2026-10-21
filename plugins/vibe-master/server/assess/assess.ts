// Draft assessment: wake message -> master reply -> zod validation (one repair retry) ->
// board write-back. The write-back is the only thing the master changes on a card:
//   - an `evaluation` card event (the structured JSON plus a readable summary) -> card.assessed
//   - a plan version whose `checks` vibe-verify turns into the verification checklist
//   - card.suggested_preset_id (the recommended execution preset)
//   - a `chat` message (kind verdict) in the card group chat, plus a `proposal` event when the master
//     suggests new title / description / acceptance text
// It never moves a card and never touches the owner's fields (title, description, tags, ...): the
// owner accepts a proposal in the chat.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseWorkerHistory, type CardEvent, type CardView, type Preset, type Project } from "../vibe/contract";
import type { VibeDb, VibeStore } from "../vibe/db";
import { buildAssessMessage, buildProjectBlock, buildRepairMessage } from "../master/prompts";
import { defaultPromptPort, type PromptPort } from "../prompts/port";
import { defaultSelector, type AgentSelector, type SelectResult } from "../select";
import { defaultTuning, type TuningSource } from "../tuning";
import type { QuotaReader } from "../subscription/quota";
import type { MasterAsk } from "../types";
import { parseReply } from "./parse";
import { proposeChanges } from "./proposal";
import { AssessmentSchema, type Assessment } from "./schema";

export const ASSESSMENT_VERSION = 1;
const MASTER_AUTHOR = "master";

export interface AssessDeps {
  db: VibeDb;
  store: VibeStore;
  master: MasterAsk;
  quota: QuotaReader;
  selector?: AgentSelector;
  /** Prompt texts (registry); built-in defaults when omitted. */
  prompts?: PromptPort;
  /** Automation parameters and the requirements excerpt size (settings). */
  tuning?: TuningSource;
  requirementsChars?(): number;
  /** Provider/model label stored with the assessment. */
  masterLabel?: () => string | null;
  log?: (message: string, error?: unknown) => void;
}

export type AssessOutcome =
  | { status: "assessed"; eventId: string; assessment: Assessment; applied: AppliedAssessment }
  | { status: "failed"; error: string }
  | { status: "skipped"; reason: "not_found" | "not_draft" | "unchanged" | "stale" };

export interface AppliedAssessment {
  suggestedPresetId: string | null;
  presetName: string | null;
  /** Reviewer advice shown in the comment only; the card is not changed. */
  reviewer: { presetName: string | null; reason: string } | null;
  adjustment: string | null;
  planVersion: number;
  tags: string[];
  related: Assessment["related"];
}

/** Hash of what the owner wrote: a change here (not our own write-back) re-triggers assessment. */
export function contentHash(card: CardView, tagNames: string[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify([card.title, card.description, card.acceptance, [...tagNames].sort()]),
    )
    .digest("hex")
    .slice(0, 16);
}

interface Marker {
  hash: string;
  failed: boolean;
}

/** The newest master assessment (or recorded failure) and the content hash it was based on. */
export function lastAssessmentMarker(events: readonly CardEvent[]): Marker | null {
  for (const e of [...events].reverse()) {
    const body = e.body as { kind?: string; contentHash?: string } | null;
    if (!body?.contentHash) continue;
    if (e.type === "evaluation" && e.author === MASTER_AUTHOR) {
      return { hash: body.contentHash, failed: false };
    }
    if (e.type === "status" && body.kind === "assessment_failed") {
      return { hash: body.contentHash, failed: true };
    }
    // An accepted proposal (the master's own suggestion) is content the master already evaluated.
    if (e.type === "status" && body.kind === "proposal_applied") {
      return { hash: body.contentHash, failed: false };
    }
  }
  return null;
}

function tagNamesOf(store: VibeStore, card: CardView): string[] {
  const all = store.tags.list();
  return card.tags.map((id) => all.find((t) => t.id === id)?.name).filter((n): n is string => !!n);
}

export function resolvePreset(
  rec: Assessment["recommendation"],
  presets: Preset[],
): Preset | null {
  const wanted = rec.preset?.trim().toLowerCase();
  if (wanted) {
    const named = presets.find((p) => p.id === rec.preset || p.name.toLowerCase() === wanted);
    if (named) return named;
  }
  const sameAgent = presets.filter((p) => p.provider.toLowerCase() === rec.agent.toLowerCase());
  const model = rec.model?.toLowerCase();
  return (model && sameAgent.find((p) => p.model.toLowerCase().includes(model))) || sameAgent[0] || null;
}

/** Only advice: recommended and the card has no reviewer yet. The name must resolve to a listed preset. */
function reviewerAdvice(a: Assessment, card: CardView, presets: Preset[]): AppliedAssessment["reviewer"] {
  if (!a.reviewer?.recommend || card.reviewerPresetId) return null;
  const wanted = a.reviewer.presetName?.trim().toLowerCase();
  const found = wanted ? presets.find((p) => p.id === a.reviewer!.presetName || p.name.toLowerCase() === wanted) : null;
  return { presetName: found?.name ?? null, reason: a.reviewer.reason };
}

function bullet(items: string[]): string {
  return items.map((i) => `- ${i}`).join("\n");
}

export function renderAssessment(a: Assessment, applied: AppliedAssessment): string {
  const lines = [
    `**Clarity: ${a.clarity.status === "clear" ? "clear" : "needs clarification"}** - ${a.clarity.summary}`,
  ];
  if (a.clarity.questions.length) lines.push("Questions for you:", bullet(a.clarity.questions));
  if (applied.related.length) {
    lines.push(
      "Related cards:",
      bullet(applied.related.map((r) => `${r.card} (${r.relation})${r.note ? `: ${r.note}` : ""}`)),
    );
  }
  lines.push(
    a.split.suggested
      ? `Split suggested${a.split.reason ? `: ${a.split.reason}` : ""}\n${bullet(a.split.subCards.map((s) => s.title))}`
      : "Split: not needed",
  );
  if (applied.tags.length) lines.push(`Suggested tags: ${applied.tags.join(", ")}`);
  lines.push(`Size ${a.estimate.size}: ${a.estimate.rationale}`);
  lines.push(
    `Recommended agent: ${applied.presetName ?? a.recommendation.agent} - ${a.recommendation.reason}` +
      (applied.adjustment ? `\n(${applied.adjustment})` : ""),
  );
  if (applied.reviewer) {
    const who = applied.reviewer.presetName ? ` ${applied.reviewer.presetName}` : "";
    lines.push(
      `Recommended model review:${who}${applied.reviewer.reason ? ` - ${applied.reviewer.reason}` : ""} (pick the reviewer on the card yourself)`,
    );
  }
  if (a.risks.length) lines.push("Risks:", bullet(a.risks));
  if (a.files.length) lines.push("Expected files:", bullet(a.files));
  lines.push(
    "Acceptance checks:",
    bullet(a.checks.map((c) => (c.method ? `${c.text} (${c.method})` : c.text))),
  );
  return lines.join("\n");
}

/** Plain Chinese summary of an assessment, used when the master gave no `verdict` of its own. */
export function summarizeAssessment(a: Assessment, applied: Pick<AppliedAssessment, "presetName">): string {
  const lines: string[] = [
    a.clarity.status === "clear"
      ? `需求清晰，可以开始：${a.clarity.summary}`
      : `需求还需要澄清：${a.clarity.summary}`,
  ];
  if (a.clarity.questions.length) lines.push(`需要你回答的问题：\n${bullet(a.clarity.questions)}`);
  lines.push(
    `预估规模 ${a.estimate.size}（${a.estimate.rationale}）；推荐执行 agent：${applied.presetName ?? a.recommendation.agent}（${a.recommendation.reason}）。`,
  );
  lines.push(
    a.split.suggested
      ? `建议拆分${a.split.reason ? `：${a.split.reason}` : ""}\n${bullet(a.split.subCards.map((s) => s.title))}`
      : "无需拆分。",
  );
  if (a.risks.length) lines.push(`风险：\n${bullet(a.risks)}`);
  return lines.join("\n\n");
}

/**
 * The assessment as a group-chat message (kind verdict), plus the master's proposal. Idempotent per
 * evaluation event: a second call changes nothing.
 */
export function writeVerdictChat(
  store: VibeStore,
  card: CardView,
  evaluationEventId: string,
  assessment: Assessment,
  applied: Pick<AppliedAssessment, "presetName">,
): CardEvent {
  const key = `assess:${evaluationEventId}`;
  const existed = store.events
    .list(card.id)
    .some((e) => e.type === "chat" && (e.body as { key?: string } | null)?.key === key);
  const chat = store.cards.addChat({
    cardId: card.id,
    authorKind: "master",
    author: MASTER_AUTHOR,
    kind: "verdict",
    text: assessment.verdict?.trim() || summarizeAssessment(assessment, applied),
    key,
  });
  if (!existed) proposeChanges(store, card, assessment.proposal, MASTER_AUTHOR);
  return chat;
}

/** Track record per preset id from `<repo>/.vibe/workers/<provider>/MEMORY.md` (scheduler format). */
export function workerHistory(
  project: Pick<Project, "repoPath">,
  presets: readonly Preset[],
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  if (!project.repoPath) return out;
  for (const preset of presets) {
    const file = join(project.repoPath, ".vibe", "workers", preset.provider.toLowerCase(), "MEMORY.md");
    try {
      if (existsSync(file)) out[preset.id] = parseWorkerHistory(readFileSync(file, "utf8"));
    } catch {
      // unreadable memory: no track record
    }
  }
  return out;
}

export function createAssessor(deps: AssessDeps) {
  const { store, db } = deps;
  const selector = deps.selector ?? defaultSelector;
  const prompts = deps.prompts ?? defaultPromptPort();
  const tuning = deps.tuning ?? defaultTuning;
  const log = deps.log ?? (() => undefined);

  function context(card: CardView) {
    const project = store.projects.get(card.projectId) as Project;
    const tags = store.tags.list();
    const presets = store.presets.list();
    const openCards = store.cards
      .list({ projectId: card.projectId })
      .filter((c) => c.id !== card.id && c.column !== "done");
    return { project, tags, presets, openCards };
  }

  async function assess(
    ref: string,
    options: { force?: boolean } = {},
  ): Promise<AssessOutcome> {
    const card = store.cards.get(ref);
    if (!card || card.archivedAt) return { status: "skipped", reason: "not_found" };
    if (card.column !== "draft") return { status: "skipped", reason: "not_draft" };
    const names = tagNamesOf(store, card);
    const hash = contentHash(card, names);
    if (!options.force && lastAssessmentMarker(store.events.list(card.id))?.hash === hash) {
      return { status: "skipped", reason: "unchanged" };
    }

    const { project, tags, presets, openCards } = context(card);
    const quota = await deps.quota.get();
    const hint = selector({
      priority: card.priority,
      tags: names,
      platform: project.projectType,
      presets,
      quota,
      preselectedPresetId: card.presetId,
      history: workerHistory(project, presets),
    });
    const message = buildAssessMessage({
      projectBlock: buildProjectBlock({
        project,
        tags,
        presets,
        openCards,
        requirementsChars: deps.requirementsChars?.(),
        cardLimit: tuning().projectBlockCardLimit,
      }),
      prompts,
      card,
      tagNames: names,
      quota,
      hint,
    });

    let reply = await deps.master.ask(message);
    let parsed = parseReply(reply, AssessmentSchema);
    for (let retry = 0; retry < tuning().jsonRepairRetries && !parsed.ok; retry++) {
      log(`assessment of ${card.key} rejected, asking for a fix: ${parsed.error}`);
      reply = await deps.master.ask(buildRepairMessage("assess_draft", parsed.error, prompts, card.projectId));
      parsed = parseReply(reply, AssessmentSchema);
    }

    // The owner may have edited or moved the card while the master was thinking.
    const fresh = store.cards.get(card.id);
    if (!fresh || fresh.archivedAt || fresh.column !== "draft") {
      return { status: "skipped", reason: "not_draft" };
    }
    if (contentHash(fresh, tagNamesOf(store, fresh)) !== hash) {
      return { status: "skipped", reason: "stale" };
    }

    if (!parsed.ok) {
      store.events.add({
        cardId: card.id,
        type: "status",
        authorKind: "system",
        author: MASTER_AUTHOR,
        body: {
          kind: "assessment_failed",
          contentHash: hash,
          error: parsed.error,
          text: `The master's assessment was not valid JSON for the schema: ${parsed.error}`,
        },
      });
      return { status: "failed", error: parsed.error };
    }

    const assessment = parsed.value;
    const applied = writeBack({ card: fresh, hash, assessment, names, tags, presets, quota, project, openCards });
    return { status: "assessed", ...applied, assessment };
  }

  function writeBack(input: {
    card: CardView;
    hash: string;
    assessment: Assessment;
    names: string[];
    tags: { name: string }[];
    presets: Preset[];
    quota: Awaited<ReturnType<QuotaReader["get"]>>;
    project: Project;
    openCards: CardView[];
  }): { eventId: string; applied: AppliedAssessment } {
    const { card, assessment: a } = input;
    const vocabulary = new Map(input.tags.map((t) => [t.name.toLowerCase(), t.name]));
    const tags = [...new Set(a.tags.map((t) => vocabulary.get(t.toLowerCase())).filter((t): t is string => !!t))];
    const knownKeys = new Set(input.openCards.map((c) => c.key));
    const related = a.related.filter((r) => r.card !== card.key && knownKeys.has(r.card));

    // Recommendation -> preset, then the quota policy: exhausted (or tight for low-priority
    // cards) providers are replaced by the selector's choice, which respects card priority.
    let preset = resolvePreset(a.recommendation, input.presets);
    let adjustment: string | null = null;
    const level = (p: Preset | null) => (p ? (input.quota[p.provider.toLowerCase()]?.level ?? "unknown") : "unknown");
    const highPriority = card.priority === "urgent" || card.priority === "high";
    const blocked = preset && (level(preset) === "exhausted" || (level(preset) === "tight" && !highPriority));
    if (!preset || blocked) {
      const alt: SelectResult = selector({
        priority: card.priority,
        size: a.estimate.size,
        tags: input.names,
        platform: input.project.projectType,
        presets: input.presets,
        quota: input.quota,
        history: workerHistory(input.project, input.presets),
      });
      const replacement = alt.presetId ? (input.presets.find((p) => p.id === alt.presetId) ?? null) : null;
      if (preset && blocked) {
        adjustment = replacement
          ? `${preset.name} was replaced by ${replacement.name}: ${preset.provider} quota is ${level(preset)} for a ${card.priority}-priority card`
          : `${preset.name} is not available now: ${preset.provider} quota is ${level(preset)}${alt.wait ? ` (${alt.wait})` : ""}`;
        preset = replacement;
      } else if (!preset && replacement) {
        adjustment = `no listed preset matched "${a.recommendation.preset ?? a.recommendation.agent}"; ${replacement.name} picked by the selector (${alt.reason})`;
        preset = replacement;
      }
    }

    const body = {
      kind: "assessment",
      version: ASSESSMENT_VERSION,
      contentHash: input.hash,
      text: "",
      assessment: a,
      applied: null as AppliedAssessment | null,
      master: deps.masterLabel?.() ?? null,
    };

    return db.immediate(() => {
      const plan = store.plans.save(card.id, {
        description: card.description,
        checks: a.checks.map((c) => (c.method ? { text: c.text, method: c.method } : { text: c.text })),
        subCards: a.split.suggested ? a.split.subCards : [],
        tags,
        recommendedPresetId: preset?.id ?? null,
        notes: a.risks.length ? `Risks:\n${bullet(a.risks)}` : undefined,
        ...(a.files.length ? { files: a.files } : {}),
      });
      if ((preset?.id ?? null) !== card.suggestedPresetId) {
        store.cards.update(card.id, { suggestedPresetId: preset?.id ?? null });
      }
      const applied: AppliedAssessment = {
        suggestedPresetId: preset?.id ?? null,
        presetName: preset?.name ?? null,
        reviewer: reviewerAdvice(a, card, input.presets),
        adjustment,
        planVersion: plan.version,
        tags,
        related,
      };
      body.applied = applied;
      body.text = renderAssessment(a, applied);
      const event = store.events.add({
        cardId: card.id,
        type: "evaluation",
        authorKind: "agent",
        author: MASTER_AUTHOR,
        body,
      });
      writeVerdictChat(store, card, event.id, a, applied);
      return { eventId: event.id, applied };
    });
  }

  return { assess, context };
}

export type Assessor = ReturnType<typeof createAssessor>;
