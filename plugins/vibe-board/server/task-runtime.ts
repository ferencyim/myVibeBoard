import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  taskConversationCommandRpc,
  taskConversationPanelRpc,
  taskConversationSelectRoleRpc,
} from "../shared/task-conversation";
import { createEventConsumer, resolveVibeHome, type VibeDb, type VibeStore } from "./vibe/db";
import { createTaskHost } from "./task-host";
import { createTaskConversationService } from "./task-conversation/service";
import { createTaskPanelReader } from "./task-panel";

/** The business owner for native task conversations. Legacy cards keep their own registrations. */
export function registerTaskRuntime(
  server: PluginServerContext,
  options: {
    db: VibeDb;
    store: VibeStore;
    getPaseo(): PaseoApi | null;
    onPaseo(paseo: PaseoApi): void;
  },
) {
  const observations = new Map<string, { release(): Promise<void> }>();
  let closed = false;
  const onPaseo = (paseo: PaseoApi) => {
    options.onPaseo(paseo);
    ensureObservations();
  };
  const host = createTaskHost({ ...options, onPaseo, paseo: options.getPaseo });
  host.registerPrompts();
  const flow = createTaskConversationService({
    store: options.store,
    getPaseo: options.getPaseo,
    resolveRoles: host.resolveRoles,
    resolveRecipient: host.resolveRecipient,
    releaseAgent: host.releaseAgent,
  });
  const panel = createTaskPanelReader({ ...options, resolveRecipient: host.resolveRecipient });
  function ensureObservations() {
    const paseo = options.getPaseo();
    if (!paseo || closed) return;
    for (const task of options.store.tasks.list()) {
      if (!task.conversationId || observations.has(task.conversationId)) continue;
      const observation = paseo.taskConversations.ref(task.conversationId).subscribe();
      observations.set(task.conversationId, observation);
      observation.subscribe({
        snapshot: () => {
          void flow
            .recoverCompletedSources(task.workspaceId)
            .catch((error) => console.error("任务已完成源恢复失败：", error));
        },
        update: () => {},
      });
      void observation.ready.catch((error) => console.error("任务会话观察未就绪：", error));
    }
  }
  const systemTurns = new Set<string>();
  const cleanups = [
    server.registerTaskConversationHooks(host.hooks),
    server.on("agent.turn_started", ({ agent, turnId }, context) => {
      if (!host.isCompacting(agent.id)) host.noteTurnStarted(agent.id, turnId);
      onPaseo(context.paseo);
      // Register before the legacy lifecycle consumes the context plugin's marker.
      try {
        const marker = JSON.parse(
          readFileSync(
            join(resolveVibeHome(), "system-turns", agent.id.replace(/[^\w.-]/g, "_") + ".json"),
            "utf8",
          ),
        ) as { expiresAt?: number };
        if ((marker.expiresAt ?? 0) >= Date.now()) systemTurns.add(agent.id);
      } catch {
        /* Ordinary turns have no marker. */
      }
    }),
    server.on("agent.turn_ended", async ({ agent, outcome, turnId }, context) => {
      onPaseo(context.paseo);
      // Native compaction can emit turn_ended before its out-of-band command settles.
      // Its control hook owns the lease until that explicit settlement.
      if (host.isCompacting(agent.id)) {
        systemTurns.delete(agent.id);
        return;
      }
      const turn = host.takeTurn(agent.id, turnId);
      if (!turn?.isCurrent()) return;
      const session = options.store.sessions.getByAgent(agent.id);
      if (!session?.workspaceId || session.cardId) return;
      if (systemTurns.delete(agent.id)) {
        await turn.release();
        return;
      }
      if (outcome.kind === "completed") {
        const task = options.store.tasks.get(session.workspaceId);
        if (task?.conversationId) await host.reconcileAnchor(task.workspaceId, task.conversationId);
        if (turn.isCurrent()) await flow.onTurnCompleted(agent.id, turn);
      } else await turn.release();
    }),
  ];
  cleanups.push(server.on("agent.created", (_event, context) => onPaseo(context.paseo)));
  server.handle(taskConversationPanelRpc, async (input, context) => {
    onPaseo(context.paseo);
    if (options.store.tasks.get(input.workspaceId))
      await host.reconcileAnchor(input.workspaceId, input.conversationId);
    await flow.publishPendingArtifacts(input.workspaceId);
    return panel(input, context.paseo);
  });
  server.handle(taskConversationCommandRpc, async (input, context) => {
    onPaseo(context.paseo);
    if (options.store.tasks.get(input.workspaceId))
      await host.reconcileAnchor(input.workspaceId, input.conversationId);
    return flow.command(input);
  });
  server.handle(taskConversationSelectRoleRpc, async (input, context) => {
    onPaseo(context.paseo);
    const conversation = await context.paseo.taskConversations.ref(input.conversationId).refresh();
    const task = options.store.tasks.get(input.workspaceId);
    if (
      !conversation ||
      conversation.workspaceId !== input.workspaceId ||
      conversation.ownerPluginId !== "vibe-board" ||
      task?.conversationId !== input.conversationId
    )
      throw new Error("任务会话不存在或不属于当前工作区");
    if (task.confirmedAt || !["planning", "awaiting_confirmation"].includes(task.phase))
      throw new Error("已确认角色快照不可修改；请先修改方案并重新确认");
    if (input.selection.mode === "preset" && !options.store.presets.get(input.selection.presetId))
      throw new Error("所选预设已不存在，请刷新后重选");
    return options.store.tasks.setRoleSelections(task.workspaceId, {
      ...task.roleSelections,
      [input.role]: input.selection,
    });
  });
  const consumer = createEventConsumer({
    db: options.db,
    consumer: "vibe-board:task-conversation-owner",
    types: [
      "task.updated",
      "scheduler.task_admitted",
      "task.fix_requested",
      "task.stop_requested",
      "context.continuation_requested",
    ],
    handler: async (event) => {
      if (!options.getPaseo()) throw new Error("任务宿主连接尚未就绪，保留事件待重试");
      ensureObservations();
      host.handleAdmission(event);
      await flow.handleEvent(event);
    },
    onError: (error) => console.error("任务流程事件处理失败：", error),
  });
  consumer.start();
  ensureObservations();
  return {
    flow,
    host,
    async close() {
      closed = true;
      for (const cleanup of cleanups) cleanup();
      await consumer.stop();
      await Promise.allSettled(
        [...observations.values()].map((observation) => observation.release()),
      );
      host.close();
    },
  };
}
