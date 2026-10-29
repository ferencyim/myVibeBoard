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
} from "./shared/rpc";
import { createSchedulerRuntime, DEFAULT_SETTINGS, type RuntimeSettings } from "./server/runtime";
import { migrateOwner, openVibeDb, resolveVibeHome } from "./server/vibe/db";

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
    onError: (error) => console.error("vibe-scheduler:", error),
    native: async (workspaceId) => {
      if (!paseo) throw new Error("尚未连接原生宿主，暂停派发");
      const workspace = paseo.workspaces.ref(workspaceId);
      await workspace.refresh();
      const snapshot = workspace.current();
      if (!snapshot || !workspace.directory || !workspace.projectId) return null;
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
        archived: !!snapshot.archivingAt,
        agents,
      };
    },
    fetchUsage: () => (paseo ? paseo.providers.listUsage().then((r) => r.providers) : null),
  });

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
  server.handle(taskTickRpc, async (_input, context) => {
    remember(context.paseo);
    return { ...(await runtime.tickOnce()) };
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
    for (const stop of stopHooks) stop();
    await runtime.stop();
    db.close();
  };
}
