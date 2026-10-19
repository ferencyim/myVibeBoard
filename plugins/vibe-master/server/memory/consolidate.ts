// Session-end consolidation (card done) and worker-help advice. Both are "ask the master, validate,
// write back" flows like the draft assessment.

import { existsSync } from "node:fs";
import { MemoryUpdateSchema, HelpSchema, type Help, type MemoryUpdate } from "../assess/schema";
import { parseReply } from "../assess/parse";
import type { Assessor } from "../assess/assess";
import { buildDoneMessage, buildHelpMessage, buildProjectBlock, buildRepairMessage } from "../master/prompts";
import type { VibeDb, VibeStore } from "../vibe/db";
import type { MasterAsk } from "../types";
import type { ApplyResult, MemoryPort } from "./files";

export interface ConsolidateDeps {
  db: VibeDb;
  store: VibeStore;
  master: MasterAsk;
  assessor: Assessor;
  memory: MemoryPort;
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
      return `### ${file}\n${lines.join("\n") || "(empty)"}`;
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
      `${v.conclusion ?? "unfinished"} (${v.mode}, commit ${v.commit_hash.slice(0, 8)})`,
      ...items.map((i) => `- ${i.judgement ?? "?"}: ${clip(i.check_text, 120)}${i.note ? ` - ${clip(i.note, 120)}` : ""}`),
    ].join("\n");
  } catch {
    return "";
  }
}

export function createConsolidator(deps: ConsolidateDeps) {
  const { store } = deps;
  const log = deps.log ?? (() => undefined);

  async function consolidate(ref: string, options: { force?: boolean } = {}): Promise<ConsolidateOutcome> {
    const card = store.cards.get(ref);
    if (!card) return { status: "skipped", reason: "not_found" };
    if (card.column !== "done") return { status: "skipped", reason: "not_done" };
    const events = store.events.list(card.id);
    const marker = (e: { body: unknown }) => (e.body as { kind?: string } | null)?.kind;
    if (!options.force && events.some((e) => e.type === "note" && marker(e) === "memory_update")) {
      return { status: "skipped", reason: "already_done" };
    }
    const { project, tags, presets, openCards } = deps.assessor.context(card);
    if (!project.repoPath || !existsSync(project.repoPath)) return { status: "skipped", reason: "no_repo" };

    const message = buildDoneMessage({
      projectBlock: buildProjectBlock({ project, tags, presets, openCards }),
      card,
      events,
      verification: verificationSummary(deps.db, card.id),
      memory: formatMemory(deps.memory.snapshot(project.repoPath)),
    });
    let parsed = parseReply(await deps.master.ask(message), MemoryUpdateSchema);
    if (!parsed.ok) {
      log(`memory update for ${card.key} rejected, asking for a fix: ${parsed.error}`);
      parsed = parseReply(await deps.master.ask(buildRepairMessage("card_done", parsed.error)), MemoryUpdateSchema);
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
    return { status: "updated", summary: update.summary, applied };
  }

  async function advise(
    cardRef: string,
    question: unknown,
  ): Promise<{ status: "advised"; help: Help } | { status: "skipped" | "failed"; reason: string }> {
    const card = store.cards.get(cardRef);
    if (!card) return { status: "skipped", reason: "not_found" };
    const requestId = (question as { requestId?: string } | null)?.requestId;
    const seen = store
      .events.list(card.id)
      .some((e) => (e.body as { kind?: string; requestId?: string } | null)?.kind === "help_advice" &&
        (e.body as { requestId?: string }).requestId === requestId && requestId !== undefined);
    if (seen) return { status: "skipped", reason: "already_advised" };

    const { project, tags, presets, openCards } = deps.assessor.context(card);
    const plan = store.plans.list(card.id).at(-1)?.snapshot;
    const message = buildHelpMessage({
      projectBlock: buildProjectBlock({ project, tags, presets, openCards }),
      card,
      question,
      plan: plan ? [plan.description, ...plan.checks.map((c) => `- ${c.text}`)].filter(Boolean).join("\n") : "",
    });
    let parsed = parseReply(await deps.master.ask(message), HelpSchema);
    if (!parsed.ok) {
      parsed = parseReply(await deps.master.ask(buildRepairMessage("session_help", parsed.error)), HelpSchema);
    }
    if (!parsed.ok) return { status: "failed", reason: parsed.error };
    const help = parsed.value;
    store.events.add({
      cardId: card.id,
      type: "note",
      authorKind: "agent",
      author: "master",
      body: {
        kind: "help_advice",
        requestId,
        text:
          `Advice for the worker's question (${help.confidence} confidence${help.needsOwner ? ", needs your decision" : ""}): ${help.summary}` +
          (help.suggestedAnswer ? `\nSuggested answer: ${help.suggestedAnswer}` : ""),
        advice: help,
      },
    });
    return { status: "advised", help };
  }

  return { consolidate, advise };
}

export type Consolidator = ReturnType<typeof createConsolidator>;
