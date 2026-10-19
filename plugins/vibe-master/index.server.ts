import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  masterSettings,
  statusRpc,
  switchRpc,
  wakeRpc,
  type MasterSettings,
} from "./shared/rpc";
import { createMasterRuntime } from "./server/runtime";
import { CARD_KEY_PATTERN } from "./server/vibe/contract";
import { createVibeStore, migrateOwner, openVibeDb, resolveVibeHome } from "./server/vibe/db";

export default function contribute(server: PluginServerContext) {
  const db = openVibeDb();
  migrateOwner(db, "core");
  const store = createVibeStore(db);
  const settings = server.registerSettings(masterSettings);

  let current: MasterSettings = masterSettings.schema.parse({});
  const applySettings = (state: Awaited<ReturnType<typeof settings.read>>) => {
    if (state.status === "ready") current = state.values;
  };
  void settings.read().then(applySettings);
  const stopSettings = settings.subscribe(applySettings);

  // The SDK handle only reaches plugins through hook/RPC contexts: keep the newest one.
  let paseo: PaseoApi | null = null;
  const runtime = createMasterRuntime({
    db,
    store,
    getPaseo: () => paseo,
    settings: () => current,
    dataDir: join(resolveVibeHome(), "master"),
  });
  const onPaseo = (api: PaseoApi) => {
    if (paseo === api) return;
    paseo = api;
    runtime.onPaseoAvailable();
  };

  const offs = [
    server.on("agent.created", (_e, { paseo: api }) => onPaseo(api)),
    server.on("agent.turn_started", (_e, { paseo: api }) => onPaseo(api)),
    server.on("agent.turn_ended", (_e, { paseo: api }) => onPaseo(api)),
    server.on("workspace.created", (_e, { paseo: api }) => onPaseo(api)),
  ];

  server.handle(statusRpc, async (input, { paseo: api }) => {
    onPaseo(api);
    return runtime.status(input.includeProviders);
  });

  server.handle(switchRpc, async (input, { paseo: api }) => {
    onPaseo(api);
    const result = await runtime.switchTo(
      { provider: input.provider, model: input.model, thinking: input.thinking },
      input.reason,
    );
    return { target: result.target, changed: result.changed, sessionId: result.sessionId };
  });

  server.handle(wakeRpc, async (input, { paseo: api }) => {
    onPaseo(api);
    const upper = input.card.toUpperCase();
    return runtime.wake(CARD_KEY_PATTERN.test(upper) ? upper : input.card, input.reason, input.force);
  });

  runtime.startQuotaMonitor();
  runtime.sweep();

  return async () => {
    for (const off of offs) off();
    stopSettings();
    await runtime.dispose();
    db.close();
  };
}
