// Scout (WP-81): lets an execution session (expensive model) fan out cheap, read-only sub-agents
// that locate files, take inventories or research, and get back only compact findings.
//
// Exposed to agents as the MCP tool `vibe_scout` (server/mcp/tools.ts). Scouts are labelled
// role=scout so vibe-stats can tell their usage apart from workers'.

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import { selectAgent, type AgentProfile, type Preset, type SelectContext } from "../vibe/contract";
import { BoardError, type BoardService } from "../service";
import { postChat } from "../chat/post";
import { ensurePresetModel } from "../dispatch/model";
import { defaultPrompts, type PromptResolver } from "../prompts";

export type ScoutPaseo = Pick<PaseoApi, "agents"> & {
  providers?: Pick<PaseoApi["providers"], "listModes" | "listModels">;
};

export const SCOUT_KINDS = ["locate", "inventory", "research"] as const;
export type ScoutKind = (typeof SCOUT_KINDS)[number];

export const SCOUT_MAX_PARALLEL_LIMIT = 16;
/** Default and upper bound of tasks per vibe_scout call (the setting scoutMaxTasksPerCall picks the actual cap). */
export const SCOUT_MAX_TASKS_PER_CALL = 16;
export const SCOUT_MAX_TASKS_LIMIT = 64;
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
  /** Defaults: 20 lines, 10 minutes (0 = no cache), 16 tasks. */
  summaryMaxLines?: number;
  cacheTtlMs?: number;
  maxTasksPerCall?: number;
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
  /** Default process.platform; decides whether codex can use its read-only sandbox. */
  platform?: string;
  /** HEAD commit of a directory (cache key). Default: git rev-parse. */
  headOf?: (cwd: string) => Promise<string>;
  now?: () => number;
  /** Prompt registry (default texts when omitted). */
  prompts?: PromptResolver;
}

/** Default system prompt of a scout (the owner may override it, see server/prompts). */
export const SCOUT_SYSTEM_PROMPT = defaultPrompts.resolve("board.scout_system", {
  vars: { maxLines: String(SUMMARY_MAX_LINES) },
});

/**
 * Read-only settings per provider: claude has a "plan" mode; codex has no read-only mode id, so
 * its sandbox is set through provider options (never asks, never writes). The codex read-only
 * sandbox cannot run shell commands on Windows (read-only: fails to initialise, workspace-write:
 * stalls; both verified), so there it runs unsandboxed (full-access) with only the prompt forbidding
 * writes. Other providers keep their default and rely on the prompt.
 */
export function readOnlyConfigFor(
  provider: string,
  platform: string = process.platform,
): {
  modeId?: string;
  options?: Record<string, unknown>;
} {
  const p = provider.toLowerCase();
  if (p === "claude") return { modeId: "plan" };
  if (p === "codex") {
    return platform === "win32"
      ? { modeId: "full-access" }
      : { options: { sandbox_mode: "read-only", approval_policy: "never" } };
  }
  return {};
}

export interface ReadOnlySetup {
  config: { modeId?: string; options?: Record<string, unknown> };
  /** true = the provider itself blocks writes; false = only the prompt forbids them. */
  strict: boolean;
}

const READ_ONLY_MODE = /^(plan|read[-_ ]?only)$/i;

/** Read-only setup per provider; unknown providers are strict only if listModes offers plan/read-only. */
export async function resolveReadOnly(
  provider: string,
  paseo: ScoutPaseo | null,
  platform: string = process.platform,
): Promise<ReadOnlySetup> {
  const p = provider.toLowerCase();
  const config = readOnlyConfigFor(p, platform);
  if (p === "claude") return { config, strict: true };
  if (p === "codex") return { config, strict: platform !== "win32" };
  try {
    const res = await paseo?.providers?.listModes?.(p);
    const mode = res?.modes?.find((m) => READ_ONLY_MODE.test(m.id));
    if (mode) return { config: { modeId: mode.id }, strict: true };
  } catch {
    // no catalog: fall through to prompt-only
  }
  return { config, strict: false };
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

/** setting -> roleHints includes scout -> cheapest by the shared selector. */
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
  const hinted = presets.find((p) => p.roleHints.includes("scout"));
  if (hinted) return hinted;
  if (presets.length === 0) return null;
  const selection = selectAgent(presets.map(profileOf), { tags: ["scout"], size: "S", priority: "low" }, ctx);
  return presets.find((p) => p.id === selection.agentId) ?? null;
}

/** Keeps the first `max` non-empty lines. */
export function trimSummary(text: string, max: number = SUMMARY_MAX_LINES): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim());
  const kept = lines.slice(0, max);
  if (lines.length > kept.length) kept.push(`... (${lines.length - kept.length} more lines cut)`);
  return kept.join("\n");
}

type NormTask = { goal: string; kind: ScoutKind; paths: string[] };

function buildPrompt(
  task: NormTask,
  prompts: PromptResolver,
  maxLines: number,
  projectId: string,
): string {
  const how = prompts.resolve(`board.scout_how.${task.kind}`, { projectId });
  return prompts.resolve("board.scout_task", {
    projectId,
    vars: {
      kind: task.kind,
      how,
      goal: task.goal,
      restrict: task.paths.length ? `限定范围：${task.paths.join(", ")}
` : "",
      maxLines: String(maxLines),
    },
  });
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
  const prompts = options.prompts ?? defaultPrompts;
  let currentLimit = 4;
  const gate = new Semaphore(() => currentLimit);
  const cache = new Map<string, { at: number; result: ScoutResult }>();
  const inflight = new Map<string, Promise<ScoutResult>>();

  async function runOne(
    task: NormTask,
    ctx: { cardId: string; projectId: string; maxLines: number; cardKey: string; cwd: string; preset: Preset; readOnly: ReadOnlySetup; timeoutMs: number },
  ): Promise<ScoutResult> {
    const base = { goal: task.goal, kind: task.kind };
    const paseo = options.getPaseo();
    if (!paseo) return { ...base, status: "failed", summary: "No active Paseo daemon connection" };
    const readOnly = ctx.readOnly.config;
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
          systemPrompt: prompts.resolve("board.scout_system", { vars: { maxLines: String(ctx.maxLines) } }),
          ...readOnly,
        },
      });
      const result = await handle.run(buildPrompt(task, prompts, ctx.maxLines, ctx.projectId), {
        timeoutMs: ctx.timeoutMs,
      });
      const text = trimSummary(result.lastMessage ?? "", ctx.maxLines);
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
    const config = await options.getConfig();
    const maxTasks = config.maxTasksPerCall ?? SCOUT_MAX_TASKS_PER_CALL;
    if (tasks.length > maxTasks) {
      throw new BoardError("invalid", `At most ${maxTasks} tasks per call`);
    }
    const maxLines = config.summaryMaxLines ?? SUMMARY_MAX_LINES;
    const cacheTtlMs = config.cacheTtlMs ?? CACHE_TTL_MS;
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

    currentLimit = Math.min(SCOUT_MAX_PARALLEL_LIMIT, Math.max(1, Math.floor(config.maxParallel) || 4));
    const presets = board.presets.list().presets;
    const platform = options.platform ?? process.platform;
    let preset = pickScoutPreset(presets, config.preset);
    if (!preset) {
      throw new BoardError("unavailable", "No preset available for scouts (create one or set scoutPreset)");
    }
    let readOnly = await resolveReadOnly(preset.provider, options.getPaseo(), platform);
    const explicit = !!config.preset.trim() && presets.some((p) => p.id === config.preset.trim() || p.name.toLowerCase() === config.preset.trim().toLowerCase());
    // Windows: codex has no working read-only sandbox, so prefer a preset whose provider can really block writes.
    if (!readOnly.strict && !explicit && platform === "win32") {
      const setups = new Map<string, ReadOnlySetup>();
      for (const candidate of presets) {
        const key = candidate.provider.toLowerCase();
        if (!setups.has(key)) setups.set(key, await resolveReadOnly(key, options.getPaseo(), platform));
      }
      const strictPresets = presets.filter((c) => setups.get(c.provider.toLowerCase())?.strict);
      const better = pickScoutPreset(strictPresets, "");
      if (better) {
        preset = better;
        readOnly = setups.get(better.provider.toLowerCase())!;
      }
    }

    let modelNote: string | null = null;
    try {
      const filled = await ensurePresetModel(options.getPaseo(), preset);
      preset = filled.preset;
      modelNote = filled.note;
    } catch (error) {
      throw new BoardError("unavailable", error instanceof Error ? error.message : String(error));
    }

    const head = await headOf(cwd);
    options.publish?.("scout.started", card.id, card.projectId, { scoutPresetId: preset.id, strictReadOnly: readOnly.strict });

    const results = await Promise.all(
      norm.map((task) => {
        const cacheKey = JSON.stringify([card.id, head, task.kind, task.goal, task.paths]);
        const hit = cache.get(cacheKey);
        if (hit && now() - hit.at < cacheTtlMs) {
          return Promise.resolve<ScoutResult>({ ...hit.result, cached: true });
        }
        const existing = inflight.get(cacheKey);
        if (existing) return existing;
        const pending = gate
          .run(() =>
            runOne(task, { cardId: card.id, projectId: card.projectId, maxLines, cardKey: card.key, cwd, preset, readOnly, timeoutMs: config.timeoutMs }),
          )
          .then((result) => {
            if (result.status === "ok" && cacheTtlMs > 0) cache.set(cacheKey, { at: now(), result });
            return result;
          })
          .finally(() => inflight.delete(cacheKey));
        inflight.set(cacheKey, pending);
        return pending;
      }),
    );

    const ok = results.filter((r) => r.status === "ok").length;
    const cached = results.filter((r) => r.cached).length;
    const summary = `Scouts (${preset.name}${readOnly.strict ? "" : ", NOT strictly read-only: prompt-enforced"}): ${ok}/${results.length} ok${cached ? `, ${cached} cached` : ""}. ${results
      .map((r) => `[${r.status}] ${r.goal}`)
      .join(" | ")}${modelNote ? " " + modelNote : ""}`;
    options.publish?.("scout.finished", card.id, card.projectId, {
      scoutPresetId: preset.id,
      strictReadOnly: readOnly.strict,
      outcome: ok > 0 ? "ok" : "failed",
      summary: summary.slice(0, 1000),
    });
    // Cached answers were written to the chat when they were first found.
    if (results.some((r) => !r.cached)) {
      const goals = results.map((r) => r.goal).join("；");
      postChat(board.store, {
        cardId: card.id,
        authorKind: "scout",
        author: preset.name,
        kind: "summary",
        text: `探路兵（${preset.name}）完成 ${ok}/${results.length} 项：${goals}`.slice(0, 600),
        detail: [summary, ...results.map((r) => `### ${r.goal} [${r.status}]\n${r.summary}`)].join("\n\n"),
        key: `scout:${now()}:${createHash("sha256").update(JSON.stringify([card.id, goals])).digest("hex").slice(0, 10)}`,
      });
    }
    return { preset: preset.name, results };
  }

  return { run };
}

export type ScoutService = ReturnType<typeof createScoutService>;
