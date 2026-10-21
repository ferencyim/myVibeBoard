import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  maintainSettings,
  resumeRpc,
  rulesSettings,
  runRpc,
  statusRpc,
  type MaintainSettings,
} from "./shared/rpc";
import { EMPTY_RULES_CONFIG, type RulesConfig } from "./shared/rules";
import { createMaintenanceEngine } from "./server/engine";
import { perfSlowCheck } from "./server/checks/perf-slow";
import { gitCheck } from "./server/git/check";
import { execGit } from "./server/git/exec";
import { createFixLauncher, createSubAgentRunner } from "./server/launch";
import { createVibeStore, migrateOwner, openVibeDb } from "./server/vibe/db";

export default function contribute(server: PluginServerContext) {
  const db = openVibeDb();
  migrateOwner(db, "core");
  migrateOwner(db, "maintain");
  const store = createVibeStore(db);
  const settings = server.registerSettings(maintainSettings);

  let current: MaintainSettings = maintainSettings.schema.parse({});
  const apply = (state: Awaited<ReturnType<typeof settings.read>>) => {
    if (state.status === "ready") current = state.values;
  };
  const stopSettings = settings.subscribe(apply);
  const rulesStore = server.registerSettings(rulesSettings);
  let rulesConfig: RulesConfig = EMPTY_RULES_CONFIG;
  const stopRules = rulesStore.subscribe((state) => {
    if (state.status === "ready") rulesConfig = state.values;
  });
  void rulesStore.read().then((state) => {
    if (state.status === "ready") rulesConfig = state.values;
  });

  // The SDK handle only reaches plugins through hook/RPC contexts: keep the newest one.
  let paseo: PaseoApi | null = null;
  const remember = (api: PaseoApi) => void (paseo = api);
  const agentPorts = {
    getPaseo: () => paseo,
    defaultAgent: () => current.defaultAgent,
    presets: () => store.presets.list(),
  };

  const engine = createMaintenanceEngine({
    db,
    store,
    git: execGit,
    checks: { git: gitCheck, "perf-slow": perfSlowCheck },
    settings: () => current,
    uiRules: () => rulesConfig,
    subAgent: createSubAgentRunner(agentPorts),
    fixLauncher: createFixLauncher(agentPorts),
    log: (message, error) => console.error(`vibe-maintain: ${message}`, error ?? ""),
  });

  const stopHooks = [
    server.on("agent.created", (_e, c) => remember(c.paseo)),
    server.on("agent.turn_started", (_e, c) => remember(c.paseo)),
    server.on("agent.turn_ended", (_e, c) => remember(c.paseo)),
    server.on("workspace.created", (_e, c) => remember(c.paseo)),
  ];

  const specOf = (p: { provider: string; model: string }) =>
    p.model.startsWith(`${p.provider}/`) ? p.model : `${p.provider}/${p.model}`;
  server.handle(statusRpc, async (_input, c) => {
    remember(c.paseo);
    await engine.syncRules(); // a UI edit shows up without waiting for the next tick
    return JSON.parse(
      JSON.stringify({
        ...engine.status(),
        projects: store.projects.list().map((p) => ({ id: p.id, name: p.name })),
        presets: store.presets.list().map((p) => ({ id: p.id, name: p.name, spec: specOf(p) })),
      }),
    );
  });
  server.handle(runRpc, async ({ ruleId }, c) => {
    remember(c.paseo);
    await engine.syncRules();
    const outcome = await engine.runNow(ruleId);
    return outcome.status === "fired"
      ? { status: "fired", run: outcome.run }
      : { status: "blocked", why: outcome.why };
  });
  server.handle(resumeRpc, ({ ruleId }) => ({ rule: engine.resume(ruleId) }));

  engine.start();
  let ticking = false;
  const runTick = () => {
    if (ticking) return;
    ticking = true;
    engine
      .tick()
      .catch((error) => console.error("vibe-maintain: tick failed", error))
      .finally(() => void (ticking = false));
  };
  // The tick period is a setting: start the timer once the settings are loaded.
  let timer: ReturnType<typeof setInterval> | null = null;
  void settings.read().then((state) => {
    apply(state);
    timer = setInterval(runTick, current.tickSeconds * 1000);
    (timer as unknown as { unref?: () => void }).unref?.();
    runTick();
  });

  return async () => {
    if (timer) clearInterval(timer);
    stopSettings();
    stopRules();
    for (const stop of stopHooks) stop();
    await engine.stop();
    db.close();
  };
}
