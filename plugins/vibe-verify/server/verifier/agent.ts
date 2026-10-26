// The verifier/reviewer is an ordinary task tab; its read-only requirement lives in the role
// prompt. `VerifierLauncher` is the injection seam; unit tests use a scripted fake, the plugin
// wires `createPaseoVerifierLauncher`.

import type { PaseoAgent, PaseoAgentHandle, PaseoApi } from "@getpaseo/client";
import { z } from "zod";
import { defaultPrompts, type PromptResolver } from "../prompts";
import {
  JudgementSchema,
  presetModels,
  isModelUnavailableError,
  classifyFailure,
  taskRoleModeId,
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
  readonly source?: {
    sourceKey?: string;
    memberId: string;
    backendAgentId: string;
    sourceTurnId?: string;
    epoch?: string;
    seq?: number;
    messageId?: string;
  };
  /** True when the round ran in the task's existing role tab instead of a newly created one. */
  readonly reused: boolean;
  run(prompt: string): Promise<VerifierRun>;
  close(): Promise<void>;
}

export interface LaunchInput {
  task: {
    workspaceId: string;
    confirmedAt?: string;
    commitHash?: string;
  };
  project: Pick<Project, "id">;
  provider: string;
  model?: string;
  thinking?: string;
  preset?: Preset;
  snapshot?: TaskPresetSnapshot;
  candidateIndex?: number;
  /** A known failed member from an older confirmation cannot be reused in this round. */
  forceNewMember?: boolean;
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
  onStopped?: (agentId: string, outcome: "completed" | "failed", reused: boolean) => void;
  previousSessionId?: () => string | undefined;
  cwd: string;
  workspaceId: string | null;
  outputDir: string;
  /** Provenance for plugin prompts: the task anchor (#1), never the verifier itself. */
  sourceAgentId?: string;
  /** reviewer = model code review (same read-only prompt requirement, different prompt); default verifier. */
  role?: "verifier" | "reviewer";
  /** Pre-created role tab to reuse instead of opening a new top-level tab. */
  reuseAgentId?: string;
}

export interface VerifierLauncher {
  launch(input: LaunchInput): Promise<VerifierAgent>;
}

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
  /** Milliseconds, or a getter so a settings change applies to the next round (default 20 minutes). */
  roundTimeoutMs?: number | (() => number);
  prompts?: PromptResolver;
  /** Max wait for a stuck permission prompt to be answered by the policy hook. */
  pollMs?: number;
  log?: (message: string, error?: unknown) => void;
  /** Claims the new native agent as the task's referee tab (role, model and title). */
  claimTab?: (input: {
    workspaceId: string;
    agentId: string;
    role: "verifier" | "reviewer";
    provider: string;
    model: string;
    thinking?: string;
    presetId?: string;
  }) => Promise<void>;
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

function taskEvidenceEnv(task: LaunchInput["task"]): Record<string, string> {
  return task.commitHash ? { VIBE_VERIFICATION_COMMIT: task.commitHash } : {};
}

export function nativeConfig(input: LaunchInput, prompt: string) {
  // Read-only roles rely on their role prompt. The mode comes from the same rule vibe-board uses
  // for the pre-created reviewer/verifier tabs.
  const modeId = taskRoleModeId(input.role ?? "verifier", input.provider, "auto");
  return {
    ...(modeId ? { modeId } : {}),
    ...(input.thinking && input.thinking !== "default"
      ? { thinkingOptionId: input.thinking }
      : {}),
    systemPrompt: prompt,
  };
}

/** Whether the agent already ran any turn (pre-created tabs have an empty timeline). */
async function hasHistory(handle: PaseoAgentHandle): Promise<boolean> {
  const page = await handle.timeline.refetch({ direction: "tail", limit: 5 });
  return (page.entries ?? []).some((entry) =>
    ["user_message", "assistant_message", "tool_call"].includes(
      (entry as { item?: { type?: string } }).item?.type ?? "",
    ),
  );
}

async function tabVerifier(
  options: PaseoLauncherOptions,
  paseo: VerifierPaseo,
  input: LaunchInput,
  model: string,
  note?: string,
): Promise<VerifierAgent> {
  if (input.workspaceId !== input.task.workspaceId)
    throw new Error("验证 tab 必须使用任务原生 workspace");
  const role = input.role ?? "verifier";
  const prompts = options.prompts ?? defaultPrompts;
  const prompt =
    prompts.resolve(role === "reviewer" ? "verify.reviewer_system" : "verify.verifier_system", {
      projectId: input.project.id,
    }) + (input.snapshot?.instructions ? "\n\n" + input.snapshot.instructions : "");
  const spec = model.startsWith(`${input.provider}/`) ? model : `${input.provider}/${model}`;
  const modelId = spec.slice(spec.indexOf("/") + 1);
  let handle: PaseoAgentHandle | undefined;
  let actual: PaseoAgent | undefined;
  let reused = false;
  // Reuse the task's pre-created reviewer/verifier tab only while it is still blank: a tab that
  // already ran a turn carries another round's context, which would cost the round its
  // independence. Busy, mismatched or used tabs, and rounds that must start a new member, fall
  // back to a new top-level tab.
  if (input.reuseAgentId && !input.forceNewMember) {
    const candidate = paseo.agents.ref(input.reuseAgentId);
    try {
      await candidate.refresh();
      let current = candidate.current();
      if (current?.status === "closed") {
        await candidate.resume();
        await candidate.refresh();
        current = candidate.current();
      }
      const used = current ? await hasHistory(candidate) : false;
      if (
        current &&
        !current.archivedAt &&
        !current.activeTurn &&
        current.model === modelId &&
        !used
      ) {
        handle = candidate;
        actual = current;
        reused = true;
      } else {
        options.log?.(
          "复用" +
            role +
            " tab 失败：" +
            (current?.activeTurn
              ? "仍在运行"
              : current?.archivedAt
                ? "已归档"
                : used
                  ? "已有对话历史"
                  : "模型不一致") +
            "，改用新 tab",
        );
      }
    } catch (error) {
      options.log?.("复用" + role + " tab 失败，改用新 tab", error);
    }
  }
  if (!handle) {
    handle = await paseo.workspaces.ref(input.task.workspaceId).agents.create({
      config: { provider: spec as never, ...nativeConfig(input, prompt) } as never,
      env: {
        VIBE_ROLE: role,
        VIBE_WORKSPACE_ID: input.task.workspaceId,
        ...(input.snapshot?.runtimeEnv ? { VIBE_RUNTIME_ENV: input.snapshot.runtimeEnv } : {}),
        ...taskEvidenceEnv(input.task),
      },
      labels: {
        "vibe.tab.role": role,
        ...(input.snapshot?.presetId ? { "vibe.tab.preset": input.snapshot.presetId } : {}),
      },
      title: role === "reviewer" ? "代码复核" : "证据验证",
    });
    await handle.refresh();
    actual = handle.current() ?? undefined;
  }
  if (!handle || !actual?.model) throw new Error("无法核对验证 tab 的实际模型，保留资源等待核对");
  const tabHandle = handle;
  const tabAgent = actual;
  const tabModel = actual.model;
  const lease = input.acquire
    ? await input.acquire(tabAgent.provider, input.candidateIndex ?? 0)
    : undefined;
  try {
    await lease?.bind(tabHandle.id);
  } catch (error) {
    await lease?.release().catch(() => {});
    throw error;
  }
  await options.claimTab?.({
    workspaceId: input.task.workspaceId,
    agentId: tabHandle.id,
    role,
    provider: tabAgent.provider,
    model: tabModel,
    thinking: tabAgent.thinkingOptionId ?? undefined,
    ...(input.snapshot?.presetId ? { presetId: input.snapshot.presetId } : {}),
  });
  input.onCreated?.({
    agentId: tabHandle.id,
    provider: tabAgent.provider,
    model: tabModel,
    thinking: tabAgent.thinkingOptionId ?? undefined,
    candidateIndex: input.candidateIndex ?? 0,
  });
  const configured = options.roundTimeoutMs;
  const roundTimeout =
    (typeof configured === "function" ? configured() : configured) ?? 20 * 60_000;
  let failed = false;
  let closed = false;
  let rolePromptSent = false;
  let source: VerifierAgent["source"];
  let lastAssistantSeq = Number.NEGATIVE_INFINITY;
  async function captureSource() {
    const page = await tabHandle.timeline.refetch({ direction: "tail", limit: 60 });
    const entries = page.entries as readonly {
      item: { type: string; messageId?: string };
      turnId?: string | null;
      seqEnd: number;
    }[];
    const entry = [...entries]
      .reverse()
      .find(
        (candidate) =>
          candidate.item.type === "assistant_message" && candidate.seqEnd > lastAssistantSeq,
      );
    if (!entry) return undefined;
    lastAssistantSeq = entry.seqEnd;
    return {
      memberId: tabHandle.id,
      backendAgentId: tabHandle.id,
      epoch: page.epoch,
      seq: entry.seqEnd,
      ...(entry.turnId ? { sourceTurnId: entry.turnId } : {}),
      ...(entry.item.messageId ? { messageId: entry.item.messageId } : {}),
    };
  }
  return {
    agentId: tabHandle.id,
    provider: tabAgent.provider,
    model: tabModel,
    note,
    reused,
    get source() {
      return source;
    },
    async run(text) {
      if (closed) throw new Error("验证 tab 已收口");
      const deadline = Date.now() + roundTimeout;
      // A reused tab was created without this round's system prompt; its first message carries
      // the role rules. Evidence (commit, worktree, checks) always travels in the round prompt.
      const message = reused && !rolePromptSent ? `${prompt}\n\n${text}` : text;
      rolePromptSent = true;
      await tabHandle.send(message, { sourceAgentId: input.sourceAgentId ?? tabHandle.id });
      let finished = await tabHandle.waitForFinish(Math.max(1_000, deadline - Date.now()));
      while (finished.status === "permission" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 500));
        finished = await tabHandle.waitForFinish(Math.max(1_000, deadline - Date.now()));
      }
      const status = verifierStatus(finished.status);
      failed = status !== "idle";
      if (status === "idle") source = (await captureSource()) ?? source;
      return {
        status,
        text: finished.lastMessage ?? "",
        error: finished.error ?? undefined,
      };
    },
    async close() {
      if (closed) return;
      await tabHandle.refresh();
      const current = tabHandle.current();
      if (
        !current ||
        tabHandle.activeTurn ||
        (tabHandle.status !== "idle" && tabHandle.status !== "error")
      )
        throw new Error("验证 tab 尚未停止，保留资源租约");
      await lease?.release();
      input.onStopped?.(tabHandle.id, failed ? "failed" : "completed", reused);
      closed = true;
    },
  };
}

function createSingleVerifierLauncher(options: PaseoLauncherOptions): VerifierLauncher {
  return {
    async launch(input) {
      if (input.workspaceId !== input.task.workspaceId)
        throw new Error("验证 tab 必须使用任务原生 workspace");
      const paseo = options.getPaseo();
      if (!paseo) throw new Error("验证需要可用的 Paseo 原生连接");
      const { model, note } = await resolveNativeModel(paseo, input);
      return tabVerifier(options, paseo, input, model, note);
    },
  };
}

/** A replacement receives earlier prompts and replies so evidence setup remains available. */
export function createPaseoVerifierLauncher(options: PaseoLauncherOptions): VerifierLauncher {
  const single = createSingleVerifierLauncher(options);
  return {
    async launch(input) {
      const unavailable = (error: unknown) => {
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
      let index = input.candidateIndex ?? 0;
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
        get reused() {
          return current.reused;
        },
        get note() {
          return index > 0
            ? `按预设顺序切换至 ${current.provider}/${current.model ?? ""}${current.note ? `：${current.note}` : ""}`
            : current.note;
        },
        get source() {
          return current.source;
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
