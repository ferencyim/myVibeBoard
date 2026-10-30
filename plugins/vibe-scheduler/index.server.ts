import {
  readResourceBriefing,
  readResourceMeta,
  writeResourceMeta,
  type RemoteHost,
} from "./server/vibe/db";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  devicesRpc,
  remoteHostsRpc,
  registerDeviceRpc,
  removeDeviceRpc,
  schedulerSettings,
  statusRpc,
  taskResourceRpc,
  taskTickRpc,
  queueOrderRpc,
  hubStatusRpc,
  hubQueueReorderRpc,
  hubResourcesListRpc,
  hubResourcesUpsertRpc,
  hubResourcesRemoveRpc,
  hubSettingsGetRpc,
  hubSettingsSetRpc,
  hubPauseCreateRpc,
  hubPauseListRpc,
  hubPauseRevokeRpc,
  hubTakeoverGetRpc,
  hubTakeoverSetRpc,
  hubHistoryRpc,
  hubThresholdsSetRpc,
  hubThresholdsHistoryRpc,
} from "./shared/rpc";
import { createSchedulerRuntime, DEFAULT_SETTINGS, type RuntimeSettings } from "./server/runtime";
import { migrateOwner, openVibeDb, resolveVibeHome } from "./server/vibe/db";
import { fromThresholds, toPageResource, toPageStatus, toThresholds } from "./server/hub-page";
import { registerBotTools, requireIndependentBot } from "./server/bot-tools";
import { createCoordinatorNotifier, createHubWatcher } from "./server/hub-events";
import { createHubHistory, createHubTuning } from "./server/hub-tuning";
import { registerDirectives } from "./server/directive-register";

/**
 * hub.json and the guard admission file. A dev/test daemon (VIBE_HOME set) must not touch the real
 * ones, so it gets private paths unless VIBE_HUB_DIR / VIBE_HUB_ADMISSION_FILE say otherwise.
 */
function hubPaths() {
  const env = process.env;
  if (env.VIBE_HOME?.trim()) {
    const dir = join(env.VIBE_HOME.trim(), "hub");
    return {
      hubDir: env.VIBE_HUB_DIR || dir,
      hubAdmissionFile: env.VIBE_HUB_ADMISSION_FILE || join(dir, "admission.json"),
    };
  }
  if (process.platform !== "win32" && !env.VIBE_HUB_DIR) return {};
  return {
    hubDir: env.VIBE_HUB_DIR || "D:\\devRepoCaches\\validation\\locks\\win-heavy",
    hubAdmissionFile:
      env.VIBE_HUB_ADMISSION_FILE || "D:\\devRepo\\ci-dashboard\\queue\\win-heavy-guard.admission.json",
  };
}

export default function contribute(server: PluginServerContext) {
  const db = openVibeDb();
  migrateOwner(db, "scheduler");
  const settings = server.registerSettings(schedulerSettings);

  // Recovery and resource admission can run before any new hook or UI RPC.
  let paseo: PaseoApi | null = server.paseo;
  const remember = (api: PaseoApi) => void (paseo = api);

  const runtime = createSchedulerRuntime({
    db,
    dataDir: join(resolveVibeHome(), "scheduler"),
    ...hubPaths(),
    onError: (error) => console.error("vibe-scheduler:", error),
    native: async (workspaceId) => {
      if (!paseo) throw new Error("尚未连接原生宿主，暂停派发");
      const workspace = paseo.workspaces.ref(workspaceId);
      // refresh completes a host query, including every page; null confirms absence.
      const snapshot = await workspace.refresh();
      if (!snapshot) return null;
      // archivingAt is an in-progress operation that can still fail to stop agents.
      if (snapshot.archivingAt) throw new Error("原生工作区正在归档，等待归档完成后核对");
      if (!workspace.directory || !workspace.projectId)
        throw new Error("原生工作区元数据尚未就绪，等待重试");
      const agents = [];
      let cursor: string | undefined;
      do {
        const page = await paseo.agents.list({
          filter: { includeArchived: true, includeInternal: true },
          page: { limit: 100, ...(cursor ? { cursor } : {}) },
        });
        agents.push(
          ...page.entries
            .map((entry) => entry.agent)
            .filter((agent) => agent.workspaceId === workspaceId),
        );
        cursor = page.pageInfo.hasMore ? (page.pageInfo.nextCursor ?? undefined) : undefined;
      } while (cursor);
      return {
        workspaceId,
        projectId: workspace.projectId,
        directory: workspace.directory,
        archived: false,
        agents,
      };
    },
    fetchUsage: () => (paseo ? paseo.providers.listUsage().then((r) => r.providers) : null),
    routineTick: async (input) => {
      if (!paseo) return;
      await paseo.plugins.invoke("vibe-bots", "routine.tick", input);
    },
  });

  registerBotTools(server, runtime, () => paseo);
  const notifyCoordinator = createCoordinatorNotifier({
    send: async (text) => {
      if (!paseo) return { accepted: false };
      return paseo.plugins.invoke("vibe-bots", "bots.notify", {
        target: "coordinator",
        text,
        source: "中枢",
      });
    },
    onError: (error) => console.error("vibe-scheduler: 通知总协调失败：", error),
  });
  const stopDirectives = registerDirectives(server, db, {
    notifyCoordinator,
    pause: {
      create: async (input) => {
        const pause = await runtime.hub.createPause({
          scope: input.scope,
          until: input.until,
          reason: input.reason,
          issuedBy: input.issuedBy,
        });
        return { id: pause.id };
      },
      remove: async (id) => {
        await runtime.hub.revokePause(id);
      },
    },
  });
  const history = createHubHistory({
    db,
    load: () => runtime.hub.load(),
    lockDir: hubPaths().hubDir,
    onEvent: (event) => {
      const label: Record<string, string> = {
        commit_high: "提交内存 commit 已达 95% 以上",
        memory_low: "可用内存低于 2GB",
        job_oom: "有重任务因内存或提交上限失败",
        job_commit_limit: "有重任务触到单任务提交上限",
      };
      notifyCoordinator(
        "tune-event:" + event.kind,
        `[阈值复核] ${label[event.kind] ?? event.kind}。请用 vibe_hub_history 复核阈值是否过松，必要时下调。`,
      );
    },
  });
  runtime.hub.onSample((m) => history.record(m));
  runtime.hub.onJobFinished((job) => history.jobFinished(job));
  const flushHistory = setInterval(() => history.flush(), 60_000);
  (flushHistory as unknown as { unref?: () => void }).unref?.();
  const tuning = createHubTuning({
    db,
    history,
    settings: () => runtime.hub.settings(),
    update: (patch) => runtime.hub.updateSettings(patch),
    notifyUser: (title, body) => server.notify({ title, body }),
    tellCoordinator: (key, text) => notifyCoordinator(key, text),
  });
  const watchHub = createHubWatcher({ hub: runtime.hub, notify: notifyCoordinator });
  const hubWatchTimer = setInterval(() => {
    watchHub().catch((error) => console.error("vibe-scheduler: 中枢事件检查失败：", error));
  }, 30_000);
  (hubWatchTimer as unknown as { unref?: () => void }).unref?.();

  const apply = (state: Awaited<ReturnType<typeof settings.read>>) => {
    if (state.status !== "ready") return;
    runtime.setSettings({
      ...DEFAULT_SETTINGS,
      ...state.values,
    } as RuntimeSettings);
  };
  const ready = settings.read().then(apply);
  const stopSettings = settings.subscribe(apply);
  void ready.then(() => runtime.start());

  const stopHooks = [
    server.on("agent.created", (_e, c) => remember(c.paseo)),
    server.on("agent.turn_started", async (event, context) => {
      remember(context.paseo);
      if (!event.agent.workspaceId) return;
      const admitted = await runtime.scheduler.observeAgent(
        event.agent.workspaceId,
        event.agent.id,
      );
      if (admitted) return;
      const agent = context.paseo.agents.ref(event.agent.id) as unknown as {
        cancel?: () => Promise<unknown>;
      };
      if (agent.cancel) await agent.cancel();
      else
        console.error(
          "vibe-scheduler: 宿主缺少 agent cancel；已冻结新派发，请升级宿主并停止未准入会话",
        );
    }),
    server.on("agent.turn_ended", async (event, context) => {
      remember(context.paseo);
      if (event.agent.workspaceId)
        await runtime.scheduler.endNativePlanner(event.agent.workspaceId, event.agent.id);
    }),
    server.on("workspace.created", (_e, c) => remember(c.paseo)),
  ];

  server.handle(statusRpc, (_input, c) => {
    remember(c.paseo);
    return {
      ...runtime.scheduler.status(),
      resources: runtime.latest(),
      ...readResourceBriefing(db),
      quota: runtime.quota(),
      ports: runtime.ports.all(),
      pool: runtime.leases.poolStatus(),
    };
  });

  server.handle(remoteHostsRpc, (input) => {
    if (input.hosts) {
      if (new Set(input.hosts.map((host) => host.target)).size !== input.hosts.length)
        throw new Error("SSH 目标不能重复");
      writeResourceMeta(db, "scheduler.remote_hosts", input.hosts);
    }
    return { hosts: readResourceMeta<RemoteHost[]>(db, "scheduler.remote_hosts", []) };
  });

  server.handle(taskResourceRpc, (input, context) => {
    remember(context.paseo);
    return runtime.scheduler.requestResource(input);
  });
  server.handle(queueOrderRpc, ({ workspaceIds, reason }, { callerAgentId }) => {
    if (callerAgentId) throw new Error("bot 请使用受权限限制的 vibe_queue_reorder 工具");
    return runtime.scheduler.setQueueOrder(workspaceIds, reason);
  });
  server.handle(taskTickRpc, async (_input, context) => {
    remember(context.paseo);
    return { ...(await runtime.tickOnce()) };
  });

  server.handle(hubStatusRpc, async () => toPageStatus(await runtime.hub.status()));
  server.handle(hubQueueReorderRpc, async ({ order, priorities, reason }, { callerAgentId }) => {
    // Only the coordinator bot may reorder; other agents are refused.
    if (callerAgentId) {
      if (!paseo) throw new Error("宿主尚未连接，请稍后重试");
      const api = paseo;
      await requireIndependentBot(callerAgentId, (pluginId, method, input) =>
        api.plugins.invoke(pluginId, method, input),
      );
    }
    const kinds = new Map((await runtime.hub.status()).queue.map((q) => [q.id, q.kind]));
    return runtime.hub.reorder({
      order: order.map((id) => ({ kind: kinds.get(id) ?? "job", id })),
      priorities,
      reason: reason ?? "中枢页面调整",
    });
  });
  server.handle(hubResourcesListRpc, () => ({
    resources: runtime.hub.listResources().map(toPageResource),
  }));
  server.handle(hubResourcesUpsertRpc, ({ name, limit, note }) =>
    toPageResource(runtime.hub.upsertResource({ name, maxShared: limit, note })),
  );
  server.handle(hubResourcesRemoveRpc, ({ name }) => ({ ok: runtime.hub.removeResource(name) }));
  server.handle(hubSettingsGetRpc, () => ({ thresholds: toThresholds(runtime.hub.settings()) }));
  server.handle(hubSettingsSetRpc, async ({ thresholds }, { callerAgentId }) => {
    if (callerAgentId) throw new Error("总协调请用 vibe_hub_thresholds_set（有安全底线与幅度限制）");
    const before = runtime.hub.settings();
    const result = await runtime.hub.updateSettings(fromThresholds(thresholds));
    tuning.recordUser(before, result.settings);
    return { thresholds: toThresholds(result.settings), fileError: result.fileError };
  });
  server.handle(hubHistoryRpc, ({ hours }) => ({ ...history.query(hours ?? 24), limits: tuning.limits }));
  server.handle(hubThresholdsSetRpc, async (input, { callerAgentId }) => {
    if (!callerAgentId) throw new Error("阈值自动调整只能由总协调 bot 调用");
    return { ...(await tuning.set(input)) };
  });
  server.handle(hubThresholdsHistoryRpc, ({ limit }) => ({ changes: tuning.history(limit) }));
  server.handle(hubPauseCreateRpc, async (input, { callerAgentId }) => {
    const bot = !!callerAgentId || input.issuedBy === "bot";
    if (bot) {
      // A bot's pause is a temporary operations window: it needs an end and may not exceed 24 hours.
      const until = input.until ? Date.parse(input.until) : NaN;
      if (!Number.isFinite(until) || until - Date.now() > 24 * 3_600_000)
        throw new Error("bot 下发的暂停必须设置结束时间，且不超过 24 小时");
    }
    return { ...(await runtime.hub.createPause({ ...input, issuedBy: bot ? "bot" : (input.issuedBy ?? "user") })) };
  });
  server.handle(hubPauseListRpc, ({ activeOnly }) => ({
    pauses: runtime.hub.listPauses(activeOnly ?? true).map((p) => ({ ...p })),
  }));
  server.handle(hubPauseRevokeRpc, async ({ id }, { callerAgentId }) => {
    if (callerAgentId && runtime.hub.listPauses(true).find((p) => p.id === id)?.issuedBy === "user")
      throw new Error("bot 不能撤销用户设置的暂停");
    return { ok: await runtime.hub.revokePause(id) };
  });
  const takeoverState = () => ({
    enabled: runtime.takeover().enabled,
    active: runtime.takeover().active,
    available: runtime.takeover().available,
    disabledFile: runtime.takeover().disabledFile,
  });
  server.handle(hubTakeoverGetRpc, () => takeoverState());
  server.handle(hubTakeoverSetRpc, async ({ enabled }, { callerAgentId }) => {
    if (callerAgentId) throw new Error("接管全机重任务只能由用户开关");
    await runtime.setTakeover(enabled);
    return takeoverState();
  });

  server.handle(devicesRpc, () => ({
    devices: runtime.leases.listDevices().map((device) => ({
      id: device.id,
      kind: device.kind,
      name: device.name,
      meta: device.meta,
    })),
  }));
  server.handle(registerDeviceRpc, ({ kind, name, serial, avd }) => ({
    ...runtime.leases.registerDevice({
      kind,
      name,
      meta: { ...(serial ? { serial } : {}), ...(avd ? { avd } : {}) },
    }),
  }));
  server.handle(removeDeviceRpc, ({ id }) => {
    runtime.leases.removeDevice(id);
    return { ok: true };
  });

  return async () => {
    stopSettings();
    stopDirectives();
    clearInterval(hubWatchTimer);
    clearInterval(flushHistory);
    history.flush();
    for (const stop of stopHooks) stop();
    await runtime.stop();
    db.close();
  };
}
