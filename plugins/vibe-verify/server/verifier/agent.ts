// The independent verifier agent: created through the Paseo SDK in the worker's workspace with
// VIBE_ROLE=verifier (board MCP: read + comment only). `VerifierLauncher` is the injection seam;
// unit tests use a scripted fake, the plugin wires `createPaseoVerifierLauncher`.

import { randomUUID } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import { z } from "zod";
import { defaultPrompts, type PromptResolver } from "../prompts";
import {
  JudgementSchema,
  presetModels,
  isModelUnavailableError,
  type CardView,
  type Preset,
  type Project,
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
  card: CardView;
  project: Project;
  provider: string;
  model?: string;
  thinking?: string;
  preset?: Preset;
  onReplacement?: (agent: VerifierAgent) => void;
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
    })
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
  provider: string
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

function createSingleVerifierLauncher(
  options: PaseoLauncherOptions
): VerifierLauncher {
  return {
    async launch(input) {
      const paseo = options.getPaseo();
      if (!paseo)
        throw new Error("Verification needs an active Paseo daemon connection");
      const agentId = (options.newAgentId ?? randomUUID)();
      let model = input.model;
      let note: string | undefined;
      if (!model) {
        model = await defaultModelOf(paseo, input.provider);
        if (!model) {
          throw new Error(
            `The preset has no model and ${input.provider} offers no default model; edit the preset and pick one`
          );
        }
        note = `The preset has no model; using ${input.provider}'s default model ${model}.`;
      }
      const spec = model.startsWith(`${input.provider}/`)
        ? model
        : `${input.provider}/${model}`;
      const create = {
        agentId,
        title: `${input.card.key} ${
          input.role === "reviewer" ? "review" : "verify"
        }`,
        labels: {
          cardKey: input.card.key,
          cardId: input.card.id,
          role: input.role ?? "verifier",
        },
        env: {
          VIBE_ROLE: "verifier",
          VIBE_CARD_ID: input.card.id,
          VIBE_CARD_KEY: input.card.key,
        },
        config: {
          provider: spec,
          ...(input.thinking && input.thinking !== "default" ? { thinkingOptionId: input.thinking } : {}),
          systemPrompt: (options.prompts ?? defaultPrompts).resolve(
            input.role === "reviewer"
              ? "verify.reviewer_system"
              : "verify.verifier_system",
            { projectId: input.project.id }
          ),
        },
      };
      const handle = input.workspaceId
        ? await paseo.workspaces.ref(input.workspaceId).agents.create(create)
        : await paseo.agents.create({ ...create, cwd: input.cwd });
      const configured = options.roundTimeoutMs;
      const roundTimeout =
        (typeof configured === "function" ? configured() : configured) ??
        20 * 60_000;

      return {
        agentId,
        provider: input.provider,
        model,
        note,
        async run(prompt) {
          let result = await handle.run(prompt, { timeoutMs: roundTimeout });
          // "permission": the round paused on a request; the policy hook answers it, then we resume.
          const deadline = Date.now() + roundTimeout;
          while (result.status === "permission" && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, options.pollMs ?? 500));
            result = await handle.waitForFinish(
              Math.max(1_000, deadline - Date.now())
            );
          }
          const status =
            result.status === "idle"
              ? "idle"
              : result.status === "error"
              ? "error"
              : "timeout";
          return {
            status,
            text: result.lastMessage ?? "",
            error: result.error ?? undefined,
          };
        },
        async close() {
          await handle.archive().catch(() => undefined);
        },
      };
    },
  };
}

/** A replacement receives earlier prompts and replies so evidence setup remains available. */
export function createPaseoVerifierLauncher(
  options: PaseoLauncherOptions
): VerifierLauncher {
  const single = createSingleVerifierLauncher(options);
  return {
    async launch(input) {
      const candidates = input.preset
        ? presetModels(input.preset)
        : [{ provider: input.provider, model: input.model }];
      let index = 0;
      let current: VerifierAgent;
      const history: string[] = [];
      const exhausted = (error: unknown) =>
        new Error(
          `预设中的模型均不可用：${
            error instanceof Error ? error.message : String(error)
          }`
        );
      const start = async (): Promise<VerifierAgent> => {
        for (;;) {
          const candidate = candidates[index];
          if (!candidate) throw exhausted("没有候选模型");
          try {
            return await single.launch({ ...input, ...candidate });
          } catch (error) {
            if (!isModelUnavailableError(error)) throw error;
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
        get model() { return current.model; },
        get note() {
          return index > 0 ? `按预设顺序切换至 ${current.provider}/${current.model ?? ""}${current.note ? `：${current.note}` : ""}` : current.note;
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
            if (
              result.status !== "error" ||
              !isModelUnavailableError(result.error)
            ) {
              history.push(`用户：${prompt}\n助手：${result.text}`);
              return result;
            }
            if (result.text) history.push(`用户：${prompt}\n助手（模型不可用前的输出）：${result.text}`);
            await current.close();
            if (++index >= candidates.length)
              return { ...result, error: exhausted(result.error).message };
            current = await start();
            input.onReplacement?.(current);
            nextPrompt = history.length
              ? `以下为此前验证对话，请保留上下文继续。\n${history.join(
                  "\n\n"
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
