// The independent verifier agent: created through the Paseo SDK in the worker's workspace with
// VIBE_ROLE=verifier (board MCP: read + comment only). `VerifierLauncher` is the injection seam;
// unit tests use a scripted fake, the plugin wires `createPaseoVerifierLauncher`.

import { randomUUID } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import { z } from "zod";
import { JudgementSchema, type CardView, type Preset, type Project } from "../vibe/contract";

export interface VerifierRun {
  /** idle = the round ended normally. */
  status: "idle" | "error" | "timeout";
  text: string;
  error?: string;
}

export interface VerifierAgent {
  readonly agentId: string;
  readonly provider: string;
  run(prompt: string): Promise<VerifierRun>;
  close(): Promise<void>;
}

export interface LaunchInput {
  card: CardView;
  project: Project;
  provider: string;
  model?: string;
  cwd: string;
  workspaceId: string | null;
  outputDir: string;
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

/** Default: a preset whose provider differs from the worker's, else the worker's own provider. */
export const pickDifferentProvider: PickVerifier = ({ workerProvider, presets }) => {
  const other = presets.find((p) => p.provider !== workerProvider);
  const chosen = other ?? presets[0];
  return chosen
    ? { provider: chosen.provider, model: chosen.model || undefined }
    : { provider: workerProvider ?? "claude" };
};

export const VERIFIER_SYSTEM_PROMPT = `You are an independent verifier for a kanban card. Another agent wrote the change; you did not.
You are READ-ONLY with respect to the repository: never edit, create, move or delete files in the working tree, never run git commands that change state (add, commit, checkout, reset, stash, ...), never install dependencies. Your only writable location is the output directory given in the task. Judge what the change actually does, not what it claims.`;

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

export type VerifierPaseo = Pick<PaseoApi, "workspaces" | "agents">;

export interface PaseoLauncherOptions {
  getPaseo: () => VerifierPaseo | null;
  newAgentId?: () => string;
  roundTimeoutMs?: number;
  /** Max wait for a stuck permission prompt to be answered by the policy hook. */
  pollMs?: number;
}

export function createPaseoVerifierLauncher(options: PaseoLauncherOptions): VerifierLauncher {
  return {
    async launch(input) {
      const paseo = options.getPaseo();
      if (!paseo) throw new Error("Verification needs an active Paseo daemon connection");
      const agentId = (options.newAgentId ?? randomUUID)();
      const spec = input.model
        ? input.model.startsWith(`${input.provider}/`)
          ? input.model
          : `${input.provider}/${input.model}`
        : input.provider;
      const create = {
        agentId,
        title: `${input.card.key} verify`,
        labels: { cardKey: input.card.key, cardId: input.card.id, role: "verifier" },
        env: { VIBE_ROLE: "verifier", VIBE_CARD_ID: input.card.id, VIBE_CARD_KEY: input.card.key },
        config: { provider: spec, systemPrompt: VERIFIER_SYSTEM_PROMPT },
      };
      const handle = input.workspaceId
        ? await paseo.workspaces.ref(input.workspaceId).agents.create(create)
        : await paseo.agents.create({ ...create, cwd: input.cwd });
      const roundTimeout = options.roundTimeoutMs ?? 20 * 60_000;

      return {
        agentId,
        provider: input.provider,
        async run(prompt) {
          let result = await handle.run(prompt, { timeoutMs: roundTimeout });
          // "permission": the round paused on a request; the policy hook answers it, then we resume.
          const deadline = Date.now() + roundTimeout;
          while (result.status === "permission" && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, options.pollMs ?? 500));
            result = await handle.waitForFinish(Math.max(1_000, deadline - Date.now()));
          }
          const status =
            result.status === "idle" ? "idle" : result.status === "error" ? "error" : "timeout";
          return { status, text: result.lastMessage ?? "", error: result.error ?? undefined };
        },
        async close() {
          await handle.archive().catch(() => undefined);
        },
      };
    },
  };
}
