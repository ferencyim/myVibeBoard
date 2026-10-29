import { botModelsListRpc } from "./shared/rpc";
import { deferStartup } from "./server/vibe/db/startup";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { join } from "node:path";
import { startNotifyConsumer, type PushNotification } from "./server/notify";
import { createMasterRuntime } from "./server/runtime";
import { createVibeStore, migrateOwner, openVibeDb, resolveVibeHome } from "./server/vibe/db";
import {
  masterSettings,
  masterBotMigrationRpc,
  botsListRpc,
  botsCreateRpc,
  botsOpenRpc,
  botsStateRpc,
  botsArchiveRpc,
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
  const applySettings = (state: Awaited<ReturnType<typeof settings.read>>) => {
    if (state.status !== "ready") return;
    current = state.values;
    // Apply a newly chosen preset for a running master.
    void runtime?.onSettingsChanged();
  };
  const settingsReady = settings.read();
  const startup = deferStartup(
    async () => {
      const state = await settingsReady;
      // Register with the persisted suffix before catch-up can send a prompt.
      if (state.status === "ready") current = state.values;
      master.prompts.register();
      master.migrateLegacyPrompts();
      void startup.ready
        .then(() => master.onSettingsChanged())
        .catch((error) => console.error("[vibe-master] 设置应用失败", error));
      master.sweep();
    },
    (error) => console.error("[vibe-master] 后台初始化失败", error),
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

  const stopSettings = settings.subscribe((state) => {
    void startup
      .wrap(applySettings)(state)
      .catch((error) => console.error("[vibe-master] 设置更新失败", error));
  });

  // The SDK handle only reaches plugins through hook/RPC contexts: keep the newest one.
  let paseo: PaseoApi | null = null;
  const master = createMasterRuntime({
    db,
    store,
    getPaseo: () => paseo,
    settings: () => current,
    dataDir: join(resolveVibeHome(), "master"),
    promptsReady: startup.ready,
    managedByBots: true,
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

  server.handle(masterBotMigrationRpc, (_input, { callerAgentId }) => {
    if (callerAgentId) throw new Error("旧总 bot 配置迁移仅供宿主或用户读取");
    return master.botMigrationSnapshot();
  });

  server.handle(botModelsListRpc, async (input, { paseo: api, callerAgentId }) => {
    if (callerAgentId) throw new Error("模型目录仅供用户使用");
    return botModelsListRpc.output.parse(await api.plugins.invoke("vibe-bots", "models.list", input));
  });
  server.handle(botsListRpc, async (input, { paseo: api, callerAgentId }) => {
    if (callerAgentId) throw new Error("bot 请使用不含个人记忆的 vibe_bot_read 工具");
    return botsListRpc.output.parse(await api.plugins.invoke("vibe-bots", botsListRpc.name, input));
  });
  server.handle(botsCreateRpc, async (input, { paseo: api, callerAgentId }) => {
    if (callerAgentId) throw new Error("请通过 bot 的自配置工具创建 bot");
    return botsCreateRpc.output.parse(await api.plugins.invoke("vibe-bots", botsCreateRpc.name, input));
  });
  server.handle(botsOpenRpc, async (input, { paseo: api, callerAgentId }) => {
    if (callerAgentId) throw new Error("请由用户打开 bot 对话");
    return botsOpenRpc.output.parse(await api.plugins.invoke("vibe-bots", botsOpenRpc.name, input));
  });
  server.handle(botsArchiveRpc, async (input, { paseo: api, callerAgentId }) => {
    if (callerAgentId) throw new Error("请由用户归档 bot");
    return botsArchiveRpc.output.parse(await api.plugins.invoke("vibe-bots", botsArchiveRpc.name, input));
  });
  server.handle(botsStateRpc, async (input, { paseo: api, callerAgentId }) => {
    if (callerAgentId) throw new Error("请由用户查看 bot 对话创建状态");
    return botsStateRpc.output.parse(await api.plugins.invoke("vibe-bots", botsStateRpc.name, input));
  });

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
  const capabilities = server as {
    paseo?: PaseoApi;
    notify?: (notification: PushNotification) => void;
  };
  if (capabilities.paseo) onPaseo(capabilities.paseo);
  const notifier = capabilities.notify
    ? startNotifyConsumer({
        db,
        store,
        notify: capabilities.notify,
        onError: (error) => console.error("vibe-master notify:", error),
      })
    : null;

  return async () => {
    await startup.close();
    await notifier?.stop();
    for (const off of offs) off();
    stopSettings();
    await master.dispose();
    db.close();
  };
}
