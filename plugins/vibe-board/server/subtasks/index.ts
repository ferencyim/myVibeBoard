// Sub-agents of a card (WP-106). The card's main agent (the worker session) coordinates the plan's
// subtasks through the board MCP tools (vibe_subtask_*); this service carries them out:
//
//   start     refuse (dependency unfinished, already running, files overlapping a running subtask,
//             concurrency full) or start a Paseo agent for the subtask in the main agent's workspace
//             (same worktree), role "subagent", on the subtask's model / the card's sub-agent default
//   message   main agent or owner -> sub-agent (an open question is answered with the text)
//   mark      the main agent records a subtask as done / failed / pending itself
//   hooks     lifecycle events of sub-agents update card.subtask_runs_json and write the key lines of
//             the execution conversation; every change waits for delivery (notified = false)
//   deliver   poller: unseen changes go to the main agent as one board.subtask_notify message
//             ("steer": joins a running turn); never while the main agent waits for the owner
//
// All state is on the card (plan_json subtasks + subtask_runs_json), so a daemon restart loses
// nothing: sub-agents that disappeared are reported as failed to the main agent on the next poll.

import { randomUUID } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import {
  ACTIVE_SUBTASK_STATUSES,
  resolveModel,
  SUBTASK_STATUS_LABELS,
  concurrencyBlock,
  runOf,
  subtaskStartBlock,
  subtasksOf,
  takesSlot,
  type AgentSession,
  type CardView,
  type Preset,
  type Subtask,
  type SubtaskRun,
  type SubtaskStatus,
} from "../vibe/contract";
import { BoardError, toBoardError, type BoardService } from "../service";
import type { AgentTracker } from "../dispatch";
import { modeIdFor, providerSpec } from "../dispatch/brief";
import { ensurePresetModel, type ModelCatalog } from "../dispatch/model";
import { subtaskOfSession } from "../dispatch/reassign";
import { classifyFailure, isReassignable } from "../lifecycle/error-class";
import { postChat } from "../chat/post";
import { clip } from "../chat/format";
import { defaultPrompts, type PromptResolver } from "../prompts";
import type { ReplyService } from "../sync";
import { buildNotifyMessage, buildSubtaskBrief, subtaskModelLabel, type SubtaskUpdate } from "./brief";

export type SubtaskPaseo = Pick<PaseoApi, "agents" | "workspaces"> & ModelCatalog;

export interface SubtaskServiceOptions {
  board: BoardService;
  getPaseo: () => SubtaskPaseo | null;
  tracker?: AgentTracker;
  prompts?: PromptResolver;
  replies?: Pick<ReplyService, "send">;
  newAgentId?: () => string;
  /** Failover on (default true): a sub-agent that cannot start tries its preset's fallbacks. */
  failoverEnabled?: () => boolean | Promise<boolean>;
  pollIntervalMs?: number;
  now?: () => Date;
  log?: (message: string, error?: unknown) => void;
}

export type StartResult =
  | { started: true; subtask: string; sessionId: string; agentId: string; model: string }
  | { started: false; subtask: string; reason: string };

/** Sessions that count against the concurrency limits. */
const SLOT_STATES = ["starting", "working", "waiting", "idle"] as const;
/** States in which the main agent can take a notification now. */
const DELIVERABLE = new Set(["working", "idle", "ended"]);

export function createSubtaskService(options: SubtaskServiceOptions) {
  const { board, tracker } = options;
  const { store } = board;
  const prompts = options.prompts ?? defaultPrompts;
  const log = options.log ?? ((m, e) => console.error(`[vibe-board subtasks] ${m}`, e ?? ""));
  const now = options.now ?? (() => new Date());
  const starting = new Set<string>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let delivering: Promise<number> | null = null;

  const presetById = (id: string | null | undefined): Preset | undefined =>
    id ? store.presets.list().find((p) => p.id === id) : undefined;
  const mainOf = (cardId: string): AgentSession | undefined => store.sessions.list({ cardId, role: "worker" }).at(-1);
  const subtaskOf = (card: CardView, id: string): Subtask => {
    const subtask = subtasksOf(card).find((s) => s.id === id);
    if (!subtask) throw new BoardError("not_found", `方案里没有子任务 ${id}`);
    return subtask;
  };
  const name = (s: Subtask) => `「${s.id} · ${s.title}」`;

  /**
   * The subtask's own model, else the sub-agent default (card -> project -> global, WP-108), else the
   * main agent's model (same chain).
   */
  function presetFor(card: CardView, subtask: Subtask): Preset {
    const project = store.projects.get(card.projectId);
    const global = store.modelDefaults.global();
    const exists = (id: string) => !!presetById(id);
    const preset =
      presetById(subtask.presetId) ??
      presetById(resolveModel("subagent", card, project, global, exists).presetId) ??
      presetById(resolveModel("worker", card, project, global, exists).presetId);
    if (!preset) throw new BoardError("invalid", "没有可用的子代理模型：请在执行页选择子代理默认模型");
    return preset;
  }

  function concurrencyReason(card: CardView, provider: string): string | null {
    const project = store.projects.get(card.projectId);
    const active = store.sessions
      .list({ states: [...SLOT_STATES] })
      .filter(takesSlot)
      .map((s) => ({ provider: s.currentProvider, projectId: s.cardId ? (store.cards.get(s.cardId)?.projectId ?? null) : null }));
    return concurrencyBlock({
      limits: store.limits.get(),
      active,
      provider,
      projectId: card.projectId,
      projectLimit: project?.concurrencyLimit ?? null,
    });
  }

  function setRun(card: CardView, subtaskId: string, patch: Partial<SubtaskRun>): SubtaskRun {
    return store.cards.setSubtaskRun(card.id, subtaskId, patch);
  }

  // ---------- tools of the main agent ----------

  function status(cardRef: string) {
    const card = board.cards.get(cardRef);
    const presets = store.presets.list();
    return {
      card: card.key,
      column: card.column,
      subtasks: subtasksOf(card).map((s) => {
        const run = runOf(card, s.id);
        return {
          id: s.id,
          title: s.title,
          status: run.status,
          statusLabel: SUBTASK_STATUS_LABELS[run.status],
          model: run.presetId ? (presetById(run.presetId)?.name ?? run.presetId) : subtaskModelLabel(s, card, presets),
          dependsOn: s.dependsOn,
          files: s.files,
          goal: s.goal,
          acceptance: s.acceptance,
          summary: run.summary,
          error: run.error,
          attempts: run.attempts,
          agentId: run.agentId,
          startBlockedBy: ACTIVE_SUBTASK_STATUSES.includes(run.status) || run.status === "done" ? null : subtaskStartBlock(card, s.id),
        };
      }),
    };
  }

  async function start(cardRef: string, subtaskId: string, extra?: string): Promise<StartResult> {
    const refuse = (reason: string): StartResult => ({ started: false, subtask: subtaskId, reason });
    const card = board.cards.get(cardRef);
    if (card.column !== "in_progress") return refuse(`卡片 ${card.key} 不在“进行中”，不能启动子代理`);
    const blocked = subtaskStartBlock(card, subtaskId);
    if (blocked) return refuse(blocked);
    const subtask = subtaskOf(card, subtaskId);
    const main = mainOf(card.id);
    if (!main) return refuse("这张卡片还没有主代理（先点「立即执行」）");
    const lock = `${card.id}:${subtaskId}`;
    if (starting.has(lock)) return refuse(`子任务 ${subtaskId} 正在启动`);
    const paseo = options.getPaseo();
    if (!paseo) throw new BoardError("unavailable", "启动子代理需要先连上 Paseo 守护进程");
    const first = presetFor(card, subtask);
    const full = concurrencyReason(card, first.provider);
    if (full) return refuse(full);

    starting.add(lock);
    try {
      const failover = (await (options.failoverEnabled?.() ?? true)) !== false;
      const queue = [first];
      let agentId = "";
      let used: Preset = first;
      let prompt = "";
      for (let i = 0; i < queue.length; i++) {
        const { preset } = await ensurePresetModel(paseo, queue[i]!);
        prompt = buildSubtaskBrief({ card, subtask, extra, prompts });
        const id = (options.newAgentId ?? randomUUID)();
        tracker?.expect(id);
        const modeId = modeIdFor(preset.provider, preset.permissionMode);
        const create = {
          agentId: id,
          title: `${card.key} · ${subtask.id} ${subtask.title}`.slice(0, 80),
          prompt,
          labels: { cardKey: card.key, cardId: card.id, role: "subagent", subtask: subtask.id, preset: preset.name },
          env: {
            VIBE_ROLE: "subagent",
            VIBE_CARD_ID: card.id,
            VIBE_CARD_KEY: card.key,
            VIBE_SUBTASK_ID: subtask.id,
            ...(preset.runtimeEnv ? { VIBE_RUNTIME_ENV: preset.runtimeEnv } : {}),
          },
          config: {
            provider: providerSpec(preset),
            ...(preset.thinking && preset.thinking !== "default" ? { thinkingOptionId: preset.thinking } : {}),
            ...(modeId ? { modeId } : {}),
          },
        };
        try {
          if (main.workspaceId) {
            const workspace = paseo.workspaces.ref(main.workspaceId);
            await workspace.refresh();
            await workspace.agents.create(create);
          } else if (card.worktree) {
            await paseo.agents.create({ ...create, cwd: card.worktree });
          } else {
            throw new BoardError("invalid", "找不到主代理的工作目录，无法启动子代理");
          }
          agentId = id;
          used = preset;
          break;
        } catch (error) {
          tracker?.release(id);
          const message = error instanceof Error ? error.message : String(error);
          const category = classifyFailure(message);
          if (i === 0 && failover && isReassignable(category)) {
            for (const fid of first.fallbackPresetIds ?? []) {
              const next = presetById(fid);
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
              subtask: subtask.id,
              fromPresetId: preset.id,
              toPresetId: queue[i + 1]!.id,
              category,
              method: "restart",
              text: `子任务 ${subtask.id}：${preset.provider}/${preset.model} 无法启动（${category}：${message}），改用 ${queue[i + 1]!.name}。`,
            },
          });
        }
      }
      const session = store.sessions.start({
        cardId: card.id,
        agentId,
        workspaceId: main.workspaceId,
        role: "subagent",
        provider: used.provider,
      });
      const previous = runOf(card, subtask.id);
      setRun(card, subtask.id, {
        status: "running",
        sessionId: session.id,
        agentId,
        presetId: used.id,
        summary: "",
        error: "",
        attempts: previous.attempts + 1,
        notified: true, // the main agent asked for it
        startedAt: now().toISOString(),
        finishedAt: null,
      });
      await tracker?.bind(agentId);
      const fellBack = used.id !== first.id ? `（「${first.name}」无法启动，已用备用预设）` : "";
      postChat(
        store,
        {
          cardId: card.id,
          authorKind: "system",
          author: "subtasks",
          kind: "info",
          thread: "exec",
          subtask: subtask.id,
          text: `已启动子代理${name(subtask)}：「${used.name}」（${used.provider}/${used.model}）${fellBack}。`,
          agentId,
          sessionId: session.id,
          detail: prompt,
          key: `subtask-start:${session.id}`,
        },
        log,
      );
      return { started: true, subtask: subtask.id, sessionId: session.id, agentId, model: used.name };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRun(card, subtask.id, { status: "failed", error: clip(message, 500), notified: true, finishedAt: now().toISOString() });
      postChat(
        store,
        {
          cardId: card.id,
          authorKind: "system",
          author: "subtasks",
          kind: "info",
          thread: "exec",
          subtask: subtask.id,
          text: `子代理${name(subtask)}没能启动：${clip(message, 300)}`,
          key: `subtask-start-failed:${subtask.id}:${runOf(card, subtask.id).attempts}`,
        },
        log,
      );
      throw toBoardError(error);
    } finally {
      starting.delete(lock);
    }
  }

  /**
   * Send text to the subtask's sub-agent. An open question is answered with it; an ended sub-agent
   * is resumed first. `from` labels the sender for the sub-agent.
   */
  async function message(
    cardRef: string,
    subtaskId: string,
    text: string,
    from: "main" | "user",
    replyId?: string,
  ): Promise<{ sent: true; asAnswer: boolean; agentId: string; sessionId: string }> {
    const card = board.cards.get(cardRef);
    const subtask = subtaskOf(card, subtaskId);
    const run = runOf(card, subtask.id);
    const session = run.sessionId ? store.sessions.get(run.sessionId) : undefined;
    if (!session) throw new BoardError("invalid", `子任务 ${subtask.id} 还没有子代理，先用 vibe_subtask_start 启动`);
    const paseo = options.getPaseo();
    if (!paseo) throw new BoardError("unavailable", "需要先连上 Paseo 守护进程");
    const agent = paseo.agents.ref(session.agentId);
    let asAnswer = false;
    const question = session.state === "waiting" ? (session.pendingQuestion as { requestId?: unknown } | null) : null;
    if (typeof question?.requestId === "string" && options.replies) {
      try {
        await options.replies.send({
          id: replyId ?? `subtask:${randomUUID()}`,
          cardId: card.id,
          questionId: question.requestId,
          text,
          author: from === "main" ? "main-agent" : "user",
        });
        asAnswer = true;
      } catch {
        // the question is gone: send a normal message instead
      }
    }
    if (!asAnswer) {
      if (session.state === "ended") {
        const resumable = agent as { resume?: () => Promise<void> };
        if (resumable.resume) await resumable.resume();
      }
      await agent.send(`${from === "main" ? "[主代理]" : "[用户]"} ${text}`, { activeTurnBehavior: "steer" });
    }
    return { sent: true, asAnswer, agentId: session.agentId, sessionId: session.id };
  }

  function mark(cardRef: string, subtaskId: string, to: Extract<SubtaskStatus, "done" | "failed" | "pending">, note: string) {
    const card = board.cards.get(cardRef);
    const subtask = subtaskOf(card, subtaskId);
    const run = setRun(card, subtask.id, {
      status: to,
      summary: note,
      error: to === "failed" ? note : "",
      notified: true,
      finishedAt: to === "pending" ? null : now().toISOString(),
    });
    postChat(
      store,
      {
        cardId: card.id,
        authorKind: "executor",
        author: "main",
        kind: "info",
        thread: "exec",
        subtask: subtask.id,
        text: `主代理把子任务${name(subtask)}标记为${SUBTASK_STATUS_LABELS[to]}${note.trim() ? `：${note.trim()}` : "。"}`,
        key: `subtask-mark:${subtask.id}:${randomUUID()}`,
      },
      log,
    );
    return { subtask: subtask.id, run };
  }

  // ---------- lifecycle hooks (sub-agent sessions) ----------

  function located(session: AgentSession): { card: CardView; subtask: Subtask } | null {
    if (session.role !== "subagent" || !session.cardId) return null;
    const card = store.cards.get(session.cardId);
    const subtask = card ? subtaskOfSession(card, session) : undefined;
    return card && subtask ? { card, subtask } : null;
  }

  const line = (
    card: CardView,
    subtask: Subtask,
    session: AgentSession,
    text: string,
    kind: "summary" | "question" | "info",
    key: string,
    authorKind: "executor" | "system" = "executor",
  ) =>
    postChat(
      store,
      {
        cardId: card.id,
        authorKind,
        author: authorKind === "executor" ? `subagent:${subtask.id}` : "subtasks",
        kind,
        thread: "exec",
        subtask: subtask.id,
        text,
        agentId: session.agentId,
        sessionId: session.id,
        key,
      },
      log,
    );

  const hooks = {
    /** A turn started or a question was answered: the sub-agent works (again). */
    onActive(session: AgentSession): void {
      const at = located(session);
      if (!at) return;
      const run = runOf(at.card, at.subtask.id);
      // Running again (answered, continued, restarted after an interruption): an earlier change the
      // main agent has not heard of yet is moot.
      if (run.status !== "running") {
        setRun(at.card, at.subtask.id, { status: "running", finishedAt: null, error: "", notified: true });
      }
    },
    /** A round ended normally: the subtask is done; its last reply is the summary. */
    onDone(session: AgentSession, text: string | null, turnKey: string): void {
      const at = located(session);
      if (!at) return;
      const summary = text?.trim() ?? "";
      setRun(at.card, at.subtask.id, { status: "done", summary, error: "", notified: false, finishedAt: now().toISOString() });
      line(at.card, at.subtask, session, summary || `子任务${name(at.subtask)}已完成。`, "summary", `subtask-done:${session.id}:${turnKey}`);
    },
    onQuestion(session: AgentSession, question: string, requestId: string): void {
      const at = located(session);
      if (!at) return;
      setRun(at.card, at.subtask.id, { status: "waiting", summary: question, notified: false });
      line(at.card, at.subtask, session, question, "question", `subtask-question:${session.id}:${requestId}`);
    },
    /** The sub-agent failed and no fallback took over (or it was closed while working). */
    onFailed(session: AgentSession, reason: string): void {
      const at = located(session);
      if (!at) return;
      const run = runOf(at.card, at.subtask.id);
      if (run.status === "failed" && run.error === reason) return;
      setRun(at.card, at.subtask.id, { status: "failed", error: clip(reason, 500), notified: false, finishedAt: now().toISOString() });
      line(at.card, at.subtask, session, `子代理${name(at.subtask)}失败：${clip(reason, 300)}`, "info", `subtask-failed:${session.id}:${run.attempts}`, "system");
    },
    /** Agent closed / archived: a sub-agent still at work is lost. */
    onEnded(session: AgentSession, outcome: string): void {
      const at = located(session);
      if (!at) return;
      if (ACTIVE_SUBTASK_STATUSES.includes(runOf(at.card, at.subtask.id).status)) {
        hooks.onFailed(session, `子代理会话已结束（${outcome}），工作可能没有完成`);
      }
    },
  };

  // ---------- delivery to the main agent ----------

  /** Runs that point to a session that no longer exists or ended while working: report as failed. */
  function reapLost(card: CardView): void {
    for (const s of subtasksOf(card)) {
      const run = runOf(card, s.id);
      if (!ACTIVE_SUBTASK_STATUSES.includes(run.status)) continue;
      const session = run.sessionId ? store.sessions.get(run.sessionId) : undefined;
      if (!session) {
        setRun(card, s.id, { status: "failed", error: "找不到子代理会话", notified: false, finishedAt: now().toISOString() });
      } else if (session.state === "ended" || session.state === "error") {
        hooks.onFailed(session, session.errorMessage ?? "子代理会话已结束，工作可能没有完成");
      }
    }
  }

  async function deliverCard(card: CardView): Promise<boolean> {
    reapLost(card);
    const fresh = store.cards.get(card.id)!;
    const ids = new Set(subtasksOf(fresh).map((s) => s.id));
    const updates: SubtaskUpdate[] = [];
    for (const [id, run] of Object.entries(fresh.subtaskRuns)) {
      if (run.notified) continue;
      if (!ids.has(id)) {
        setRun(fresh, id, { notified: true }); // the subtask left the plan
        continue;
      }
      updates.push({ subtask: subtaskOf(fresh, id), run });
    }
    if (updates.length === 0) return false;
    const main = mainOf(fresh.id);
    if (!main || !DELIVERABLE.has(main.state)) return false; // waiting for the owner, starting or failed
    const paseo = options.getPaseo();
    if (!paseo) return false;
    const agent = paseo.agents.ref(main.agentId);
    if (main.state === "ended") {
      const resumable = agent as { resume?: () => Promise<void> };
      if (resumable.resume) await resumable.resume();
    }
    await agent.send(buildNotifyMessage(fresh, updates, prompts), { activeTurnBehavior: "steer" });
    const after = store.cards.get(fresh.id)!;
    for (const u of updates) {
      const current = runOf(after, u.subtask.id);
      // Only what was sent: a change that arrived meanwhile waits for the next poll.
      if (current.status === u.run.status && current.summary === u.run.summary && current.error === u.run.error) {
        setRun(after, u.subtask.id, { notified: true });
      }
    }
    return true;
  }

  /** Deliver pending sub-agent news to the main agents; resolves with the number of cards notified. */
  function deliver(): Promise<number> {
    if (!delivering) {
      delivering = (async () => {
        let sent = 0;
        for (const card of store.cards.list({ column: "in_progress" })) {
          if (Object.keys(card.subtaskRuns).length === 0) continue;
          try {
            if (await deliverCard(card)) sent++;
          } catch (error) {
            log(`could not notify the main agent of ${card.key}`, error);
          }
        }
        return sent;
      })().finally(() => {
        delivering = null;
      });
    }
    return delivering;
  }

  return {
    status: (cardRef: string) => {
      try {
        return status(cardRef);
      } catch (error) {
        throw toBoardError(error);
      }
    },
    start,
    message: async (...args: Parameters<typeof message>) => {
      try {
        return await message(...args);
      } catch (error) {
        throw toBoardError(error);
      }
    },
    mark: (...args: Parameters<typeof mark>) => {
      try {
        return mark(...args);
      } catch (error) {
        throw toBoardError(error);
      }
    },
    hooks,
    deliver,
    startPolling() {
      if (timer) return;
      timer = setInterval(() => void deliver(), options.pollIntervalMs ?? 2000);
      (timer as unknown as { unref?: () => void }).unref?.();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await delivering;
    },
  };
}

export type SubtaskService = ReturnType<typeof createSubtaskService>;
export type SubtaskHooks = SubtaskService["hooks"];
