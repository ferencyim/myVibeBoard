// Dispatch (WP-12): todo -> in_progress. Reads the card and its preset, creates the workspace
// (new worktree or the project directory), starts the worker agent and records the session
// through the shared command layer (`cards.dispatch`, the only todo -> in_progress entry).
//
// Admission (concurrency, quota, priority) belongs to vibe-scheduler (WP-34): it decides WHEN to
// call `dispatch(cardId)`; the optional `admit` gate lets an in-process scheduler veto a call.
// Without a gate the default is "dispatch immediately".

import { randomUUID } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import { pickPresetId, type AgentSession, type CardView, type Preset, type Project } from "../vibe/contract";
import { BoardError, toBoardError, type BoardService } from "../service";
import { classifyFailure, isReassignable } from "../lifecycle/error-class";
import { postChat } from "../chat/post";
import { linkPaseoProject } from "./link-project";
import { ensurePresetModel, type ModelCatalog } from "./model";
import type { PromptResolver } from "../prompts";
import { buildDispatchBrief, modeIdFor, providerSpec, threadTitle, worktreeSlug, type BriefLimits } from "./brief";

export type DispatchPaseo = Pick<PaseoApi, "projects" | "workspaces"> & ModelCatalog;

/** Hand-off to the lifecycle listener so events fired before the session row exists are not lost. */
export interface AgentTracker {
  expect(agentId: string): void;
  bind(agentId: string): Promise<void>;
  release(agentId: string): void;
}

export interface DispatchOptions {
  presetId?: string;
  extraInstructions?: string;
  /** Skip the admission gate (manual "dispatch now" from the UI). */
  force?: boolean;
}

export interface DispatchResult {
  card: CardView;
  session: AgentSession;
  workspaceId: string;
  agentId: string;
}

export interface DispatcherOptions {
  board: BoardService;
  /** Resolved per call: the SDK handle comes from the RPC/hook context. */
  getPaseo: () => DispatchPaseo | null;
  tracker?: AgentTracker;
  /** Scheduler gate; resolve false (or throw) to refuse. Default: always admit. */
  admit?: (card: CardView) => boolean | Promise<boolean>;
  newAgentId?: () => string;
  /** Failover on (default true): an agent that cannot even start for a provider-side reason tries the preset's fallbacks. */
  failoverEnabled?: () => boolean | Promise<boolean>;
  /** Prompt registry (default texts when omitted). */
  prompts?: PromptResolver;
  /** Brief limits from the board settings. */
  getLimits?: () => Partial<BriefLimits> | Promise<Partial<BriefLimits>>;
}

const COLUMN_ZH: Record<string, string> = { draft: "草稿箱", todo: "待办", in_progress: "进行中", verifying: "待验证", done: "已完成" };

export function createDispatcher(options: DispatcherOptions) {
  const { board, tracker } = options;
  const { store } = board;
  const inflight = new Set<string>();

  /** Explicit override, else card pick -> master recommendation -> project default (see pickPresetId). */
  function pickPreset(card: CardView, project: Project, presetId?: string): Preset {
    const presets = store.presets.list();
    const find = (id: string) => presets.find((p) => p.id === id || p.name === id);
    if (presetId) {
      const explicit = find(presetId);
      if (!explicit) throw new BoardError("not_found", `找不到预设：${presetId}`);
      return explicit;
    }
    const id = pickPresetId(card, project, (candidate) => !!find(candidate));
    if (!id) throw new BoardError("invalid", "这张卡还没有选执行预设，项目也没有默认预设，请先选择预设");
    return find(id)!;
  }

  function recordFailure(card: CardView, error: unknown): never {
    const message = error instanceof Error ? error.message : String(error);
    store.events.add({
      cardId: card.id,
      type: "status",
      authorKind: "system",
      author: "dispatcher",
      body: { kind: "dispatch_failed", message },
    });
    throw error instanceof BoardError ? error : new BoardError("dispatch_failed", message);
  }

  async function dispatch(cardRef: string, opts: DispatchOptions = {}): Promise<DispatchResult> {
    const card = board.cards.get(cardRef);
    if (card.column !== "todo") {
      throw new BoardError("illegal_transition", `${card.key} 当前在“${COLUMN_ZH[card.column] ?? card.column}”，只有待办卡片可以派发`);
    }
    if (inflight.has(card.id)) throw new BoardError("conflict", `${card.key} 正在派发中`);
    inflight.add(card.id);
    let agentId: string | null = null;
    try {
      if (!opts.force && options.admit && !(await options.admit(card))) {
        throw new BoardError("not_admitted", `调度器暂未放行 ${card.key}`);
      }
      const paseo = options.getPaseo();
      if (!paseo) throw new BoardError("unavailable", "派发需要先连上 Paseo 守护进程");
      const project = store.projects.get(card.projectId);
      if (!project) throw new BoardError("not_found", `找不到项目：${card.projectId}`);
      const preset = pickPreset(card, project, opts.presetId);
      let usedPreset = preset;

      let workspaceId = "";
      let worktree: string | null = null;
      /** The prompt the started agent actually received (shown in the group chat). */
      let usedPrompt = "";
      try {
        const target = (await linkPaseoProject(board, paseo, project)).paseoProject;
        const useWorktree = preset.environmentKind === "new-worktree" && target.projectKind === "git";
        const title = threadTitle(card);
        const workspace = await paseo.workspaces.create({
          title,
          source: useWorktree
            ? {
                kind: "worktree",
                cwd: target.projectRootPath,
                projectId: target.projectId,
                action: "branch-off",
                ...(preset.baseBranch ? { baseBranch: preset.baseBranch } : {}),
                worktreeSlug: worktreeSlug(card),
              }
            : { kind: "directory", path: target.projectRootPath, projectId: target.projectId },
        });
        const events = store.events.list(card.id);
        workspaceId = workspace.id;
        worktree = useWorktree ? workspace.directory : null;

        // The chosen preset first; when the agent cannot start for a provider-side reason
        // (login expired, model unknown, provider missing, ...) its fallbackPresetIds in order.
        const failover = (await (options.failoverEnabled?.() ?? true)) !== false;
        const queue = [preset];
        for (let i = 0; i < queue.length; i++) {
          const resolved = await ensurePresetModel(paseo, queue[i]!);
          const current = resolved.preset;
          if (resolved.note) {
            store.events.add({
              cardId: card.id,
              type: "note",
              authorKind: "system",
              author: "dispatch",
              body: { kind: "model_default", text: resolved.note },
            });
          }
          const prompt = buildDispatchBrief({
            prompts: options.prompts,
            limits: await options.getLimits?.(),
            card,
            project,
            preset: current,
            events,
            extraInstructions: opts.extraInstructions,
          });
          const modeId = modeIdFor(current.provider, current.permissionMode);
          const id = (options.newAgentId ?? randomUUID)();
          tracker?.expect(id);
          const env: Record<string, string> = {
            VIBE_ROLE: "worker",
            VIBE_CARD_ID: card.id,
            VIBE_CARD_KEY: card.key,
          };
          if (current.runtimeEnv) env.VIBE_RUNTIME_ENV = current.runtimeEnv;
          try {
            await workspace.agents.create({
              agentId: id,
              title,
              prompt,
              labels: { cardKey: card.key, cardId: card.id, role: "worker", preset: current.name },
              env,
              config: {
                provider: providerSpec(current),
                ...(current.thinking && current.thinking !== "default"
                  ? { thinkingOptionId: current.thinking }
                  : {}),
                ...(modeId ? { modeId } : {}),
              },
            });
            agentId = id;
            usedPreset = current;
            usedPrompt = prompt;
            break;
          } catch (error) {
            tracker?.release(id);
            const message = error instanceof Error ? error.message : String(error);
            const category = classifyFailure(message);
            if (i === 0 && failover && isReassignable(category)) {
              for (const fid of preset.fallbackPresetIds ?? []) {
                const next = store.presets.list().find((p) => p.id === fid);
                if (next && !queue.some((q) => q.id === next.id)) queue.push(next);
              }
            }
            if (i + 1 >= queue.length) throw error;
            store.events.add({
              cardId: card.id,
              type: "status",
              authorKind: "system",
              author: "failover",
              body: {
                kind: "failover",
                fromPresetId: current.id,
                toPresetId: queue[i + 1]!.id,
                category,
                method: "restart",
                text: `${current.provider}/${current.model} could not start (${category}: ${message}); trying ${queue[i + 1]!.name}.`,
              },
            });
          }
        }
      } catch (error) {
        return recordFailure(card, error);
      }

      const startedId = agentId as unknown as string; // set by the start loop above
      const result = store.cards.dispatch({
        cardId: card.id,
        agentId: startedId,
        workspaceId,
        provider: usedPreset.provider,
        worktree,
        presetId: usedPreset.id,
      });
      await tracker?.bind(startedId);
      const fellBack = usedPreset.id !== preset.id ? `（首选预设「${preset.name}」无法启动，已用备用预设）` : "";
      postChat(store, {
        cardId: card.id,
        authorKind: "system",
        author: "dispatch",
        kind: "info",
        thread: "exec",
        text: `已派发给「${usedPreset.name}」（${usedPreset.provider}/${usedPreset.model}）${fellBack}${worktree ? `，工作目录 ${worktree}` : ""}。`,
        agentId: startedId,
        sessionId: result.session.id,
        detail: usedPrompt,
        key: `dispatch:${result.session.id}`,
      });
      return { ...result, workspaceId, agentId: startedId };
    } catch (error) {
      if (agentId) tracker?.release(agentId);
      throw toBoardError(error);
    } finally {
      inflight.delete(card.id);
    }
  }

  return { dispatch };
}

export type Dispatcher = ReturnType<typeof createDispatcher>;
