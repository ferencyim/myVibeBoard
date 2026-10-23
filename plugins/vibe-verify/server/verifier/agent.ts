// The independent verifier agent: created through the Paseo SDK in the worker's workspace with
// VIBE_ROLE=verifier (board MCP: read + comment only). `VerifierLauncher` is the injection seam;
// unit tests use a scripted fake, the plugin wires `createPaseoVerifierLauncher`.

import { randomUUID } from "node:crypto";
import type { PaseoApi, PaseoAgentHandle } from "@getpaseo/client";
import { z } from "zod";
import { defaultPrompts, type PromptResolver } from "../prompts";
import {
  JudgementSchema,
  presetModels,
  isModelUnavailableError,
  classifyFailure,
  type CardView,
  type Preset,
  type Project,
  type TaskPresetSnapshot,
} from "../vibe/contract";

export interface VerifierRun {
  /** idle = the round ended normally. */
  status: "idle" | "error" | "timeout";
  text: string;
  error?: string;
}

export interface VerifierAgent {
  readonly agentId: string;
  readonly provider: string;
  readonly model?: string;
  /** Set when the launcher had to fill in a missing model (shown in the verification notes). */
  readonly note?: string;
  run(prompt: string): Promise<VerifierRun>;
  close(): Promise<void>;
}

export interface LaunchInput {
  card?: CardView;
  task?: { workspaceId: string; anchorAgentId: string };
  project: Pick<Project, "id">;
  provider: string;
  model?: string;
  thinking?: string;
  preset?: Preset;
  snapshot?: TaskPresetSnapshot;
  candidateIndex?: number;
  acquire?: (
    provider: string,
    candidateIndex: number,
  ) => Promise<{ bind(agentId: string): Promise<void>; release(): Promise<void> }>;
  onReplacement?: (agent: VerifierAgent) => void;
  onCreated?: (selection: {
    agentId: string;
    provider: string;
    model: string;
    thinking?: string;
    candidateIndex: number;
  }) => void;
  onStopped?: (agentId: string, outcome: "completed" | "failed") => void;
  cwd: string;
  workspaceId: string | null;
  outputDir: string;
  /** reviewer = model code review (same read-only guards, different prompt); default verifier. */
  role?: "verifier" | "reviewer";
}

export interface VerifierLauncher {
  launch(input: LaunchInput): Promise<VerifierAgent>;
}

/** Called by the pipeline to choose the verifier's provider; WP-32 (master) will replace this. */
export type PickVerifier = (input: {
  card: CardView;
  project: Project;
  workerProvider: string | null;
  presets: readonly Preset[];
}) => { provider: string; model?: string };

/**
 * Default: a preset whose provider differs from the worker's, else the worker's own provider.
 * With `preferDifferent` off the worker's own provider comes first.
 */
export const pickProvider =
  (preferDifferent: () => boolean = () => true): PickVerifier =>
  ({ workerProvider, presets }) => {
    const same = presets.find((p) => p.provider === workerProvider);
    const other = presets.find((p) => p.provider !== workerProvider);
    const chosen = (preferDifferent() ? other : same) ?? presets[0];
    return chosen
      ? { provider: chosen.provider, model: chosen.model || undefined }
      : { provider: workerProvider ?? "claude" };
  };

export const pickDifferentProvider: PickVerifier = pickProvider();

// --- verdict ---------------------------------------------------------------------------------

export const VerdictSchema = z.object({
  items: z.array(
    z.object({
      /** Index into the numbered check list (1-based) the prompt gave. */
      check: z.number().int().min(1),
      judgement: JudgementSchema,
      note: z.string().default(""),
      /** Evidence file names (as listed in the prompt) that support the judgement. */
      evidence: z.array(z.string()).default([]),
    }),
  ),
  summary: z.string().optional(),
});
export type Verdict = z.infer<typeof VerdictSchema>;

/** Extracts the first JSON object from text (verdict file content or a fenced final message). */
export function parseJsonLoose(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  for (const candidate of [text, fenced].filter((c): c is string => !!c)) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the brace slice below
    }
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

// --- Paseo-backed launcher -------------------------------------------------------------------

export type VerifierPaseo = Pick<PaseoApi, "workspaces" | "agents"> &
  Partial<{ providers: Pick<PaseoApi["providers"], "listModels"> }>;

/** Presets saved before the model became mandatory may have none: use the provider's default model. */
export async function defaultModelOf(
  paseo: VerifierPaseo,
  provider: string,
): Promise<string | undefined> {
  try {
    const res = await paseo.providers?.listModels(provider);
    const models = res?.models?.filter((m) => m.isSelectable !== false) ?? [];
    return (models.find((m) => m.isDefault) ?? models[0])?.id;
  } catch {
    return undefined;
  }
}

export interface PaseoLauncherOptions {
  getPaseo: () => VerifierPaseo | null;
  newAgentId?: () => string;
  /** Milliseconds, or a getter so a settings change applies to the next round (default 20 minutes). */
  roundTimeoutMs?: number | (() => number);
  prompts?: PromptResolver;
  /** Max wait for a stuck permission prompt to be answered by the policy hook. */
  pollMs?: number;
}

async function resolveNativeModel(paseo: VerifierPaseo, input: LaunchInput) {
  let model = input.model;
  let note: string | undefined;
  if (!model) {
    model = await defaultModelOf(paseo, input.provider);
    if (!model) {
      throw new Error(`预设未指定模型，${input.provider} 也没有默认模型；请编辑预设选择模型`);
    }
    note = `预设未指定模型，使用 ${input.provider} 的默认模型 ${model}。`;
  }

  return { model, note };
}
function verifierStatus(status: string): VerifierRun["status"] {
  if (status === "idle") return "idle";
  if (status === "error") return "error";
  return "timeout";
}

function nativeRequest(input: LaunchInput, agentId: string, spec: string, prompts: PromptResolver) {
  return {
    agentId,
    title: `${input.task?.workspaceId ?? input.card?.key} ${
      input.role === "reviewer" ? "代码复核" : "证据验证"
    }`,
    ...(input.task ? { parent: input.task.anchorAgentId } : {}),
    labels: {
      ...(input.task
        ? { workspaceId: input.task.workspaceId }
        : { cardKey: input.card!.key, cardId: input.card!.id }),
      role: input.role ?? "verifier",
    },
    env: {
      VIBE_ROLE: "verifier",
      ...(input.task
        ? { VIBE_WORKSPACE_ID: input.task.workspaceId }
        : { VIBE_CARD_ID: input.card!.id, VIBE_CARD_KEY: input.card!.key }),
      ...(input.snapshot?.runtimeEnv ? { VIBE_RUNTIME_ENV: input.snapshot.runtimeEnv } : {}),
    },
    config: {
      provider: spec,
      ...(input.task && input.provider === "claude" ? { modeId: "plan" } : {}),
      ...(input.task && input.provider === "codex"
        ? { options: { sandbox_mode: "read-only", approval_policy: "never" } }
        : {}),
      ...(input.thinking && input.thinking !== "default"
        ? { thinkingOptionId: input.thinking }
        : {}),
      systemPrompt:
        prompts.resolve(
          input.role === "reviewer" ? "verify.reviewer_system" : "verify.verifier_system",
          { projectId: input.project.id },
        ) + (input.snapshot?.instructions ? "\n\n" + input.snapshot.instructions : ""),
    },
  };
}

async function recordActualModel(handle: PaseoAgentHandle, input: LaunchInput, agentId: string) {
  if (input.task) {
    await handle.refresh();
    const actual = handle.current();
    if (!actual?.model) throw new Error("无法核对验证会话实际模型，保留租约等待核对");
    input.onCreated?.({
      agentId,
      provider: actual.provider,
      model: actual.model,
      thinking: actual.thinkingOptionId ?? undefined,
      candidateIndex: input.candidateIndex ?? 0,
    });
  }
}

function createSingleVerifierLauncher(options: PaseoLauncherOptions): VerifierLauncher {
  return {
    async launch(input) {
      if (!input.card && !input.task) throw new Error("验证缺少原生任务定位");
      if (input.task && input.workspaceId !== input.task.workspaceId)
        throw new Error("验证会话必须使用任务原生 workspace");
      const paseo = options.getPaseo();
      if (!paseo) throw new Error("验证需要可用的 Paseo 原生连接");
      const agentId = (options.newAgentId ?? randomUUID)();
      const { model, note } = await resolveNativeModel(paseo, input);
      const spec = model.startsWith(`${input.provider}/`) ? model : `${input.provider}/${model}`;
      const create = nativeRequest(input, agentId, spec, options.prompts ?? defaultPrompts);
      const lease = await input.acquire?.(input.provider, input.candidateIndex ?? 0);
      let handle;
      try {
        handle = input.workspaceId
          ? await paseo.workspaces.ref(input.workspaceId).agents.create(create)
          : await paseo.agents.create({ ...create, cwd: input.cwd });
      } catch (error) {
        await lease?.release();
        throw error;
      }
      await lease?.bind(agentId);
      await recordActualModel(handle, input, agentId);
      const configured = options.roundTimeoutMs;
      const roundTimeout =
        (typeof configured === "function" ? configured() : configured) ?? 20 * 60_000;

      let failed = false;
      let closed = false;
      return {
        agentId,
        provider: input.provider,
        model,
        note,
        async run(prompt) {
          let result = await handle.run(prompt, {
            timeoutMs: roundTimeout,
            ...(input.task ? { sourceAgentId: input.task.anchorAgentId } : {}),
          });
          // "permission": the round paused on a request; the policy hook answers it, then we resume.
          const deadline = Date.now() + roundTimeout;
          while (result.status === "permission" && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, options.pollMs ?? 500));
            result = await handle.waitForFinish(Math.max(1_000, deadline - Date.now()));
          }
          const status = verifierStatus(result.status);
          failed = status !== "idle";
          return {
            status,
            text: result.lastMessage ?? "",
            error: result.error ?? undefined,
          };
        },
        async close() {
          if (closed) return;
          if (!input.task) {
            await handle.archive().catch(() => undefined);
            closed = true;
            return;
          }
          // A timeout does not prove that the native agent stopped. Keep its resource lease.
          await handle.refresh();
          if (
            !handle.current() ||
            handle.activeTurn ||
            (handle.status !== "idle" && handle.status !== "error")
          )
            throw new Error("验证 agent 尚未停止，保留资源租约");
          input.onStopped?.(agentId, failed ? "failed" : "completed");
          await lease?.release();
          closed = true;
        },
      };
    },
  };
}

/** A replacement receives earlier prompts and replies so evidence setup remains available. */
export function createPaseoVerifierLauncher(options: PaseoLauncherOptions): VerifierLauncher {
  const single = createSingleVerifierLauncher(options);
  return {
    async launch(input) {
      const unavailable = (error: unknown) => {
        if (!input.task) return isModelUnavailableError(error);
        const message = error instanceof Error ? error.message : String(error);
        const category = classifyFailure(message);
        if (category !== "unavailable") return category !== "other";
        return /provider[^.\n]{0,40}(?:unavailable|not (?:installed|available|found)|disabled)|service unavailable|temporarily unavailable|overloaded|rate[_ ]limit|\b(?:429|502|503|504|529)\b|econnrefused|econnreset|etimedout|network error|socket hang up|stream disconnected/i.test(
          message,
        );
      };
      const candidates =
        input.snapshot?.models ??
        (input.preset
          ? presetModels(input.preset)
          : [{ provider: input.provider, model: input.model }]);
      let index = 0;
      let current: VerifierAgent;
      const history: string[] = [];
      const exhausted = (error: unknown) =>
        new Error(
          `预设中的模型均不可用：${error instanceof Error ? error.message : String(error)}`,
        );
      const start = async (): Promise<VerifierAgent> => {
        for (;;) {
          const candidate = candidates[index];
          if (!candidate) throw exhausted("没有候选模型");
          try {
            return await single.launch({ ...input, ...candidate, candidateIndex: index });
          } catch (error) {
            if (!unavailable(error)) throw error;
            if (++index >= candidates.length) throw exhausted(error);
          }
        }
      };
      current = await start();
      return {
        get agentId() {
          return current.agentId;
        },
        get provider() {
          return current.provider;
        },
        get model() {
          return current.model;
        },
        get note() {
          return index > 0
            ? `按预设顺序切换至 ${current.provider}/${current.model ?? ""}${current.note ? `：${current.note}` : ""}`
            : current.note;
        },
        async run(prompt) {
          let nextPrompt = prompt;
          for (;;) {
            let result: VerifierRun;
            try {
              result = await current.run(nextPrompt);
            } catch (error) {
              if (!isModelUnavailableError(error)) throw error;
              result = {
                status: "error",
                text: "",
                error: error instanceof Error ? error.message : String(error),
              };
            }
            if (result.status !== "error" || !unavailable(result.error)) {
              history.push(`用户：${prompt}\n助手：${result.text}`);
              return result;
            }
            if (result.text)
              history.push(`用户：${prompt}\n助手（模型不可用前的输出）：${result.text}`);
            await current.close();
            if (++index >= candidates.length)
              return { ...result, error: exhausted(result.error).message };
            current = await start();
            input.onReplacement?.(current);
            nextPrompt = history.length
              ? `以下为此前验证对话，请保留上下文继续。\n${history.join(
                  "\n\n",
                )}\n\n当前请求：\n${prompt}`
              : prompt;
          }
        },
        async close() {
          await current.close();
        },
      };
    },
  };
}
