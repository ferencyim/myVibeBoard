// Master dispatch (WP-109). vibe-scheduler asks (`scheduler.dispatch_wanted`) which of the cards that
// passed its checks should start in the free slots; the master answers with an ordered pick
// (`master.dispatch_chosen`) or says why it cannot (`master.dispatch_failed`). The master never
// dispatches by itself: the scheduler admits the pick through its normal checks, so slots,
// conflicts and limits cannot be bypassed. Whatever goes wrong here ends in a failed answer, and the
// scheduler then dispatches by its own rules, so a waiting card is never stuck on the master.

import { z } from "zod";
import { parseReply } from "../assess/parse";
import { buildRepairMessage } from "../master/prompts";
import { defaultPromptPort, type PromptPort } from "../prompts/port";
import { defaultTuning, type TuningSource } from "../tuning";
import { MasterError, type MasterAsk } from "../types";
import { pickPresetId, type CardView } from "../vibe/contract";
import { publishEvent, type VibeDb, type VibeStore } from "../vibe/db";

const Reply = z.object({
  /** Card keys, first to dispatch first. */
  order: z.array(z.string()).default([]),
  reason: z.string().default(""),
});

export interface DispatchRequest {
  requestId: string;
  slots: number;
  cardIds: string[];
}

export interface DispatcherDeps {
  db: VibeDb;
  store: VibeStore;
  master: MasterAsk;
  /** Runs `fn` between the master's other jobs (the master has one conversation). */
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
  prompts?: PromptPort;
  tuning?: TuningSource;
  /** Owner switches: the master is enabled and master dispatch is on. */
  enabled(): boolean;
  /** Seconds one question may take (settings). */
  timeoutSeconds(): number;
  now?: () => Date;
  log?: (message: string, error?: unknown) => void;
}

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const FAILURE_TEXT: Record<string, string> = {
  unavailable: "总 agent 暂不可用",
  quota: "总 agent 的额度已用完",
  timeout: "总 agent 没有及时回复",
  permission: "总 agent 在等待权限批准",
  agent: "总 agent 出错",
};

export function failureReason(error: unknown): string {
  if (error instanceof MasterError) {
    return `${FAILURE_TEXT[error.kind] ?? "总 agent 出错"}：${clip(error.message, 160)}`;
  }
  return `总 agent 出错：${clip(error instanceof Error ? error.message : String(error), 160)}`;
}

export function createDispatcher(deps: DispatcherDeps) {
  const { store } = deps;
  const prompts = deps.prompts ?? defaultPromptPort();
  const tuning = deps.tuning ?? defaultTuning;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);

  const answer = (request: DispatchRequest, kind: "chosen" | "failed", payload: Record<string, unknown>) =>
    publishEvent(
      deps.db,
      {
        type: kind === "chosen" ? "master.dispatch_chosen" : "master.dispatch_failed",
        payload: { requestId: request.requestId, ...payload },
        dedupeKey: `dispatch_${kind}:${request.requestId}`,
      } as never,
      now,
    );
  const fail = (request: DispatchRequest, reason: string) => {
    log(`dispatch ${request.requestId} failed: ${reason}`);
    answer(request, "failed", { reason });
  };

  function filesOf(card: CardView): string[] {
    return card.plan?.files ?? [];
  }

  function describe(card: CardView): string {
    const project = store.projects.get(card.projectId);
    // Same main-agent model the board will dispatch with (card -> project -> global default, WP-108).
    const presetId = pickPresetId(card, project, (id) => !!store.presets.get(id), store.modelDefaults.global());
    const preset = presetId ? store.presets.get(presetId) : undefined;
    const files = filesOf(card);
    return [
      `- ${card.key} [优先级 ${card.priority}] 项目 ${project?.prefix ?? "?"}${preset ? `，执行预设 ${preset.name}（${preset.provider}）` : ""}`,
      `  标题：${clip(card.title, 100)}`,
      `  描述：${clip(card.description, 240) || "（无）"}`,
      `  方案涉及的文件：${files.length ? files.slice(0, 12).join("、") : "（未列出）"}`,
    ].join("\n");
  }

  function buildPrompt(request: DispatchRequest, cards: CardView[]): string {
    const projectIds = [...new Set(cards.map((c) => c.projectId))];
    const running = projectIds.flatMap((projectId) =>
      (["in_progress", "verifying"] as const).flatMap((column) => store.cards.list({ projectId, column })),
    );
    const limits = projectIds.map((projectId) => {
      const project = store.projects.get(projectId);
      const busy = running.filter((c) => c.projectId === projectId).length;
      return `- 项目 ${project?.prefix ?? projectId}：进行中 ${busy} 张，并发上限 ${project?.concurrencyLimit ?? "未设置"}`;
    });
    return prompts.resolve("master.dispatch", {
      vars: {
        slots: String(request.slots),
        limits: limits.join("\n") || "（无）",
        candidates: cards.map(describe).join("\n"),
        running:
          running
            .map((c) => `- ${c.key} [${c.column}] ${clip(c.title, 80)}；涉及的文件：${filesOf(c).join("、") || "（未列出）"}`)
            .join("\n") || "（无）",
      },
    });
  }

  /** Never throws: every outcome is an answer event. */
  async function handle(request: DispatchRequest): Promise<void> {
    try {
      if (!deps.enabled()) return fail(request, "总 agent 派发已关闭或总 agent 已停用");
      const cards = request.cardIds
        .map((id) => store.cards.get(id))
        .filter((c): c is CardView => !!c && c.column === "todo" && !c.archivedAt);
      if (cards.length === 0) return fail(request, "候选卡片已不在待办列");
      const timeoutMs = deps.timeoutSeconds() * 1000;

      const picked = await deps.exclusive(async () => {
        let reply = await deps.master.ask(buildPrompt(request, cards), { timeoutMs });
        for (let attempt = 0; ; attempt++) {
          const parsed = parseReply(reply, Reply);
          if (parsed.ok) return parsed.value;
          if (attempt >= tuning().jsonRepairRetries) throw new MasterError("agent", `回复格式不对：${parsed.error}`);
          reply = await deps.master.ask(buildRepairMessage("dispatch", parsed.error, prompts), { timeoutMs });
        }
      });

      const byKey = new Map(cards.map((c) => [c.key.toUpperCase(), c.id]));
      const chosen: string[] = [];
      for (const key of picked.order) {
        const id = byKey.get(key.trim().toUpperCase());
        if (id && !chosen.includes(id)) chosen.push(id);
      }
      const ids = chosen.slice(0, Math.max(1, request.slots));
      if (ids.length === 0) return fail(request, `总 agent 没有选出可派发的卡片${picked.reason ? `（${clip(picked.reason, 120)}）` : ""}`);
      answer(request, "chosen", { cardIds: ids, reason: clip(picked.reason, 300) });
    } catch (error) {
      fail(request, failureReason(error));
    }
  }

  return { handle };
}

export type Dispatcher = ReturnType<typeof createDispatcher>;
