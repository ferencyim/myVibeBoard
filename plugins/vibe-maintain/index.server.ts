import { deferStartup } from "./server/vibe/db/startup";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  maintainSettings,
  resumeRpc,
  rulesSettings,
  runRpc,
  statusRpc,
  systemRoutinesRpc,
  type MaintainSettings,
} from "./shared/rpc";
import { EMPTY_RULES_CONFIG, migrateRulesV1, type RulesConfig } from "./shared/rules";
import { BUILTIN_RULES } from "./server/config";
import { createMaintenanceEngine } from "./server/engine";
import { systemRoutines } from "./server/system-routines";
import { perfSlowCheck } from "./server/checks/perf-slow";
import { gitCheck } from "./server/git/check";
import { execGit } from "./server/git/exec";
import { createMaintenanceTaskLauncher } from "./server/launch";
import { randomUUID } from "node:crypto";
import { isEvent } from "./server/vibe/contract";
import {
  createVibeStore,
  createMaintenanceCommands,
  createTaskRuntimeCommands,
  migrateOwner,
  openVibeDb,
  getMaxSeq,
  publishEvent,
  readEvents,
} from "./server/vibe/db";

export default function contribute(server: PluginServerContext) {
  const db = openVibeDb();
  migrateOwner(db, "core");
  migrateOwner(db, "maintain");
  const store = createVibeStore(db);
  const runtime = createTaskRuntimeCommands(db);
  const maintenance = createMaintenanceCommands(db);
  const lifetime = new AbortController();
  const settings = server.registerSettings(maintainSettings);

  let current: MaintainSettings = maintainSettings.schema.parse({});
  const apply = (state: Awaited<ReturnType<typeof settings.read>>) => {
    if (state.status === "ready") current = state.values;
  };
  const stopSettings = settings.subscribe(apply);
  // v1 was keyed by project: the host runs this once, when it first reads an old file.
  const rulesStore = server.registerSettings({
    ...rulesSettings,
    migrate: (values, from) =>
      from === 1
        ? migrateRulesV1(
            values,
            store.projects.list().map((p) => p.id),
            BUILTIN_RULES,
          )
        : values,
  });
  let rulesConfig: RulesConfig = EMPTY_RULES_CONFIG;
  const stopRules = rulesStore.subscribe((state) => {
    if (state.status === "ready") rulesConfig = state.values;
  });
  const rulesReady = rulesStore.read().then((state) => {
    if (state.status !== "ready") throw new Error("维护规则配置尚未就绪，保留已有规则并暂停同步。");
    rulesConfig = state.values;
    return state.values;
  });

  // The SDK handle only reaches plugins through hook/RPC contexts: keep the newest one.
  let paseo: PaseoApi | null = null;
  const remember = (api: PaseoApi) => void (paseo = api);
  const agentPorts = {
    getPaseo: () => paseo,
    defaultAgent: () => current.defaultAgent,
    presets: () => store.presets.list(),
    store,
    runtime,
    signal: lifetime.signal,
    isTaskRejected: (workspaceId: string) => !!maintenance.links({ workspaceId })[0]?.rejectedAt,
    resource: async (input: {
      workspaceId: string;
      action: "acquire" | "bind" | "release";
      role?: "planner";
      provider?: string;
      model?: string;
      reservationId?: string;
      agentId?: string;
      presetId?: string;
    }) => {
      const requestId = randomUUID();
      let cursor = getMaxSeq(db);
      publishEvent(db, {
        type: "scheduler.task_resource_request",
        payload: { ...input, requestId },
      });
      const deadline = Date.now() + 30_000;
      while (!lifetime.signal.aborted && Date.now() < deadline) {
        for (const event of readEvents(db, cursor, {
          types: ["scheduler.task_resource_result"],
          limit: 100,
        })) {
          cursor = event.seq;
          if (
            isEvent(event, "scheduler.task_resource_result") &&
            event.payload.workspaceId === input.workspaceId &&
            event.payload.requestId === requestId
          )
            return event.payload;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return { ok: false, reason: "等待调度器资源响应超时" };
    },
  };

  const taskLauncher = createMaintenanceTaskLauncher(agentPorts);
  const engine = createMaintenanceEngine({
    db,
    store,
    git: execGit,
    checks: { git: gitCheck, "perf-slow": perfSlowCheck },
    settings: () => current,
    commitPollSeconds: () => current.commitPollSeconds,
    uiRules: () => rulesConfig,
    taskLauncher,
    projectIdOfTask: async (workspaceId) =>
      runtime.listSessions({ workspaceId }).find((session) => session.projectId)?.projectId ??
      undefined,
    stopTask: async (workspaceId) => {
      const requestId = randomUUID();
      let cursor = getMaxSeq(db);
      publishEvent(db, {
        type: "task.stop_requested",
        payload: { workspaceId, requestId, reason: "维护发现有变化，需停止后重新规划确认" },
      });
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        for (const event of readEvents(db, cursor, { types: ["task.stop_result"], limit: 100 })) {
          cursor = event.seq;
          if (
            isEvent(event, "task.stop_result") &&
            event.payload.workspaceId === workspaceId &&
            event.payload.requestId === requestId
          )
            return event.payload.stopped;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return false;
    },
    log: (message, error) => console.error(`vibe-maintain: ${message}`, error ?? ""),
  });

  const stopHooks = [
    server.on("agent.created", (_e, c) => remember(c.paseo)),
    server.on("agent.turn_started", (_e, c) => remember(c.paseo)),
    server.on("agent.turn_ended", async (event, c) => {
      remember(c.paseo);
      await taskLauncher.release(event.agent.id);
    }),
    server.on("workspace.created", (_e, c) => remember(c.paseo)),
    server.on("workspace.archived", (event, c) => {
      remember(c.paseo);
      engine.rejectWorkspace(event.workspace.id);
    }),
  ];

  const specOf = (p: { provider: string; model: string }) =>
    p.model.startsWith(`${p.provider}/`) ? p.model : `${p.provider}/${p.model}`;
  server.handle(statusRpc, async (_input, c) => {
    remember(c.paseo);
    await startup.ready;
    await engine.syncRules(); // a UI edit shows up without waiting for the next tick
    return JSON.parse(
      JSON.stringify({
        ...engine.status(),
        projects: store.projects.list().map((p) => ({ id: p.id, name: p.name })),
        presets: store.presets.list().map((p) => ({ id: p.id, name: p.name, spec: specOf(p) })),
      }),
    );
  });
  server.handle(systemRoutinesRpc, async (_input, c) => {
    remember(c.paseo);
    await startup.ready;
    await engine.syncRules();
    return { routines: systemRoutines(engine.status()) };
  });
  server.handle(runRpc, async ({ ruleId, ruleName, projectId }, c) => {
    remember(c.paseo);
    await startup.ready;
    await engine.syncRules();
    if (ruleName) {
      const results = (await engine.runRuleNow(ruleName, projectId)).map((r) => ({
        projectId: r.projectId,
        status: r.outcome.status,
        why: r.outcome.status === "blocked" ? r.outcome.why : undefined,
      }));
      return { status: results.some((r) => r.status === "fired") ? "fired" : "blocked", results };
    }
    if (!ruleId) throw new Error("ruleId or ruleName is required");
    const outcome = await engine.runNow(ruleId);
    return outcome.status === "fired"
      ? { status: "fired", run: outcome.run }
      : { status: "blocked", why: outcome.why };
  });
  server.handle(resumeRpc, async ({ ruleId }) => {
    await startup.ready;
    return { rule: engine.resume(ruleId) };
  });

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
  const startup = deferStartup(
    async () => {
      const [state] = await Promise.all([settings.read(), rulesReady]);
      if (lifetime.signal.aborted) return;
      apply(state);
      engine.start();
      timer = setInterval(runTick, current.tickSeconds * 1000);
      (timer as unknown as { unref?: () => void }).unref?.();
      runTick();
    },
    (error) => console.error("vibe-maintain: 维护配置读取失败，未启动规则同步", error),
  );

  return async () => {
    lifetime.abort();
    await startup.close();
    if (timer) clearInterval(timer);
    stopSettings();
    stopRules();
    for (const stop of stopHooks) stop();
    await engine.stop();
    db.close();
  };
}

