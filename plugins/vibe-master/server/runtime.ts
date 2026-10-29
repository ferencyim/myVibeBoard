// Retained master sessions and subscription alerts.

import { join } from "node:path";
import type { MasterSettings, MasterStatus, MasterTarget, PresetChoice } from "../shared/rpc";
import { systemClock, type Clock } from "./clock";
import { MASTER_RULES } from "./master/rules.generated";
import { presetModels } from "./vibe/contract";
import { createMasterSession } from "./master/session";
import { migrateLegacyPromptSettings } from "./prompts/migrate";
import { createPromptPort, rulesFor } from "./prompts/port";
import { createAlerts } from "./subscription/alerts";
import { createPermissionResolver } from "./subscription/permission";
import { resolveMasterPreset } from "./subscription/preset";
import { createQuotaReader } from "./subscription/quota";
import { createMasterResources } from "./subscription/resources";
import { createStateFile } from "./subscription/state";
import { tuningOf } from "./tuning";
import type { MasterAgentHandle } from "./types";
import { MasterError, wakeTarget, type MasterPaseo, type WakeJob } from "./types";
import { publishEvent, type VibeDb, type VibeStore } from "./vibe/db";
import { createWakeQueue } from "./wake/queue";
import { createTriggers } from "./wake/triggers";

function legacyBotPermission(permission: string): "accept-edits" | "auto" | "full" {
  if (["full", "full-access", "bypassPermissions"].includes(permission)) return "full";
  if (["auto", "auto-review"].includes(permission)) return "auto";
  return "accept-edits";
}

export interface RuntimeDeps {
  db: VibeDb;
  store: VibeStore;
  getPaseo: () => MasterPaseo | null;
  settings: () => MasterSettings;
  /** `<VIBE_HOME>/master`: state file and the default agent workspace. */
  dataDir: string;
  clock?: Clock;
  /** Tests may supply an admission port; production always asks the scheduler. */
  admitMaster?(agent: MasterAgentHandle, target: MasterTarget): Promise<() => Promise<void>>;
  rules?: string;
  pollIntervalMs?: number;
  promptsReady?: Promise<void>;
  /** Once bot identity owns sessions, this runtime only exposes retained history and prompts. */
  managedByBots?: boolean;
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
  }));
  if (!deps.promptsReady) prompts.register();

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
  const resources = deps.admitMaster ? null : createMasterResources({ db, log });
  const session = createMasterSession({
    db,
    admit: deps.admitMaster ?? ((agent, target) => resources!.acquire(agent, target)),
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
  async function run(_job: WakeJob): Promise<void> {
    // WP-134: completion consolidation belongs exclusively to the project agent.
  }

  const resourceRetries = new Set<() => void>();
  const queue = createWakeQueue({
    run,
    onFailure(job, error) {
      log(`${job.kind} ${wakeTarget(job)} failed`, error);
      if (
        error instanceof MasterError &&
        error.kind === "unavailable" &&
        error.retryable !== false
      ) {
        const stop = clock.setTimeout(() => {
          resourceRetries.delete(stop);
          queue.resume();
        }, 5000);
        resourceRetries.add(stop);
      }
      // No daemon handle yet, or the subscription is out of quota: keep the job for the next
      // wake-up / switch. Anything else (bad reply, timeout) is dropped; an edit or manual wake retries.
      return error instanceof MasterError &&
        ((error.kind === "unavailable" && error.retryable !== false) || error.kind === "quota")
        ? "block"
        : "drop";
    },
  });

  let schedulerPaused = false;
  const triggers = createTriggers({
    onMasterContinuation(request) {
      if (deps.managedByBots) return;
      void queue
        .exclusive(async () => {
          const live = session.liveSession();
          if (!live || live.id !== request.sessionId || live.agentId !== request.agentId) {
            publishEvent(db, {
              type: "context.continuation_result",
              payload: {
                requestId: request.requestId,
                workspaceId: null,
                status: "deferred",
                reason: "请求对应的总 agent 已被接续，不重复创建会话",
              },
              dedupeKey: "master_continuation:" + request.requestId,
            });
            return;
          }
          let continuationStatus: "continued" | "exhausted" | "paused" = "paused";
          let reason = "";
          try {
            const why =
              request.message +
              (request.summary ? "\n接续摘要：" + request.summary.slice(0, 2000) : "");
            const continued =
              request.reason === "context"
                ? await session.restart(why)
                : await session.failover(why);
            continuationStatus = continued ? "continued" : "exhausted";
            reason = continued ? "总 agent 已保留原生历史并接续" : "总 agent 候选已耗尽";
          } catch (error) {
            reason = error instanceof Error ? error.message : String(error);
          }
          const next = session.liveSession();
          publishEvent(db, {
            type: "context.continuation_result",
            payload: {
              requestId: request.requestId,
              workspaceId: null,
              status: continuationStatus,
              reason,
              ...(next ? { agentId: next.agentId, sessionId: next.id } : {}),
              candidateIndex: state.read().presetSelection?.index ?? 0,
            },
            dedupeKey: "master_continuation:" + request.requestId,
          });
        })
        .then(() => {
          queue.resume();
          triggers.sweep();
          return undefined;
        })
        .catch((error) => log("总 agent 接续失败", error));
    },
    onMaintenancePaused({ ruleName, rejections }) {
      alerts.raise(
        "maintenance_paused",
        ruleName,
        `维护规则「${ruleName}」因连续 ${rejections} 次驳回而暂停，请在维护设置中恢复`,
      );
    },
    onScheduler(signal) {
      if (signal.kind === "paused") schedulerPaused = true;
      else if (signal.kind === "resumed") schedulerPaused = false;
      else if (signal.kind === "quota_low") {
        quota.invalidate();
        if (deps.managedByBots) return;
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
    pollIntervalMs: deps.pollIntervalMs,
    log,
    ready: deps.promptsReady,
  });

  async function switchExhausted(provider: string): Promise<void> {
    if (deps.managedByBots) return;
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
    if (deps.managedByBots) return;
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
    if (deps.managedByBots || monitoring) return;
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
    const keyOf = (job: WakeJob) => job.workspaceId;
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
    const sessions = store.sessions.list({ role: "master" });
    const byId = new Map(sessions.map((s) => [s.id, s]));
    const history = [
      ...sessions.flatMap((s) => s.switchHistory),
      ...sessions.flatMap((s) => {
        const previous = s.previousSessionId ? byId.get(s.previousSessionId) : undefined;
        return previous && previous.currentProvider !== s.currentProvider
          ? [
              {
                from: previous.currentProvider,
                to: s.currentProvider,
                at: s.startedAt,
                reason:
                  record.sessions?.[previous.id]?.switchReason ??
                  record.sessions?.[previous.id]?.retiredReason,
              },
            ]
          : [];
      }),
    ].sort((a, b) => a.at.localeCompare(b.at));

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
    const paseo = deps.getPaseo();

    return {
      enabled: deps.settings().enabled,
      paseoReady: paseo !== null,
      target,
      preset: preset ? { id: preset.id, name: preset.name, migrated: source === "migrated" } : null,
      permission,
      session: live
        ? {
            sessionId: live.id,
            agentId: live.agentId,
            provider: live.currentProvider,
            state: live.state,
          }
        : null,
      queue: {
        running: snap.running
          ? { kind: snap.running.kind, workspaceId: keyOf(snap.running) }
          : null,
        pending: snap.pending.map((j) => ({
          kind: j.kind,
          workspaceId: keyOf(j),
          dueInSeconds: 0,
        })),
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
    /** Public configuration only: no workspace path, environment or credentials leave this RPC. */
    botMigrationSnapshot() {
      const settings = deps.settings();
      const record = state.read();
      const { preset } = currentPreset();
      const models = preset ? presetModels(preset) : [];
      const selectionKey = preset ? JSON.stringify([preset.id, models]) : null;
      const progress = record.presetSelection;
      const sameSelection = progress && progress.key === selectionKey;
      const index = sameSelection ? progress.index : 0;
      const candidateIndex = Math.min(index, Math.max(0, models.length - 1));
      const selected = models[candidateIndex];
      const target = record.agent?.target ?? selected ?? settings;
      const requested = record.permissionMode ?? settings.permissionMode;
      const permission = requested === "preset" ? (selected?.permissionMode ?? "accept-edits") : requested;
      const permissionMode = legacyBotPermission(permission);
      return {
        presetId: preset?.id ?? null,
        provider: target.provider || null,
        model: target.model || null,
        thinking: target.thinking ?? "",
        candidateIndex,
        models,
        backupModels: models.slice(1).map(({ provider, model, thinking }) => ({ provider, model, thinking })),
        instructions: rulesFor(prompts),
        notifications: { enabled: settings.enabled, completed: true, failed: true },
        permissionMode,
      };
    },
    /** Copy prompts edited in the pre-registry settings into global overrides (once). */
    migrateLegacyPrompts: () => migrateLegacyPromptSettings(db, store, deps.settings()),
    state,
    session,
    queue,
    triggers,
    quota,
    alerts,
    status,
    startQuotaMonitor,
    checkQuota,

    /** A daemon handle became available: retry parked task jobs. */
    onPaseoAvailable(): void {
      queue.resume();
    },

    /** Startup catch-up (completed tasks without a memory update). */
    sweep: () => 0,

    /** All master sessions, newest first (the history list of the screen). */
    sessions: (limit?: number) => session.sessions(limit),

    /**
     * Apply a changed preset to the retained master session.
     */
    async onSettingsChanged(): Promise<void> {
      if (deps.managedByBots || !deps.getPaseo()) return;
      try {
        await queue.exclusive(() => session.applyPreset("切换总 agent 预设"));
      } catch (error) {
        log("could not apply the chosen preset", error);
      }
      queue.resume();
    },

    /** Manual permission switch: a running master moves to a fresh agent, parked jobs continue on it. */
    async setPermission(mode: string) {
      if (deps.managedByBots) throw new Error("请在具体 bot 的资料页调整权限");
      const result = await queue.exclusive(() => session.setPermission(mode));
      queue.resume();
      return result;
    },

    /** The master never auto-approves tools; remind the owner about pending permission. */
    async onPermissionRequest(
      agentId: string,
      request: { id: string; kind: string; name?: string; metadata?: unknown },
      _approve: (requestId: string) => Promise<void>,
    ): Promise<"alerted" | "ignored"> {
      const owner = store.sessions.getByAgent(agentId);
      if (owner?.role !== "master") return "ignored";
      alerts.raise(
        "permission_wait",
        owner.currentProvider,
        `角色 ${owner.role} 的 agent 正在等待您批准 ${request.name ?? request.kind}`,
      );
      return "alerted";
    },

    wake(_workspaceId: string, _force: boolean) {
      return { queued: false, message: "任务完成整理已迁移至项目 agent" };
    },

    async dispose(): Promise<void> {
      monitoring = false;
      stopMonitor?.();
      for (const stop of resourceRetries) stop();
      await resources?.stop();
      await triggers.stop();
    },
  };
}

export type MasterRuntime = ReturnType<typeof createMasterRuntime>;
