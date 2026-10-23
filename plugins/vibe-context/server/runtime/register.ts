import { createContextResources } from "./resources";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createHash, randomUUID } from "node:crypto";
import type { AgentSession, ModelRole, Task } from "../vibe/contract";
import {
  createTaskRuntimeCommands,
  createEventConsumer,
  publishEvent,
  type VibeDb,
  type VibeStore,
} from "../vibe/db";
import type { ContextSettingsValues } from "../../shared/settings/context";
import { defaultPrompts, type PromptResolver } from "../prompts";
import { continuationFailure } from "./continuation";
import { readState, writeState } from "../complexity";
import { createTaskWatchdog } from "./watchdog";

export function createTaskContextService(options: {
  db: VibeDb;
  store: VibeStore;
  prompts?: PromptResolver;
  report?: (session: AgentSession, text: string) => Promise<void> | void;
}) {
  const { store, db } = options;
  const runtime = createTaskRuntimeCommands(db);
  const report = async (session: AgentSession, text: string) => {
    if (session.workspaceId && store.tasks.get(session.workspaceId))
      store.tasks.setSummary(session.workspaceId, text);
    await options.report?.(session, text);
  };
  const freeze = (session: AgentSession) => {
    const task = session.workspaceId ? store.tasks.get(session.workspaceId) : undefined;
    if (task && !["paused", "completed", "failed"].includes(task.phase))
      store.tasks.setPhase(task.workspaceId, "paused");
    if (task)
      publishEvent(db, {
        type: "scheduler.task_resource_request",
        payload: {
          requestId: "context:freeze:" + session.id,
          workspaceId: task.workspaceId,
          action: "freeze",
          agentId: session.agentId,
        },
      });
  };
  const pause = async (session: AgentSession, text: string) => {
    freeze(session);
    await report(session, text);
  };
  const inheritComplexity = (
    old: AgentSession,
    next: AgentSession,
    reason: "context" | "failure",
  ) => {
    const previous = readState(db, old.id);
    const inherited = old.complexity === "long" ? "multi" : old.complexity;
    const nextState = readState(db, next.id);
    if (nextState.baselineTs === null) {
      writeState(db, next.id, {
        ...nextState,
        baselineTs: next.startedAt,
        longCompactions:
          previous.longCompactions + (reason === "context" && old.complexity === "long" ? 1 : 0),
        floor: inherited === "multi" ? "multi" : null,
      });
      if (inherited && next.complexity !== "long") store.sessions.setComplexity(next.id, inherited);
    }
  };
  const publishContinuation = (
    current: AgentSession,
    task: Task | undefined,
    reason: "failure" | "context",
    message: string,
    candidateIndex: number,
    prompt?: string,
    turnId?: string | null,
  ) => {
    const summary = JSON.stringify({
      plan: task?.plan ?? null,
      subtaskRuns: task?.subtaskRuns ?? [],
      summary: task?.summary ?? "",
      previousAgentId: current.agentId,
    });
    const handoff =
      prompt ??
      (options.prompts ?? defaultPrompts).resolve("context.failure_handoff", {
        projectId: current.projectId,
        vars: {
          workspaceId: current.workspaceId ?? "总 agent",
          role: current.role,
          oldAgentId: current.agentId,
          summary,
        },
      });
    const requestId =
      "context:" +
      current.id +
      ":" +
      reason +
      ":" +
      createHash("sha256")
        .update(turnId ?? current.cacheExpiresAt ?? message)
        .digest("hex")
        .slice(0, 16);
    const existing = db.prepare("SELECT seq FROM vibe_event WHERE dedupe_key = ?").get(requestId);
    if (existing) return false;
    publishEvent(db, {
      type: "context.continuation_requested",
      dedupeKey: requestId,
      projectId: current.projectId,
      payload: {
        requestId,
        workspaceId: current.role === "master" ? null : current.workspaceId,
        sessionId: current.id,
        agentId: current.agentId,
        role: current.role,
        reason,
        message,
        summary,
        candidateIndex: candidateIndex,
        confirmedAt: current.confirmedAt ?? task?.confirmedAt ?? null,
        prompt: handoff,
      },
    });
    return true;
  };
  return {
    report,
    pause,
    async completeContinuation(input: {
      requestId: string;
      workspaceId: string | null;
      status: "continued" | "paused" | "exhausted" | "deferred";
      reason: string;
      agentId?: string;
      sessionId?: string;
    }) {
      const request = db
        .prepare<{ payload_json: string }>(
          "SELECT payload_json FROM vibe_event WHERE type = 'context.continuation_requested' AND dedupe_key = ?",
        )
        .get(input.requestId);
      if (!request) return;
      const payload = JSON.parse(request.payload_json) as {
        workspaceId: string | null;
        sessionId: string;
        confirmedAt: string | null;
        reason: "context" | "failure";
      };
      if (payload.workspaceId !== input.workspaceId) return;
      const old = runtime.getSession(payload.sessionId);
      if (!old) return;
      const task = old.workspaceId ? store.tasks.get(old.workspaceId) : undefined;
      if (task && task.confirmedAt !== payload.confirmedAt) return;
      if (input.status === "continued") {
        const next = input.sessionId ? runtime.getSession(input.sessionId) : undefined;
        if (!next || next.previousSessionId !== old.id || next.agentId !== input.agentId) {
          await report(old, "接续结果缺少实际模型或原生会话关联，请核对任务流程插件。");
          return;
        }
        inheritComplexity(old, next, payload.reason);
        if (
          payload.reason === "context" &&
          !db
            .prepare(
              "SELECT seq FROM vibe_event WHERE type = 'session.compacted' AND json_extract(payload_json, '$.sessionId') = ? AND json_extract(payload_json, '$.strategy') = 'handoff'",
            )
            .get(old.id)
        )
          store.sessions.recordCompaction(old.id, "handoff");
        await report(next, "会话已接续：" + input.reason);
      } else await report(old, "会话接续暂停：" + input.reason);
    },
    async requestContinuation(
      session: AgentSession,
      reason: "failure" | "context",
      message: string,
      prompt?: string,
      turnId?: string | null,
    ) {
      const current = runtime.getSession(session.id);
      if (!current || current.state === "ended" || current.cardId) return;
      const task = current.workspaceId ? store.tasks.get(current.workspaceId) : undefined;
      if (
        task &&
        (["paused", "completed", "failed"].includes(task.phase) ||
          (current.confirmedAt && current.confirmedAt !== task.confirmedAt))
      )
        return;
      const selection = runtime.getSelection(current.id);
      const preset = task?.rolesSnapshot?.[current.role as ModelRole];
      const text =
        reason === "failure"
          ? "模型不可用，已暂停任务，等待按预设顺序接续。"
          : "上下文需要交接，已暂停任务，等待原生会话接续。";
      // Freeze admission before the owner stops or replaces the native agent.
      freeze(current);
      if (!selection) {
        await report(
          current,
          "缺少实际模型记录，自动接续已暂停；请升级任务流程插件并核对原生会话。",
        );
        return;
      }
      if (reason === "failure" && preset && selection.candidateIndex + 1 >= preset.models.length) {
        await report(current, "预设候选模型已耗尽，任务暂停，等待用户处理。");
        return;
      }
      if (
        !publishContinuation(
          current,
          task,
          reason,
          message,
          selection.candidateIndex,
          prompt,
          turnId,
        )
      )
        return;
      await report(
        current,
        text + "若任务流程插件尚不支持接续，请升级插件；资源保留到停止已确认。",
      );
    },
  };
}

export function registerTaskContext(
  server: PluginServerContext,
  options: {
    db: VibeDb;
    store: VibeStore;
    prompts?: PromptResolver;
    getConfig?: () => Pick<
      ContextSettingsValues,
      "watchdogEnabled" | "watchdogMinutes" | "watchdogProviderMinutes"
    >;
  },
) {
  let paseo = (server as { paseo?: PaseoApi }).paseo ?? null;
  const service = createTaskContextService({
    ...options,
    report: async (session, text) => {
      const task = session.workspaceId ? options.store.tasks.get(session.workspaceId) : undefined;
      if (paseo && task) {
        try {
          await paseo.agents.ref(task.anchorAgentId).timeline.append({
            type: "plugin",
            id: randomUUID(),
            kind: "context_status",
            version: 1,
            data: { text, workspaceId: task.workspaceId },
          });
        } catch (error) {
          console.error("上下文摘要追加失败：", error);
        }
      }
    },
  });
  const resources = createContextResources({ ...options, report: service.report });
  const active = (agentId: string) => {
    const session = options.store.sessions.getByAgent(agentId);
    return session && !session.cardId && session.state !== "ended" ? session : undefined;
  };
  const watchdog = createTaskWatchdog({
    store: options.store,
    config: () => {
      const config = options.getConfig?.() ?? {
        watchdogEnabled: true,
        watchdogMinutes: 10,
        watchdogProviderMinutes: {},
      };
      return {
        enabled: config.watchdogEnabled,
        minutes: config.watchdogMinutes,
        providerMinutes: config.watchdogProviderMinutes,
      };
    },
    activity: async (session) => {
      if (!paseo) return null;
      const page = await paseo.agents
        .ref(session.agentId)
        .timeline.refetch({ direction: "tail", limit: 1, projection: "projected" });
      const timestamp = Date.parse(String(page.entries.at(-1)?.timestamp ?? ""));
      return Number.isFinite(timestamp) ? timestamp : null;
    },
    report: service.report,
  });
  const pending = new Map<string, Set<string>>();
  const offs = [
    server.on("agent.created", (_event, ctx) => {
      paseo = ctx.paseo;
    }),
    server.on("agent.turn_started", ({ agent }, ctx) => {
      paseo = ctx.paseo;
      pending.delete(agent.id);
      const session = active(agent.id);
      if (session) options.store.sessions.setState(session.id, "working");
    }),
    server.on("agent.permission_requested", ({ agent, request }, ctx) => {
      paseo = ctx.paseo;
      const requests = pending.get(agent.id) ?? new Set<string>();
      requests.add(request.id);
      pending.set(agent.id, requests);
      const session = active(agent.id);
      if (session)
        options.store.sessions.setState(session.id, "waiting", {
          question: { requestId: request.id },
        });
    }),
    server.on("agent.permission_resolved", ({ agent, requestId }, ctx) => {
      paseo = ctx.paseo;
      const requests = pending.get(agent.id);
      requests?.delete(requestId);
      if (requests?.size) return;
      pending.delete(agent.id);
      const session = active(agent.id);
      if (session?.state === "waiting") options.store.sessions.setState(session.id, "working");
    }),
    server.on("agent.turn_ended", async ({ agent, turnId, outcome }, ctx) => {
      paseo = ctx.paseo;
      const session = active(agent.id);
      if (!session) return;
      // The master owner already tracks its own native turn and frozen candidate cursor.
      if (
        session.role === "master" ||
        (outcome.kind === "failed" && ["reviewer", "verifier"].includes(session.role))
      )
        return;
      if (outcome.kind === "failed") {
        options.store.sessions.setState(session.id, "error", { message: outcome.error.message });
        if (continuationFailure(outcome.error.message, outcome.error.code) !== "other")
          await service.requestContinuation(
            session,
            "failure",
            outcome.error.message,
            undefined,
            turnId,
          );
        else if (session.workspaceId)
          await service.pause(
            session,
            "任务失败，已暂停；普通任务错误不会自动轮换模型。请查看原生会话。",
          );
      } else if (outcome.kind === "canceled") {
        options.store.sessions.setState(session.id, "idle");
        await service.pause(session, "会话被停止，任务暂停；请核对其它执行会话的停止状态。");
      } else if (session.state !== "waiting") options.store.sessions.setState(session.id, "idle");
    }),
  ];
  const resultConsumer = createEventConsumer({
    db: options.db,
    consumer: "vibe-context:continuation-results",
    types: ["context.continuation_result"],
    startAt: "now",
    handler: async (event) => {
      if (event.type === "context.continuation_result")
        await service.completeContinuation(
          event.payload as Parameters<typeof service.completeContinuation>[0],
        );
    },
    onError: (error) => console.error("上下文接续结果处理失败：", error),
  });
  resultConsumer.start();
  const timer = setInterval(
    () => void watchdog.tick().catch((error) => console.error("上下文看门狗检查失败：", error)),
    30_000,
  );
  (timer as unknown as { unref?: () => void }).unref?.();
  return {
    runTaskTurn: resources.run,
    requestHandoff: (session: AgentSession, prompt: string) =>
      service.requestContinuation(session, "context", "上下文压缩交接", prompt),
    close: async () => {
      clearInterval(timer);
      for (const off of offs) off();
      await resultConsumer.stop();
      await resources.close();
    },
  };
}
