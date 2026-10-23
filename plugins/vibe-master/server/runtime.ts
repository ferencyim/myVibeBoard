// Wires the master together: wake triggers -> serial queue -> consolidator -> master session, the
// per-card planning sessions (on the card's planning model, WP-105), the quota monitor and the
// status/switch/wake operations behind the RPCs. Everything external (daemon handle, clock, memory
// writer) is injected.

import { join } from "node:path";
import type { MasterSettings, MasterStatus, PresetChoice } from "../shared/rpc";
import { systemClock, type Clock } from "./clock";
import { MASTER_RULES } from "./master/rules.generated";
import { createMasterSession } from "./master/session";
import { createConsolidator } from "./memory/consolidate";
import { createFileMemoryPort, type MemoryPort } from "./memory/files";
import { createPlanning } from "./planning/planner";
import { createDispatcher } from "./dispatch/dispatch";
import { createPromptPort, rulesFor } from "./prompts/port";
import { migrateLegacyPromptSettings } from "./prompts/migrate";
import { tuningOf } from "./tuning";
import { createAlerts } from "./subscription/alerts";
import { createPermissionResolver, isBoardMcpCall } from "./subscription/permission";
import { createQuotaReader } from "./subscription/quota";
import { createStateFile } from "./subscription/state";
import { resolveMasterPreset } from "./subscription/preset";
import { MasterError, type MasterPaseo, type WakeJob } from "./types";
import type { GitRunner, VibeDb, VibeStore } from "./vibe/db";
import { createWakeQueue } from "./wake/queue";
import { createTriggers } from "./wake/triggers";

export interface RuntimeDeps {
  db: VibeDb;
  store: VibeStore;
  getPaseo: () => MasterPaseo | null;
  settings: () => MasterSettings;
  /** `<VIBE_HOME>/master`: state file and the default agent workspace. */
  dataDir: string;
  clock?: Clock;
  memory?: MemoryPort;
  rules?: string;
  /** Injectable git for requirements commits (tests use a real temp repo by default). */
  git?: GitRunner;
  pollIntervalMs?: number;
  log?: (message: string, error?: unknown) => void;
}

export function createMasterRuntime(deps: RuntimeDeps) {
  const clock = deps.clock ?? systemClock;
  const log = deps.log ?? ((m, e) => console.error(`[vibe-master] ${m}`, e ?? ""));
  const { db, store } = deps;
  const state = createStateFile(deps.dataDir);
  const tuning = () => tuningOf(deps.settings());
  // Every prompt text goes through the shared registry, so the owner's overrides apply everywhere.
  const prompts = createPromptPort(store, () => ({
    rules: deps.rules ?? MASTER_RULES,
    maintainRequirements: deps.settings().maintainRequirements,
  }));
  prompts.register();

  const quota = createQuotaReader({
    getPaseo: deps.getPaseo,
    tightPct: () => deps.settings().quotaLowPct,
    clock,
  });
  const alerts = createAlerts({
    db,
    state,
    clock,
    sessionId: () => state.read().agent?.sessionId ?? null,
    tuning,
    log: (m) => log(m),
  });
  const session = createMasterSession({
    store,
    getPaseo: deps.getPaseo,
    settings: deps.settings,
    state,
    permission: createPermissionResolver(deps.getPaseo),
    rules: () => rulesFor(prompts),
    prompts,
    tuning,
    workspace: () => deps.settings().workspaceDir || join(deps.dataDir, "workspace"),
    alerts,
    log,
  });
  const currentPreset = () => resolveMasterPreset(deps.settings(), store.presets.list());
  /** Provider the master runs on: the live agent, else the chosen preset. */
  const ownProvider = () => session.activeProvider() ?? currentPreset().preset?.provider ?? null;
  const memory = deps.memory ?? createFileMemoryPort();
  const consolidator = createConsolidator({
    db,
    store,
    master: session,
    memory,
    prompts,
    options: {
      tuning,
      requirementsChars: () => deps.settings().requirementsExcerptChars,
      maintainRequirements: () => deps.settings().maintainRequirements,
    },
    onRequirementsFailure: (cardKey, message) => alerts.raise("requirements_failed", cardKey, message),
    git: deps.git,
    log,
  });
  // Per-card planning sessions (WP-33 / WP-105): separate agents on the card's planning model.
  const planning = createPlanning({
    db,
    store,
    getPaseo: deps.getPaseo,
    prompts,
    tuning,
    requirementsChars: () => deps.settings().requirementsExcerptChars,
    dataDir: deps.dataDir,
    clock,
    memory,
    alerts,
    enabled: () => deps.settings().enabled,
    pollIntervalMs: deps.pollIntervalMs,
    log,
  });

  async function run(job: WakeJob): Promise<void> {
    if (!deps.settings().enabled) return;
    const outcome = await consolidator.consolidate(job.cardId, { force: job.force });
    log(`memory ${job.cardId}: ${outcome.status}`);
  }

  const queue = createWakeQueue({
    run,
    onFailure(job, error) {
      log(`${job.kind} ${job.cardId} failed`, error);
      // No daemon handle yet, or the subscription is out of quota: keep the job for the next
      // wake-up / switch. Anything else (bad reply, timeout) is dropped; an edit or manual wake retries.
      return error instanceof MasterError && (error.kind === "unavailable" || error.kind === "quota")
        ? "block"
        : "drop";
    },
  });

  let schedulerPaused = false;
  // Master dispatch (WP-109): the scheduler asks, the master picks, the scheduler admits.
  const dispatcher = createDispatcher({
    db,
    store,
    master: session,
    exclusive: (fn) => queue.exclusive(fn),
    prompts,
    tuning,
    enabled: () => deps.settings().enabled && deps.settings().dispatch,
    timeoutSeconds: () => deps.settings().dispatchTimeoutSeconds,
    log,
  });
  /** Tell the scheduler whether (and why not) it can ask the master. */
  function publishDispatchMode(): void {
    const s = deps.settings();
    const { preset } = currentPreset();
    try {
      store.masterDispatch.publish({
        enabled: s.dispatch,
        available: s.enabled && !!preset,
        reason: !s.enabled ? "总 agent 已在设置中停用" : preset ? "" : "没有为总 agent 选择预设",
        timeoutSeconds: s.dispatchTimeoutSeconds,
      });
    } catch (error) {
      log("could not publish the dispatch mode", error);
    }
  }
  publishDispatchMode();

  const triggers = createTriggers({
    onDispatchWanted: (request) => void dispatcher.handle(request),
    onMaintenancePaused({ ruleName, rejections }) {
      alerts.raise(
        "maintenance_paused",
        ruleName,
        `Maintenance rule "${ruleName}" was paused after ${rejections} rejected cards; resume it in the maintenance panel`,
      );
    },
    onScheduler(signal) {
      if (signal.kind === "paused") schedulerPaused = true;
      else if (signal.kind === "resumed") schedulerPaused = false;
      else if (signal.kind === "quota_low") {
        quota.invalidate();
        const own = ownProvider();
        if (own && own.toLowerCase() === signal.provider.toLowerCase()) {
          alerts.raise(
            "quota_low",
            signal.provider,
            `总 agent 剩余额度 ${signal.remainingPct ?? "未知"}%（${signal.level}）`,
          );
          if (signal.level === "exhausted") void switchExhausted(signal.provider);
        }
      }
    },
    db,
    store,
    clock,
    queue,
    enabled: () => deps.settings().enabled,
    tuning,
    flags: () => deps.settings(),
    pollIntervalMs: deps.pollIntervalMs,
    log,
  });

  async function switchExhausted(provider: string): Promise<void> {
    try {
      await queue.exclusive(async () => {
        if (ownProvider()?.toLowerCase() !== provider.toLowerCase()) return;
        await session.failover(`${provider} 额度已耗尽`);
      });
      queue.resume();
    } catch (error) {
      log("总 agent 额度切换失败", error);
    }
  }

  // Quota warnings remind; an exhausted subscription advances to the next preset candidate.
  let stopMonitor: (() => void) | null = null;
  let monitoring = false;
  async function checkQuota(): Promise<void> {
    const provider = ownProvider();
    if (!provider) return;
    const levels = await quota.get();
    const q = levels[provider.toLowerCase()];
    if (!q || q.level === "ok" || q.level === "unknown") return;
    alerts.raise(
      "quota_low",
      provider,
      `总 agent 剩余额度 ${q.remainingPct ?? "未知"}%（${q.level}）`,
    );
    if (q.level === "exhausted") await switchExhausted(provider);
  }
  function startQuotaMonitor(): void {
    if (monitoring) return;
    monitoring = true;
    const arm = () => {
      stopMonitor = clock.setTimeout(() => {
        void checkQuota()
          .catch((error) => log("quota check failed", error))
          .finally(() => monitoring && arm());
      }, deps.settings().quotaCheckSeconds * 1000);
    };
    arm();
  }

  async function status(): Promise<MasterStatus> {
    const snap = queue.snapshot();
    const keyOf = (cardId: string) => store.cards.get(cardId)?.key ?? null;
    const record = state.read();
    let target = null;
    try {
      target = await session.currentTarget();
    } catch {
      target = null;
    }
    const { preset, source } = currentPreset();
    const live = session.liveSession();
    if (live?.agentId === record.agent?.agentId && record.agent) target = record.agent.target;
    const history = store.sessions
      .list({ role: "master" })
      .flatMap((s) => s.switchHistory)
      .sort((a, b) => a.at.localeCompare(b.at));

    let permission: MasterStatus["permission"] = null;
    if (target && deps.getPaseo()) {
      try {
        const p = await session.permission();
        permission = {
          setting: p.setting,
          source: p.source,
          modeId: p.resolved.modeId,
          label: p.resolved.label,
          auto: p.resolved.auto,
          options: p.resolved.options,
        };
      } catch {
        permission = null;
      }
    }

    const levels = await quota.get();
    const presets: PresetChoice[] = store.presets.list().map((p) => ({
      id: p.id,
      name: p.name,
      provider: p.provider,
      model: p.model,
      thinking: p.thinking,
      models: p.models,
      roleHints: [...p.roleHints],
      remainingPct: levels[p.provider.toLowerCase()]?.remainingPct ?? null,
      level: levels[p.provider.toLowerCase()]?.level ?? "unknown",
    }));
    const dispatch = store.masterDispatch.get();
    const paseo = deps.getPaseo();

    return {
      enabled: deps.settings().enabled,
      paseoReady: paseo !== null,
      target,
      preset: preset ? { id: preset.id, name: preset.name, migrated: source === "migrated" } : null,
      dispatch: { enabled: dispatch.enabled, available: dispatch.available, reason: dispatch.reason },
      permission,
      session: live
        ? { sessionId: live.id, agentId: live.agentId, provider: live.currentProvider, state: live.state }
        : null,
      queue: {
        running: snap.running
          ? { kind: snap.running.kind, cardKey: keyOf(snap.running.cardId) }
          : null,
        pending: snap.pending.map((j) => ({ kind: j.kind, cardKey: keyOf(j.cardId), dueInSeconds: 0 })),
        blocked: snap.blocked.length,
      },
      schedulerPaused,
      lastAlert: record.lastAlert ?? null,
      switchHistory: history,
      presets,
    };
  }

  return {
    prompts,
    /** Copy prompts edited in the pre-registry settings into global overrides (once). */
    migrateLegacyPrompts: () => migrateLegacyPromptSettings(db, store, deps.settings()),
    state,
    session,
    queue,
    triggers,
    consolidator,
    planning,
    dispatcher,
    quota,
    alerts,
    status,
    startQuotaMonitor,
    checkQuota,

    /** A daemon handle became available: retry parked jobs and planning turns. */
    onPaseoAvailable(): void {
      queue.resume();
      planning.resume();
    },

    /** Startup catch-up (recently done cards without a memory update). */
    sweep: () => (deps.settings().sweepOnStart ? triggers.sweep() : 0),

    /** All master sessions, newest first (the history list of the screen). */
    sessions: (limit?: number) => session.sessions(limit),

    /**
     * The settings changed (or were read for the first time): tell the scheduler whether the master
     * can dispatch, and move a running master to a newly chosen preset. Parked jobs continue on it.
     */
    async onSettingsChanged(): Promise<void> {
      publishDispatchMode();
      if (!deps.getPaseo()) return;
      try {
        await queue.exclusive(() => session.applyPreset("切换总 agent 预设"));
      } catch (error) {
        log("could not apply the chosen preset", error);
      }
      queue.resume();
    },

    /** Manual permission switch: a running master moves to a fresh agent, parked jobs continue on it. */
    async setPermission(mode: string) {
      const result = await queue.exclusive(() => session.setPermission(mode));
      queue.resume();
      return result;
    },

    /**
     * A permission request of an agent. Only calls of the vibe-board MCP tools by the master or a
     * planner are approved (they would stall an assessment otherwise); every other request of those
     * agents waits for the owner, who is reminded with a master.alert.
     */
    async onPermissionRequest(
      agentId: string,
      request: { id: string; kind: string; name?: string; metadata?: unknown },
      approve: (requestId: string) => Promise<void>,
    ): Promise<"approved" | "alerted" | "ignored"> {
      const owner = store.sessions.getByAgent(agentId);
      if (owner?.role !== "master" && owner?.role !== "planner") return "ignored";
      if (isBoardMcpCall(request)) {
        await approve(request.id);
        return "approved";
      }
      alerts.raise(
        "permission_wait",
        owner.currentProvider,
        `The ${owner.role} agent is waiting for your approval of ${request.name ?? request.kind}`,
      );
      return "alerted";
    },

    wake(cardRef: string, reason: "card_done", force: boolean) {
      const card = store.cards.get(cardRef);
      if (!card) return { queued: false, message: `Card not found: ${cardRef}` };
      queue.enqueue({ kind: "card_done", cardId: card.id, force });
      return { queued: true, message: `Queued ${reason} for ${card.key}` };
    },

    async dispose(): Promise<void> {
      monitoring = false;
      stopMonitor?.();
      await planning.stop();
      await triggers.stop();
    },
  };
}

export type MasterRuntime = ReturnType<typeof createMasterRuntime>;
