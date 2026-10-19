import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  devicesRpc,
  registerDeviceRpc,
  removeDeviceRpc,
  schedulerSettings,
  selectAgentRpc,
  statusRpc,
} from "./shared/rpc";
import { createSchedulerRuntime, DEFAULT_SETTINGS, type RuntimeSettings } from "./server/runtime";
import { migrateOwner, openVibeDb, resolveVibeHome } from "./server/vibe/db";

export default function contribute(server: PluginServerContext) {
  const db = openVibeDb();
  migrateOwner(db, "scheduler");
  const settings = server.registerSettings(schedulerSettings);

  // The SDK handle only reaches plugins through hook/RPC contexts: keep the newest one.
  let paseo: PaseoApi | null = null;
  const remember = (api: PaseoApi) => void (paseo = api);

  const runtime = createSchedulerRuntime({
    db,
    dataDir: join(resolveVibeHome(), "scheduler"),
    onError: (error) => console.error("vibe-scheduler:", error),
    fetchUsage: () => (paseo ? paseo.providers.listUsage().then((r) => r.providers) : null),
  });

  const apply = (state: Awaited<ReturnType<typeof settings.read>>) => {
    if (state.status !== "ready") return;
    runtime.setSettings({ ...DEFAULT_SETTINGS, ...state.values } as RuntimeSettings);
  };
  const ready = settings.read().then(apply);
  const stopSettings = settings.subscribe(apply);
  void ready.then(() => runtime.start());

  const stopHooks = [
    server.on("agent.created", (_e, c) => remember(c.paseo)),
    server.on("agent.turn_started", (_e, c) => remember(c.paseo)),
    server.on("agent.turn_ended", (_e, c) => remember(c.paseo)),
    server.on("workspace.created", (_e, c) => remember(c.paseo)),
  ];

  server.handle(statusRpc, (_input, c) => {
    remember(c.paseo);
    return {
      ...runtime.scheduler.status(),
      resources: runtime.latest(),
      quota: runtime.quota(),
      ports: runtime.ports.all(),
      pool: runtime.leases.poolStatus(),
    };
  });

  server.handle(selectAgentRpc, async ({ repoPath, ...task }, c) => {
    remember(c.paseo);
    await runtime.refreshUsage(true);
    return { ...(await runtime.select(task, repoPath)) };
  });

  server.handle(devicesRpc, () => ({
    devices: runtime.leases.listDevices().map((d) => ({ ...d })),
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
