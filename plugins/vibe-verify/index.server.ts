import { deferStartup } from "./server/vibe/db/startup";
import { taskVerifyGetRpc, taskVerifyRerunRpc } from "./shared/task-rpc";
import { createTaskPipeline } from "./server/task-pipeline";
import { createTaskVerifyStore } from "./server/task-store";
import { createTaskResources } from "./server/task-resources";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createNodeRunner } from "./server/collectors/common";
import { verifySettings } from "./shared/settings";
import { createVerifyPrompts } from "./server/prompts";
import { tuningOf, type VerifyTuning } from "./server/tuning";
import { isEvent, providerModelLabel, tabTitle } from "./server/vibe/contract";
import { createVerifyRegistry, type RunConfigs } from "./server/registry";
import { registerVerifyRpcs } from "./server/rpc";
import { createPaseoVerifierLauncher, type VerifierLauncher } from "./server/verifier/agent";
import {
  createDeviceLeases,
  createEventConsumer,
  createVibeStore,
  migrateOwner,
  openVibeDb,
  publishEvent,
  resolveVibeHome,
} from "./server/vibe/db";

export default function contribute(server: PluginServerContext) {
  const db = openVibeDb();
  migrateOwner(db, "scheduler");
  migrateOwner(db, "verify");
  const board = createVibeStore(db);
  const home = resolveVibeHome();
  const prompts = createVerifyPrompts(board);
  const startup = deferStartup(
    () => {
      prompts.register();
      for (const stale of taskVerify.running()) {
        taskVerify.writeNotes(stale.id, [
          "daemon 重启中断验证；先核对原生 agent 与资源，再重新验证",
        ]);
        taskVerify.finish(stale.id, "doubt");
        const task = board.tasks.get(stale.workspaceId);
        if (task && ["reviewing", "verifying"].includes(task.phase)) {
          board.tasks.setPhase(task.workspaceId, "paused");
          board.tasks.setSummary(
            task.workspaceId,
            "验证因 daemon 重启中断，资源状态待核对，请重新验证。",
          );
        }
      }
    },
    (error) => console.error("[vibe-verify] 后台初始化失败", error),
  );
  // Requests may arrive as soon as ready is sent; wait for the same startup promise.
  const host = server;
  server = {
    ...host,
    handle: (rpc, handler) => host.handle(rpc, startup.wrap(handler)),
    before: (name, handler) => host.before(name, startup.wrap(handler)),
    on: (name, handler) => host.on(name, startup.wrap(handler)),
    registerAgentTool: (tool) =>
      host.registerAgentTool({ ...tool, handler: startup.wrap(tool.handler) }),
  };

  const configs: RunConfigs = new Map();
  const log = (message: string, error?: unknown) =>
    console.error(`[vibe-verify] ${message}`, error ?? "");

  // Owner settings, read on every use; the env vars are the initial values while a setting is unset.
  const settings = server.registerSettings(verifySettings);
  let tuning: VerifyTuning = tuningOf(verifySettings.schema.parse({}));
  const applySettings = (state: Awaited<ReturnType<typeof settings.read>>) => {
    if (state.status === "ready") tuning = tuningOf(state.values);
  };
  void settings.read().then(applySettings);
  const stopSettings = settings.subscribe(applySettings);
  const getTuning = () => tuning;

  let paseo: PaseoApi | null = server.paseo;
  const remember = (api: PaseoApi) => void (paseo = api);
  for (const name of ["agent.created", "agent.turn_started", "agent.turn_ended"] as const) {
    server.on(name, (_event, { paseo: api }) => remember(api));
  }

  // The board registers every created agent from its agent.created hook; this claim overrides
  // that default registration with the referee identity once the task row is readable.
  const claimTab: NonNullable<
    Parameters<typeof createPaseoVerifierLauncher>[0]["claimTab"]
  > = async (input) => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const task = board.tasks.get(input.workspaceId);
      if (task) {
        const extra = {
          ...(input.thinking ? { thinking: input.thinking } : {}),
          ...(input.presetId ? { presetId: input.presetId } : {}),
        };
        const label = paseo
          ? await providerModelLabel(paseo, input.provider, input.model).catch(() => input.model)
          : input.model;
        const modelLabel = label && label !== input.model ? label : undefined;
        board.tasks.allocateTab(input.workspaceId, {
          agentId: input.agentId,
          role: input.role,
          provider: input.provider,
          model: input.model,
          ...extra,
          ...(modelLabel ? { modelLabel } : {}),
        });
        const tab = board.tasks.updateTab(input.workspaceId, input.agentId, {
          role: input.role,
          provider: input.provider,
          model: input.model,
          ...extra,
          modelLabel: modelLabel ?? null,
        });
        await paseo?.agents
          .ref(input.agentId)
          .setTitle(tabTitle(tab))
          .catch((error) => log("验证 tab 标题设置失败", error));
        return;
      }
      if (Date.now() >= deadline) throw new Error("验证 tab 未能登记到任务：等待任务登记超时");
      await delay(200);
    }
  };
  const launcher: VerifierLauncher = createPaseoVerifierLauncher({
    getPaseo: () => paseo,
    prompts,
    roundTimeoutMs: () => tuning.roundTimeoutMs,
    claimTab,
    log,
  });

  const taskVerify = createTaskVerifyStore(db, join(home, "verify"));
  const resources = createTaskResources(db, {
    log,
    current: (workspaceId) => board.tasks.get(workspaceId),
    waiting: async (workspaceId, reason) => {
      const task = board.tasks.get(workspaceId);
      if (!task) return;
      const text = "验证排队：" + reason;
      board.tasks.setSummary(workspaceId, text);
    },
  });
  const taskPipeline = createTaskPipeline({
    board,
    verify: taskVerify,
    runner: createNodeRunner(),
    launcher,
    configs,
    prompts,
    tuning: getTuning,
    log,
    registry: createVerifyRegistry({
      configs,
      leases: createDeviceLeases(db).provider,
      readyTimeoutMs: () => tuning.readyTimeoutMs,
    }),
    acquire: resources.acquire,
    worktreeRoot:
      process.env.VIBE_WORKTREE_ROOT?.trim() ||
      (process.platform === "win32" ? "D:/devRepoCaches/worktrees" : join(home, "worktrees")),
    async workspace(workspaceId) {
      if (!paseo) throw new Error("等待原生连接后重新验证");
      const native = await paseo.workspaces.ref(workspaceId).refresh();
      if (!native || !native.projectId || native.archivingAt)
        throw new Error("原生任务 workspace 不可用");
      const project = board.projectConfigs.get(native.projectId);
      if (!project) throw new Error("原生项目尚未关联任务扩展配置");
      return {
        projectId: project.id,
        repoPath: project.repoPath,
        worktreePath: native.workspaceDirectory,
        projectTypes: project.projectTypes,
      };
    },
    async timeline(agentId: string) {
      if (!paseo) throw new Error("等待原生连接后重新核对验证 tab 时间线");
      const page = await paseo.agents
        .ref(agentId)
        .timeline.refetch({ direction: "tail", limit: 1_000 });
      return page.entries ?? [];
    },
    // The board owns task artifacts; verification summaries append to the anchor tab timeline
    // with the task-verification renderer, which can open the report and evidence. The daemon
    // merges same-id rows at the first row's position, so a summary keys on its verification:
    // updates of one round stay together and later rounds never overwrite earlier ones.
    async append(
      task: { workspaceId: string; anchorAgentId: string },
      text: string,
      verificationId?: string,
    ) {
      if (!paseo) return;
      await paseo.agents.ref(task.anchorAgentId).timeline.append({
        type: "plugin",
        id: "verify-status:" + (verificationId ?? randomUUID()),
        kind: "task-verification",
        version: 1,
        data: {
          workspaceId: task.workspaceId,
          text,
          ...(verificationId ? { verificationId } : {}),
        },
      });
    },
  });
  const startTask = (workspaceId: string) =>
    void taskPipeline.run(workspaceId).catch((error) => log("任务验证失败", error));
  server.handle(taskVerifyGetRpc, ({ workspaceId, verificationId }, context) => {
    remember(context.paseo);
    if (!board.tasks.get(workspaceId)) throw new Error("任务不存在");
    const id = verificationId ?? taskVerify.list(workspaceId).at(-1)?.id;
    const detail = id ? taskVerify.detail(id) : null;
    if (detail && detail.verification.workspaceId !== workspaceId)
      throw new Error("验证记录不属于此任务");
    return { detail };
  });
  server.handle(taskVerifyRerunRpc, ({ workspaceId }, context) => {
    remember(context.paseo);
    const task = board.tasks.get(workspaceId);
    if (!task || !task.confirmedAt || !task.plan || !task.rolesSnapshot)
      throw new Error("任务没有有效的执行确认");
    if (taskPipeline.isRunning(workspaceId)) return { started: false };
    if (!["paused", "reviewing", "verifying", "awaiting_acceptance"].includes(task.phase))
      throw new Error("当前阶段不能重新验证");
    if (task.phase === "awaiting_acceptance") board.tasks.setPhase(workspaceId, "paused");
    if (board.tasks.get(workspaceId)!.phase === "paused")
      board.tasks.setPhase(workspaceId, task.rolesSnapshot.reviewer ? "reviewing" : "verifying");
    startTask(workspaceId);
    return { started: true };
  });

  const consumer = createEventConsumer({
    db,
    consumer: "vibe-verify",
    types: ["task.updated", "context.continuation_requested"],
    startAt: "now",
    handler: async (event) => {
      await startup.ready;
      if (
        isEvent(event, "context.continuation_requested") &&
        ["reviewer", "verifier"].includes(event.payload.role) &&
        event.payload.workspaceId
      ) {
        const task = board.tasks.get(event.payload.workspaceId);
        if (
          task &&
          task.confirmedAt === event.payload.confirmedAt &&
          ["reviewing", "verifying"].includes(task.phase)
        ) {
          board.tasks.setPhase(task.workspaceId, "paused");
          const text = "验证会话需要上下文交接，任务已暂停；先核对原生会话与资源停止，再重新验证。";
          board.tasks.setSummary(task.workspaceId, text);
        }
        publishEvent(db, {
          type: "context.continuation_result",
          payload: {
            requestId: event.payload.requestId,
            workspaceId: event.payload.workspaceId,
            status: "paused",
            reason: "验证证据轮次需要从稳定提交重新运行，未自动创建写入者",
          },
        });
      }
      if (isEvent(event, "task.updated")) {
        const task = board.tasks.get(event.payload.workspaceId);
        if (
          event.payload.fields.includes("phase") &&
          task &&
          task.flowLevel !== "simple" &&
          ["reviewing", "verifying"].includes(task.phase)
        )
          startTask(task.workspaceId);
      }
    },
    onError: (error) => log("event handling failed", error),
  });
  consumer.start();

  registerVerifyRpcs(server, {
    verify: taskVerify,
    evidenceRoot: join(home, "verify"),
  });

  return async () => {
    await startup.close();
    stopSettings();
    await consumer.stop();
    await resources.stop();
    db.close();
  };
}
