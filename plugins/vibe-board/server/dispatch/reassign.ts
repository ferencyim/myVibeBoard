// Failure reassignment (WP-84): a worker whose turn failed for a provider-side reason (quota
// exhausted, login expired, provider/model unavailable - see lifecycle/error-class.ts) continues
// on the next preset of the failed preset's `fallbackPresetIds` chain, in the same worktree.
//
// How the new agent learns what happened:
//   1. native: Claude <-> Codex sessions are converted into the other provider's own session format
//      (switch-provider's txcript approach, see dispatch/convert.ts), so the history is complete;
//   2. hand-off: any other pair (or when conversion is unavailable/fails) gets the dispatch brief plus
//      a Markdown transcript of the old agent saved under `<worktree>/.vibe/sessions/`.
// The swap itself is `sessions.recordReassign` (one transaction: old session ended "reassigned",
// replacement started, card.preset_id switched, switch_agent card event, session.reassigned event,
// which the phone push listens to). No candidate left -> the caller keeps the session in `error`.

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import type { AgentSession, CardView, Preset } from "../vibe/contract";
import type { BoardService } from "../service";
import type { AgentTracker } from "./index";
import { buildDispatchBrief, modeIdFor, providerSpec } from "./brief";
import { loadHandoff } from "./handoff";
import type { FailureCategory } from "../lifecycle/error-class";

export type ReassignPaseo = Pick<PaseoApi, "agents" | "workspaces"> &
  Partial<Pick<PaseoApi, "providers">>;

/** Native session conversion; resolve the new agent id, or null when this pair cannot be converted. */
export type ConvertSession = (input: {
  paseo: ReassignPaseo;
  fromAgentId: string;
  fromProvider: string;
  to: Preset;
  workspaceId: string | null;
  cwd: string | null;
}) => Promise<string | null>;

export interface ReassignDeps {
  board: BoardService;
  getPaseo: () => ReassignPaseo | null;
  tracker?: AgentTracker;
  convert?: ConvertSession;
  /** Runs `fn` while lifecycle ignores `import` session opens in the workspace (they are ours). */
  guardImport?: <T>(workspaceId: string | null, fn: () => Promise<T>) => Promise<T>;
  newAgentId?: () => string;
  log?: (message: string, error?: unknown) => void;
}

export interface Failure {
  message: string;
  category: FailureCategory;
}

export type ReassignResult =
  | { reassigned: AgentSession; preset: Preset; method: "converted" | "transcript" }
  | { reassigned: null; reason: string; attempts: string[] };

const MAX_BLOCK = 20_000;
const clip = (text: string) =>
  text.length > MAX_BLOCK ? `${text.slice(0, MAX_BLOCK)}\n[cut: ${text.length - MAX_BLOCK} more characters]` : text;

function renderItem(item: Record<string, unknown>): string | null {
  switch (item.type) {
    case "user_message":
      return `## User\n\n${item.text}`;
    case "assistant_message":
      return `## Assistant\n\n${item.text}`;
    case "reasoning":
      return `### Reasoning\n\n${item.text}`;
    case "tool_call":
      return `### Tool call: ${item.name} (${item.status})\n\n\`\`\`json\n${clip(JSON.stringify({ detail: item.detail, error: item.error }, null, 1))}\n\`\`\``;
    case "todo":
      return `### Todo list\n\n${clip(JSON.stringify(item.items))}`;
    case "error":
    case "notification":
      return `### ${item.type}\n\n${item.message}`;
    default:
      return null;
  }
}

/** Markdown transcript of an agent's timeline (best effort: an agent that never started has none). */
export async function renderTranscript(paseo: ReassignPaseo, agentId: string): Promise<string> {
  const timeline = paseo.agents.ref(agentId).timeline;
  let page = await timeline.refetch({ direction: "tail", limit: 500, projection: "projected" });
  let entries = [...page.entries];
  for (let i = 0; i < 20 && page.hasOlder && page.startCursor; i++) {
    page = await timeline.refetch({
      direction: "before",
      cursor: page.startCursor,
      limit: 500,
      projection: "projected",
    });
    entries = [...page.entries, ...entries];
  }
  return entries
    .map((e) => renderItem(e.item as unknown as Record<string, unknown>))
    .filter((block): block is string => block !== null)
    .join("\n\n");
}

export function createReassigner(deps: ReassignDeps) {
  const { board, tracker } = deps;
  const { store } = board;
  const log = deps.log ?? ((m, e) => console.error(`[vibe-board reassign] ${m}`, e ?? ""));
  const inflight = new Set<string>();

  const presetById = (id: string) => store.presets.list().find((p) => p.id === id);

  /** Presets already used for the card (failover events) plus the current one. */
  function history(card: CardView) {
    const used: string[] = [];
    for (const e of store.events.list(card.id)) {
      const b = e.body as { kind?: string; fromPresetId?: string; toPresetId?: string } | null;
      if (e.type === "status" && b?.kind === "failover") {
        for (const id of [b.fromPresetId, b.toPresetId]) if (id && !used.includes(id)) used.push(id);
      }
    }
    return used;
  }

  /** Ordered candidates: the current preset's chain, then the chains of the presets already tried. */
  function candidatesFor(card: CardView): Preset[] {
    if (!card.presetId) return [];
    const tried = new Set([card.presetId, ...history(card)]);
    const roots = [card.presetId, ...[...tried].filter((id) => id !== card.presetId).reverse()];
    const out: Preset[] = [];
    for (const root of roots) {
      for (const id of presetById(root)?.fallbackPresetIds ?? []) {
        const preset = presetById(id);
        if (preset && !tried.has(id) && !out.some((p) => p.id === id)) out.push(preset);
      }
    }
    return out;
  }

  async function providerUsable(paseo: ReassignPaseo, provider: string): Promise<string | null> {
    if (!paseo.providers) return null;
    try {
      const { providers } = await paseo.providers.listAvailable();
      const entry = providers.find((p) => p.provider === provider);
      return entry && !entry.available ? (entry.error ?? "provider not available") : null;
    } catch {
      return null; // cannot tell: try it
    }
  }

  function saveTranscript(card: CardView, cwd: string | null, agentId: string, markdown: string): string {
    const body = `# Transcript of the previous agent (${agentId}) on ${card.key}\n\n${markdown}\n`;
    const name = `${card.key}-failover-${Date.now()}.md`;
    for (const dir of [cwd ? join(cwd, ".vibe", "sessions") : "", join(tmpdir(), "vibe-board-transcripts")]) {
      if (!dir) continue;
      try {
        mkdirSync(dir, { recursive: true });
        const path = join(dir, name);
        writeFileSync(path, body);
        return path;
      } catch {
        // not writable: next location
      }
    }
    return "";
  }

  async function start(
    paseo: ReassignPaseo,
    old: AgentSession,
    card: CardView,
    preset: Preset,
    failure: Failure,
  ): Promise<{ agentId: string; method: "converted" | "transcript" }> {
    const project = store.projects.get(card.projectId);
    if (!project) throw new Error(`Project not found: ${card.projectId}`);
    const cwd = card.worktree ?? null;
    const events = store.events.list(card.id);
    const why = `The previous agent (${old.currentProvider}) stopped with a ${failure.category} failure: ${failure.message}`;

    // 1. native conversion (the new agent receives the full history)
    if (deps.convert) {
      try {
        const agentId = await (deps.guardImport ?? ((_, fn) => fn()))(old.workspaceId, () =>
          deps.convert!({ paseo, fromAgentId: old.agentId, fromProvider: old.currentProvider, to: preset, workspaceId: old.workspaceId, cwd }),
        );
        if (agentId) return { agentId, method: "converted" };
      } catch (error) {
        log("session conversion failed, using the transcript hand-off", error);
      }
    }

    // 2. hand-off brief + transcript file
    let transcriptPath = "";
    try {
      transcriptPath = saveTranscript(card, cwd, old.agentId, await renderTranscript(paseo, old.agentId));
    } catch (error) {
      log("could not read the previous agent's timeline", error);
    }
    const prompt = buildDispatchBrief({
      card,
      project,
      preset,
      events,
      handoff: loadHandoff(project, card, events),
      latestPlan: store.plans.list(card.id).at(-1),
      extraInstructions: [
        why,
        "You are taking over the same card in the SAME worktree: run `git status` and `git log` first to see what is already done, then continue; do not start over.",
        transcriptPath
          ? `The previous agent's transcript is in ${transcriptPath} (read it before you act).`
          : "The previous agent's transcript is not available; rely on the worktree, the card notes and `.vibe/sessions/` notes.",
      ].join("\n"),
    });
    const agentId = (deps.newAgentId ?? randomUUID)();
    tracker?.expect(agentId);
    try {
      const modeId = modeIdFor(preset.provider, preset.permissionMode);
      const options = {
        agentId,
        title: `${card.key} · ${card.title}`.slice(0, 80),
        prompt,
        labels: { cardKey: card.key, cardId: card.id, role: "worker", preset: preset.name },
        env: {
          VIBE_ROLE: "worker",
          VIBE_CARD_ID: card.id,
          VIBE_CARD_KEY: card.key,
          ...(preset.runtimeEnv ? { VIBE_RUNTIME_ENV: preset.runtimeEnv } : {}),
        },
        config: {
          provider: providerSpec(preset),
          ...(preset.thinking && preset.thinking !== "default" ? { thinkingOptionId: preset.thinking } : {}),
          ...(modeId ? { modeId } : {}),
        },
      };
      if (old.workspaceId) {
        const workspace = paseo.workspaces.ref(old.workspaceId);
        await workspace.refresh();
        await workspace.agents.create(options);
      } else if (cwd) {
        await paseo.agents.create({ ...options, cwd });
      } else {
        throw new Error("The failed session has neither a workspace nor a worktree to continue in");
      }
    } catch (error) {
      tracker?.release(agentId);
      throw error;
    }
    return { agentId, method: "transcript" };
  }

  async function reassign(sessionId: string, failure: Failure): Promise<ReassignResult> {
    const old = store.sessions.get(sessionId);
    if (!old || old.state === "ended") return { reassigned: null, reason: "session already ended", attempts: [] };
    if (old.role !== "worker" || !old.cardId) return { reassigned: null, reason: "only card workers are reassigned", attempts: [] };
    if (inflight.has(old.id)) return { reassigned: null, reason: "already reassigning", attempts: [] };
    const card = store.cards.get(old.cardId);
    const paseo = deps.getPaseo();
    if (!card || !paseo) return { reassigned: null, reason: "no daemon connection or card", attempts: [] };
    const candidates = candidatesFor(card);
    if (candidates.length === 0) return { reassigned: null, reason: "no fallback preset configured", attempts: [] };

    inflight.add(old.id);
    const attempts: string[] = [];
    try {
      for (const preset of candidates) {
        const unusable = await providerUsable(paseo, preset.provider);
        if (unusable) {
          attempts.push(`${preset.name}: ${unusable}`);
          continue;
        }
        let started: Awaited<ReturnType<typeof start>>;
        try {
          started = await start(paseo, old, card, preset, failure);
        } catch (error) {
          attempts.push(`${preset.name}: ${error instanceof Error ? error.message : String(error)}`);
          log(`fallback ${preset.name} could not start`, error);
          continue;
        }
        const fromPresetId = card.presetId;
        const { to } = store.sessions.recordReassign({
          fromSessionId: old.id,
          agentId: started.agentId,
          workspaceId: old.workspaceId,
          provider: preset.provider,
          reason: `${failure.category}: ${failure.message}`.slice(0, 500),
          presetId: preset.id,
        });
        store.events.add({
          cardId: card.id,
          type: "status",
          authorKind: "system",
          author: "failover",
          body: {
            kind: "failover",
            fromPresetId,
            toPresetId: preset.id,
            category: failure.category,
            method: started.method,
            text: `${old.currentProvider} failed (${failure.category}); continuing on ${preset.name} (${preset.provider}/${preset.model}) in the same worktree.`,
          },
        });
        await tracker?.bind(started.agentId);
        if (started.method === "converted") {
          // An imported agent has no prompt of its own: tell it to carry on.
          await paseo.agents
            .ref(started.agentId)
            .send(
              `The previous agent on ${old.currentProvider} stopped (${failure.category}). Its history is above; ` +
                `continue card ${card.key} in this worktree (check git status first).`,
            )
            .catch((error) => log("could not prompt the converted agent", error));
        }
        return { reassigned: to, preset, method: started.method };
      }
      return { reassigned: null, reason: "every fallback failed", attempts };
    } finally {
      inflight.delete(old.id);
    }
  }

  return { reassign, candidatesFor };
}

export type Reassigner = ReturnType<typeof createReassigner>;
