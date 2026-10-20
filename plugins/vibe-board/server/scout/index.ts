// Scout (WP-81): lets an execution session (expensive model) fan out cheap, read-only sub-agents
// that locate files, take inventories or research, and get back only compact findings.
//
// Exposed to agents as the MCP tool `vibe_scout` (server/mcp/tools.ts). Scouts are labelled
// role=scout so vibe-stats can tell their usage apart from workers'.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import { selectAgent, type AgentProfile, type Preset, type SelectContext } from "../vibe/contract";
import { BoardError, type BoardService } from "../service";

export type ScoutPaseo = Pick<PaseoApi, "agents">;

export const SCOUT_KINDS = ["locate", "inventory", "research"] as const;
export type ScoutKind = (typeof SCOUT_KINDS)[number];

export const SCOUT_MAX_PARALLEL_LIMIT = 16;
export const SCOUT_MAX_TASKS_PER_CALL = 16;
const SUMMARY_MAX_LINES = 20;
const CACHE_TTL_MS = 10 * 60_000;

export interface ScoutTask {
  goal: string;
  paths?: string[];
  kind?: ScoutKind;
}

export interface ScoutConfig {
  /** Preset id or name; empty = role_hint=scout preset, else the cheapest by selectAgent. */
  preset: string;
  maxParallel: number;
  timeoutMs: number;
}

export interface ScoutResult {
  goal: string;
  kind: ScoutKind;
  status: "ok" | "timeout" | "failed";
  summary: string;
  cached?: boolean;
}

export interface ScoutRunResult {
  preset: string | null;
  results: ScoutResult[];
}

export interface ScoutServiceOptions {
  board: BoardService;
  getPaseo: () => ScoutPaseo | null;
  getConfig: () => Promise<ScoutConfig> | ScoutConfig;
  /** Appends scout.started / scout.finished to the vibe_event bus. */
  publish?: (
    type: "scout.started" | "scout.finished",
    cardId: string,
    projectId: string,
    payload: Record<string, unknown>,
  ) => void;
  newAgentId?: () => string;
  /** HEAD commit of a directory (cache key). Default: git rev-parse. */
  headOf?: (cwd: string) => Promise<string>;
  now?: () => number;
}

export const SCOUT_SYSTEM_PROMPT = `[vibe-scout]
You are a read-only scout working for another coding agent. Answer ONE question about the repository in your working directory.
- Never modify files, never run commands that change state, never call vibe_scout or any vibe_* tool.
- Be fast: search and read only what the question needs.
- Reply with at most ${SUMMARY_MAX_LINES} lines of plain text, no preamble. Every finding is one line "path:line - what it is" (relative paths). Say explicitly when something was not found.`;

/** Provider read-only mode id (undefined: provider default; the prompt still forbids writes). */
export function readOnlyModeFor(provider: string): string | undefined {
  const p = provider.toLowerCase();
  if (p === "claude") return "plan";
  if (p === "codex") return "read-only";
  return undefined;
}

const specOf = (preset: Pick<Preset, "provider" | "model">) =>
  preset.model.startsWith(`${preset.provider}/`) ? preset.model : `${preset.provider}/${preset.model}`;

function tierOf(preset: Pick<Preset, "model" | "thinking">): 1 | 2 | 3 {
  const name = `${preset.model} ${preset.thinking}`.toLowerCase();
  if (/(opus|fable|xhigh|max|ultra|gpt-5(?!.*mini)|o3|pro\b)/.test(name)) return 3;
  if (/(haiku|mini|flash|lite|nano)/.test(name)) return 1;
  return 2;
}

function profileOf(preset: Preset): AgentProfile {
  return {
    id: preset.id,
    provider: preset.provider.toLowerCase(),
    tier: tierOf(preset),
    strengths: [],
    presetId: preset.id,
  };
}

/** setting -> role_hint=scout -> cheapest by the shared selector. */
export function pickScoutPreset(
  presets: readonly Preset[],
  setting: string,
  ctx: SelectContext = { quota: {} },
): Preset | null {
  const wanted = setting.trim().toLowerCase();
  if (wanted) {
    const named = presets.find((p) => p.id === setting.trim() || p.name.toLowerCase() === wanted);
    if (named) return named;
  }
  const hinted = presets.find((p) => p.roleHint?.toLowerCase() === "scout");
  if (hinted) return hinted;
  if (presets.length === 0) return null;
  const selection = selectAgent(presets.map(profileOf), { tags: ["scout"], size: "S", priority: "low" }, ctx);
  return presets.find((p) => p.id === selection.agentId) ?? null;
}

/** Keeps the first SUMMARY_MAX_LINES non-empty lines. */
export function trimSummary(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim());
  const kept = lines.slice(0, SUMMARY_MAX_LINES);
  if (lines.length > kept.length) kept.push(`... (${lines.length - kept.length} more lines cut)`);
  return kept.join("\n");
}

type NormTask = { goal: string; kind: ScoutKind; paths: string[] };

function buildPrompt(task: NormTask): string {
  const how = {
    locate: "Locate the files, symbols or lines that answer the goal.",
    inventory: "Make a precise inventory (counts, lists) for the goal; give exact numbers.",
    research:
      "Research the goal from the repository docs, comments and sources (and the web if you have a search tool).",
  }[task.kind];
  return [
    `Kind: ${task.kind}. ${how}`,
    `Goal: ${task.goal}`,
    task.paths.length ? `Restrict to: ${task.paths.join(", ")}` : "",
    `Answer in at most ${SUMMARY_MAX_LINES} lines with path:line anchors.`,
  ]
    .filter(Boolean)
    .join("\n");
}

const gitHead = (cwd: string) =>
  new Promise<string>((resolve) =>
    execFile("git", ["rev-parse", "HEAD"], { cwd, windowsHide: true }, (error, stdout) =>
      resolve(error ? "" : stdout.trim()),
    ),
  );

class Semaphore {
  private active = 0;
  private waiting: Array<() => void> = [];
  constructor(private limit: () => number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    while (this.active >= Math.max(1, this.limit())) {
      await new Promise<void>((r) => this.waiting.push(r));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

export function createScoutService(options: ScoutServiceOptions) {
  const { board } = options;
  const now = options.now ?? Date.now;
  const headOf = options.headOf ?? gitHead;
  let currentLimit = 4;
  const gate = new Semaphore(() => currentLimit);
  const cache = new Map<string, { at: number; result: ScoutResult }>();
  const inflight = new Map<string, Promise<ScoutResult>>();

  async function runOne(
    task: NormTask,
    ctx: { cardId: string; cardKey: string; cwd: string; preset: Preset; timeoutMs: number },
  ): Promise<ScoutResult> {
    const base = { goal: task.goal, kind: task.kind };
    const paseo = options.getPaseo();
    if (!paseo) return { ...base, status: "failed", summary: "No active Paseo daemon connection" };
    const modeId = readOnlyModeFor(ctx.preset.provider);
    let handle: Awaited<ReturnType<ScoutPaseo["agents"]["create"]>> | null = null;
    try {
      handle = await paseo.agents.create({
        agentId: (options.newAgentId ?? randomUUID)(),
        title: `${ctx.cardKey} scout`,
        cwd: ctx.cwd,
        labels: { cardKey: ctx.cardKey, cardId: ctx.cardId, role: "scout", preset: ctx.preset.name },
        env: { VIBE_ROLE: "scout", VIBE_CARD_ID: ctx.cardId, VIBE_CARD_KEY: ctx.cardKey },
        config: {
          provider: specOf(ctx.preset),
          systemPrompt: SCOUT_SYSTEM_PROMPT,
          ...(modeId ? { modeId } : {}),
        },
      });
      const result = await handle.run(buildPrompt(task), { timeoutMs: ctx.timeoutMs });
      const text = trimSummary(result.lastMessage ?? "");
      if (result.status === "idle") return { ...base, status: "ok", summary: text || "(no findings)" };
      if (result.status === "error") {
        return { ...base, status: "failed", summary: result.error ?? "scout failed" };
      }
      return { ...base, status: "timeout", summary: text || "(timed out with no findings)" };
    } catch (error) {
      return { ...base, status: "failed", summary: error instanceof Error ? error.message : String(error) };
    } finally {
      await handle?.archive().catch(() => undefined);
    }
  }

  async function run(cardRef: string, tasks: ScoutTask[]): Promise<ScoutRunResult> {
    if (!Array.isArray(tasks) || tasks.length === 0) {
      throw new BoardError("invalid", "tasks must be a non-empty array");
    }
    if (tasks.length > SCOUT_MAX_TASKS_PER_CALL) {
      throw new BoardError("invalid", `At most ${SCOUT_MAX_TASKS_PER_CALL} tasks per call`);
    }
    const norm: NormTask[] = tasks.map((t) => {
      const goal = String(t?.goal ?? "").trim();
      if (!goal) throw new BoardError("invalid", "Every task needs a goal");
      const kind = SCOUT_KINDS.includes(t.kind as ScoutKind) ? (t.kind as ScoutKind) : "locate";
      const paths = Array.isArray(t.paths) ? t.paths.map(String).filter(Boolean) : [];
      return { goal, kind, paths };
    });
    const card = board.cards.get(cardRef);
    const project = board.store.projects.get(card.projectId);
    const cwd = card.worktree || project?.repoPath;
    if (!cwd) throw new BoardError("invalid", `${card.key} has no worktree or project path to scout in`);

    const config = await options.getConfig();
    currentLimit = Math.min(SCOUT_MAX_PARALLEL_LIMIT, Math.max(1, Math.floor(config.maxParallel) || 4));
    const preset = pickScoutPreset(board.presets.list().presets, config.preset);
    if (!preset) {
      throw new BoardError("unavailable", "No preset available for scouts (create one or set scoutPreset)");
    }

    const head = await headOf(cwd);
    options.publish?.("scout.started", card.id, card.projectId, { scoutPresetId: preset.id });

    const results = await Promise.all(
      norm.map((task) => {
        const cacheKey = JSON.stringify([card.id, head, task.kind, task.goal, task.paths]);
        const hit = cache.get(cacheKey);
        if (hit && now() - hit.at < CACHE_TTL_MS) {
          return Promise.resolve<ScoutResult>({ ...hit.result, cached: true });
        }
        const existing = inflight.get(cacheKey);
        if (existing) return existing;
        const pending = gate
          .run(() =>
            runOne(task, { cardId: card.id, cardKey: card.key, cwd, preset, timeoutMs: config.timeoutMs }),
          )
          .then((result) => {
            if (result.status === "ok") cache.set(cacheKey, { at: now(), result });
            return result;
          })
          .finally(() => inflight.delete(cacheKey));
        inflight.set(cacheKey, pending);
        return pending;
      }),
    );

    const ok = results.filter((r) => r.status === "ok").length;
    const cached = results.filter((r) => r.cached).length;
    const summary = `Scouts (${preset.name}): ${ok}/${results.length} ok${cached ? `, ${cached} cached` : ""}. ${results
      .map((r) => `[${r.status}] ${r.goal}`)
      .join(" | ")}`;
    options.publish?.("scout.finished", card.id, card.projectId, {
      scoutPresetId: preset.id,
      outcome: ok > 0 ? "ok" : "failed",
      summary: summary.slice(0, 1000),
    });
    board.events.add(
      card.id,
      { type: "note", authorKind: "system", author: "scout", body: { kind: "scout", text: summary } },
    );
    return { preset: preset.name, results };
  }

  return { run };
}

export type ScoutService = ReturnType<typeof createScoutService>;
