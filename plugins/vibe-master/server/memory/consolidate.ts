// Session-end consolidation (card done): ask the master, validate, write the project memory back.

import { existsSync } from "node:fs";
import { buildDoneMessage, buildProjectBlock, buildRepairMessage, requirementsExcerpt, DEFAULT_REQUIREMENTS_CHARS } from "../master/prompts";
import { MemoryUpdateSchema, type MemoryUpdate } from "../assess/schema";
import { parseReply } from "../assess/parse";
import { writeRequirementsDoc, type GitRunner, type VibeDb, type VibeStore } from "../vibe/db";
import { defaultPromptPort, type PromptPort } from "../prompts/port";
import { defaultTuning, type TuningSource } from "../tuning";
import type { MasterAsk } from "../types";
import type { CardView, Project } from "../vibe/contract";
import type { ApplyResult, MemoryPort } from "./files";

export interface ConsolidateDeps {
  db: VibeDb;
  store: VibeStore;
  master: MasterAsk;
  memory: MemoryPort;
  /** Prompt texts (registry); built-in defaults when omitted. */
  prompts?: PromptPort;
  /** Owner settings (read on every use). All optional: 6000 chars, no requirements writes, default tuning. */
  options?: {
    requirementsChars?(): number;
    maintainRequirements?(): boolean;
    tuning?: TuningSource;
  };
  /** A requirements update failed: remind the owner (once per cooldown). */
  onRequirementsFailure?(cardKey: string, message: string): void;
  /** Injectable git for the requirements commit. */
  git?: GitRunner;
  log?: (message: string, error?: unknown) => void;
}

export type ConsolidateOutcome =
  | { status: "updated"; summary: string; applied: ApplyResult }
  | { status: "failed"; error: string }
  | { status: "skipped"; reason: "not_found" | "not_done" | "no_repo" | "already_done" };

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function formatMemory(snapshot: ReturnType<MemoryPort["snapshot"]>): string {
  return Object.entries(snapshot)
    .map(([file, entries]) => {
      const lines = entries.map((e) => `- [${e.id}]${e.tag ? ` (${e.tag})` : ""} ${clip(e.body.replace(/\s+/g, " "), 240)}`);
      return `### ${file}\n${lines.join("\n") || "（空）"}`;
    })
    .join("\n");
}

/** Latest verification of the card, if the vibe-verify tables exist (read-only). */
function verificationSummary(db: VibeDb, cardId: string): string {
  try {
    const v = db
      .prepare<{ id: string; conclusion: string | null; mode: string; commit_hash: string }>(
        "SELECT id, conclusion, mode, commit_hash FROM verification WHERE card_id = ? ORDER BY started_at DESC LIMIT 1",
      )
      .get(cardId);
    if (!v) return "";
    const items = db
      .prepare<{ check_text: string; judgement: string | null; note: string }>(
        "SELECT check_text, judgement, note FROM verification_item WHERE verification_id = ? ORDER BY position",
      )
      .all(v.id);
    return [
      `${v.conclusion ?? "未完成"} (${v.mode}, commit ${v.commit_hash.slice(0, 8)})`,
      ...items.map((i) => `- ${i.judgement ?? "?"}: ${clip(i.check_text, 120)}${i.note ? ` - ${clip(i.note, 120)}` : ""}`),
    ].join("\n");
  } catch {
    return "";
  }
}

export function createConsolidator(deps: ConsolidateDeps) {
  const { store } = deps;
  const log = deps.log ?? (() => undefined);
  const prompts = deps.prompts ?? defaultPromptPort();
  const tuning = deps.options?.tuning ?? defaultTuning;
  const projectBlockOf = (input: Omit<Parameters<typeof buildProjectBlock>[0], "requirementsChars" | "cardLimit">) =>
    buildProjectBlock({
      ...input,
      requirementsChars: deps.options?.requirementsChars?.(),
      cardLimit: tuning().projectBlockCardLimit,
    });

  function context(card: CardView) {
    const project = store.projects.get(card.projectId) as Project;
    const openCards = store.cards
      .list({ projectId: card.projectId })
      .filter((c) => c.id !== card.id && c.column !== "done");
    return { project, tags: store.tags.list(), presets: store.presets.list(), openCards };
  }

  /**
   * Write the master's requirementsUpdate to the project's document and commit only that file.
   * Never throws: a failure becomes a note on the card plus a reminder, and is not retried.
   */
  async function applyRequirements(
    card: { id: string; key: string },
    project: Parameters<typeof requirementsExcerpt>[0] & { repoPath: string },
    update: NonNullable<MemoryUpdate["requirementsUpdate"]>,
  ): Promise<void> {
    const note = (kind: string, text: string, extra: Record<string, unknown> = {}) =>
      store.events.add({
        cardId: card.id,
        type: "note",
        authorKind: "agent",
        author: "master",
        body: { kind, text, ...extra },
      });
    const maxChars = deps.options?.requirementsChars?.() ?? DEFAULT_REQUIREMENTS_CHARS;
    // The master only saw an excerpt: rewriting from a truncated view would delete the rest.
    if (requirementsExcerpt(project, maxChars)?.truncated) {
      const text = `需求文档超过摘录上限 (${maxChars} 字符)，总 agent 只看到了一部分，未自动更新。请调大「需求文档摘录上限」或手动修改。`;
      note("requirements_update_failed", text);
      deps.onRequirementsFailure?.(card.key, text);
      return;
    }
    try {
      const result = await writeRequirementsDoc(
        project.repoPath,
        project.requirementsPath,
        update.content.endsWith("\n") ? update.content : `${update.content}\n`,
        `docs(requirements): ${update.summary.replace(/\s+/g, " ").trim()} [${card.key}]`,
        deps.git,
      );
      note(
        "requirements_update",
        result.committed
          ? `总 agent 更新了需求文档 ${result.path} (提交 ${result.commit?.slice(0, 8)}): ${update.summary}`
          : `总 agent 建议的需求文档内容与现有一致，未产生提交 (${result.path})`,
        { path: result.path, commit: result.commit },
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const text = `需求文档未能更新: ${reason}。不会自动重试；仓库空闲后可手动让总 agent 重跑该卡的完成整理。`;
      note("requirements_update_failed", text);
      deps.onRequirementsFailure?.(card.key, text);
      log(`requirements update for ${card.key} failed`, error);
    }
  }

  async function consolidate(ref: string, options: { force?: boolean } = {}): Promise<ConsolidateOutcome> {
    const card = store.cards.get(ref);
    if (!card) return { status: "skipped", reason: "not_found" };
    if (card.column !== "done") return { status: "skipped", reason: "not_done" };
    const events = store.events.list(card.id);
    const marker = (e: { body: unknown }) => (e.body as { kind?: string } | null)?.kind;
    if (!options.force && events.some((e) => e.type === "note" && marker(e) === "memory_update")) {
      return { status: "skipped", reason: "already_done" };
    }
    const { project, tags, presets, openCards } = context(card);
    if (!project.repoPath || !existsSync(project.repoPath)) return { status: "skipped", reason: "no_repo" };

    const message = buildDoneMessage({
      projectBlock: projectBlockOf({ project, tags, presets, openCards }),
      card,
      events,
      verification: verificationSummary(deps.db, card.id),
      memory: formatMemory(deps.memory.snapshot(project.repoPath)),
      prompts,
    });
    let parsed = parseReply(await deps.master.ask(message), MemoryUpdateSchema);
    for (let retry = 0; retry < tuning().jsonRepairRetries && !parsed.ok; retry++) {
      log(`memory update for ${card.key} rejected, asking for a fix: ${parsed.error}`);
      parsed = parseReply(
        await deps.master.ask(buildRepairMessage("card_done", parsed.error, prompts, card.projectId)),
        MemoryUpdateSchema,
      );
    }
    if (!parsed.ok) {
      store.events.add({
        cardId: card.id,
        type: "status",
        authorKind: "system",
        author: "master",
        body: { kind: "memory_update_failed", error: parsed.error, text: `Memory update was not valid: ${parsed.error}` },
      });
      return { status: "failed", error: parsed.error };
    }
    const update: MemoryUpdate = parsed.value;
    const applied = deps.memory.apply(project.repoPath, update);
    store.events.add({
      cardId: card.id,
      type: "note",
      authorKind: "agent",
      author: "master",
      body: {
        kind: "memory_update",
        text: `${update.summary} (state ${applied.stateWritten ? "rewritten" : "kept"}, +${applied.added}, superseded ${applied.superseded}, archived ${applied.archived}, duplicates ${applied.duplicates})`,
        update,
        applied,
      },
    });
    if (update.requirementsUpdate) {
      if (deps.options?.maintainRequirements?.()) {
        await applyRequirements(card, { ...project, repoPath: project.repoPath }, update.requirementsUpdate);
      } else {
        log(`requirementsUpdate for ${card.key} ignored: requirements maintenance is off`);
      }
    }
    return { status: "updated", summary: update.summary, applied };
  }

  return { consolidate };
}

export type Consolidator = ReturnType<typeof createConsolidator>;
