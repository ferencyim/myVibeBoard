import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { join } from "node:path";
import { startNotifyConsumer, type PushNotification } from "./server/notify";
import { createMasterRuntime } from "./server/runtime";
import { createVibeStore, migrateOwner, openVibeDb, resolveVibeHome } from "./server/vibe/db";
import {
  masterSettings,
  permissionRpc,
  promptsClearRpc,
  promptsListRpc,
  promptsSetRpc,
  sessionsRpc,
  statusRpc,
  taskWakeRpc,
  type MasterSettings,
} from "./shared/rpc";

export default function contribute(server: PluginServerContext) {
  const db = openVibeDb();
  migrateOwner(db, "core");
  const store = createVibeStore(db);
  const settings = server.registerSettings(masterSettings);

  let current: MasterSettings = masterSettings.schema.parse({});
  let runtime: ReturnType<typeof createMasterRuntime> | null = null;
  let maintainRequirements = current.maintainRequirements;
  const applySettings = (state: Awaited<ReturnType<typeof settings.read>>) => {
    if (state.status !== "ready") return;
    current = state.values;
    // The task_done reply format depends on this switch: refresh the registered suffix.
    if (current.maintainRequirements !== maintainRequirements) {
      maintainRequirements = current.maintainRequirements;
      runtime?.prompts.register();
    }
    // Dispatch availability for the scheduler, and a newly chosen preset for a running master.
    void runtime?.onSettingsChanged();
  };
  void settings.read().then((state) => {
    applySettings(state);
    // One-time move of prompts edited in the old settings page into the prompt registry.
    runtime?.migrateLegacyPrompts();
    return undefined;
  });
  const stopSettings = settings.subscribe(applySettings);

  // The SDK handle only reaches plugins through hook/RPC contexts: keep the newest one.
  let paseo: PaseoApi | null = null;
  const master = createMasterRuntime({
    db,
    store,
    getPaseo: () => paseo,
    settings: () => current,
    dataDir: join(resolveVibeHome(), "master"),
  });
  runtime = master;
  const onPaseo = (api: PaseoApi) => {
    if (paseo === api) return;
    paseo = api;
    master.onPaseoAvailable();
  };

  const offs = [
    server.on("agent.created", (_e, { paseo: api }) => onPaseo(api)),
    server.on("agent.turn_started", (_e, { paseo: api }) => onPaseo(api)),
    server.on("agent.turn_ended", (_e, { paseo: api }) => onPaseo(api)),
    server.on("workspace.created", (_e, { paseo: api }) => onPaseo(api)),
    server.on("agent.permission_requested", ({ agent, request }, { paseo: api }) => {
      onPaseo(api);
      return master
        .onPermissionRequest(agent.id, request, (requestId) =>
          api.agents
            .ref(agent.id)
            .respondToPermission({ requestId, response: { behavior: "allow" } }),
        )
        .then(
          () => undefined,
          (error) => console.error("vibe-master permission request:", error),
        );
    }),
  ];

  server.handle(statusRpc, async (_input, { paseo: api }) => {
    onPaseo(api);
    return master.status();
  });

  server.handle(permissionRpc, async (input, { paseo: api }) => {
    onPaseo(api);
    const result = await master.setPermission(input.mode);
    return { changed: result.changed, permission: (await master.status()).permission };
  });

  server.handle(sessionsRpc, async (input, { paseo: api }) => {
    onPaseo(api);
    return { sessions: master.sessions(input.limit) };
  });

  server.handle(taskWakeRpc, (input, { paseo: api }) => {
    onPaseo(api);
    return master.wake(input.workspaceId, input.force);
  });

  const masterPrompt = (key: string) => {
    if (!store.prompts.list().some((prompt) => prompt.key === key && prompt.role === "master")) {
      throw new Error("只能在总 agent 面板修改总 agent 的提示词");
    }
  };
  server.handle(promptsListRpc, ({ projectId }) => ({
    prompts: store.prompts
      .list({ projectId: projectId ?? null })
      .filter((prompt) => prompt.role === "master"),
    projects: store.projects.list(false).map(({ id, name, prefix }) => ({ id, name, prefix })),
  }));
  server.handle(promptsSetRpc, ({ key, text, projectId }) => {
    masterPrompt(key);
    store.prompts.setOverride(key, text, { projectId: projectId ?? null });
    return { ok: true as const };
  });
  server.handle(promptsClearRpc, ({ key, projectId }) => {
    masterPrompt(key);
    store.prompts.clearOverride(key, { projectId: projectId ?? null });
    return { ok: true as const };
  });

  // Hosts that expose the handle and push at start-up (server.paseo / server.notify) need no hook
  // or RPC first; older hosts keep working through the paths above.
  const host = server as { paseo?: PaseoApi; notify?: (notification: PushNotification) => void };
  if (host.paseo) onPaseo(host.paseo);
  const notifier = host.notify
    ? startNotifyConsumer({
        db,
        store,
        notify: host.notify,
        onError: (error) => console.error("vibe-master notify:", error),
      })
    : null;

  master.startQuotaMonitor();
  master.sweep();

  return async () => {
    await notifier?.stop();
    for (const off of offs) off();
    stopSettings();
    await master.dispose();
    db.close();
  };
}
