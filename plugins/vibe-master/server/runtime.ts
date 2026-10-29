// Task dispatch, completion memory, master sessions and subscription alerts.

import { join } from "node:path";
import type { MasterSettings, MasterStatus, MasterTarget, PresetChoice } from "../shared/rpc";
import { systemClock, type Clock } from "./clock";
import { createTaskDispatcher } from "./dispatch/task";
import { MASTER_RULES } from "./master/rules.generated";
import { createMasterSession } from "./master/session";
import { createFileMemoryPort, type MemoryPort } from "./memory/files";
import { createTaskConsolidator } from "./memory/task";
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
import { publishEvent, type GitRunner, type VibeDb, type VibeStore } from "./vibe/db";
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
  /** Tests may supply an admission port; production always asks the scheduler. */
  admitMemory?(workspaceId: string, files: string[]): Promise<() => Promise<void>>;
  admitMaster?(agent: MasterAgentHandle, target: MasterTarget): Promise<() => Promise<void>>;
  memory?: MemoryPort;
  rules?: string;
  /** Injectable git for requirements commits (tests use a real temp repo by default). */
  git?: GitRunner;
  pollIntervalMs?: number;
  promptsReady?: Promise<void>;
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
  const resources =
    deps.admitMaster && deps.admitMemory ? null : createMasterResources({ db, log });
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
  const memory = deps.memory ?? createFileMemoryPort();
  const taskConsolidator = createTaskConsolidator({
    db,
    store,
    master: session,
    memory,
    prompts,
    state,
    async withWrite(task, files, action) {
      const release = deps.admitMemory
        ? await deps.admitMemory(task.workspaceId, files)
        : await resources!.acquireFiles(task.workspaceId, files, await session.currentTarget());
      try {
        return await action();
      } finally {
        await release();
      }
    },
    options: {
      tuning,
      requirementsChars: () => deps.settings().requirementsExcerptChars,
      maintainRequirements: () => deps.settings().maintainRequirements,
    },
    async project(workspaceId) {
      const workspace = await deps.getPaseo()?.workspaces?.ref(workspaceId).refresh();
      return workspace ? store.projectConfigs.get(workspace.projectId) : undefined;
    },
    onRequirementsFailure: (key, message) => alerts.raise("requirements_failed", key, message),
    git: deps.git,
    log,
  });
  async function run(job: WakeJob): Promise<void> {
    if (!deps.settings().enabled) return;
    const outcome = await taskConsolidator.consolidate(job.workspaceId, { force: job.force });
    log(`memory ${wakeTarget(job)}: ${outcome.status}`);
    if (outcome.status === "failed") {
      const task = store.tasks.get(job.workspaceId);
      const text = "项目记忆整理失败：" + outcome.error;
      if (task && !task.summary.includes(text))
        store.tasks.setSummary(task.workspaceId, [task.summary, text].filter(Boolean).join("\n\n"));
    }
  }

  const resourceRetries = new Set<() => void>();
  const queue = createWakeQueue({
    run,
    onFailure(job, error) {
      log(`${job.kind} ${wakeTarget(job)} failed`, error);
      if (job.kind === "task_done") {
        const task = store.tasks.get(job.workspaceId);
        const text =
          "项目记忆整理暂未完成：" + (error instanceof Error ? error.message : String(error));
        if (task && !task.summary.includes(text))
          store.tasks.setSummary(
            task.workspaceId,
            [task.summary, text].filter(Boolean).join("\n\n"),
          );
      }
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
  // Master dispatch (WP-109): the scheduler asks, the master picks, the scheduler admits.
  const taskDispatcher = createTaskDispatcher({
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
    let reason = "";
    if (!s.enabled) reason = "总 agent 已在设置中停用";
    else if (!preset) reason = "没有为总 agent 选择预设";
    try {
      store.masterDispatch.publish({
        enabled: s.dispatch,
        available: s.enabled && !!preset,
        reason,
        timeoutSeconds: s.dispatchTimeoutSeconds,
      });
    } catch (error) {
      log("could not publish the dispatch mode", error);
    }
  }
  publishDispatchMode();

  const triggers = createTriggers({
    onMasterContinuation(request) {
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
    onTaskDispatchWanted: (request) => void taskDispatcher.handle(request),
    taskConsolidated: (id) => {
      const task = store.tasks.get(id);
      return !!task && taskConsolidator.has(task);
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
    ready: deps.promptsReady,
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
    const dispatch = store.masterDispatch.get();
    const paseo = deps.getPaseo();

    return {
      enabled: deps.settings().enabled,
      paseoReady: paseo !== null,
      target,
      preset: preset ? { id: preset.id, name: preset.name, migrated: source === "migrated" } : null,
      dispatch: {
        enabled: dispatch.enabled,
        available: dispatch.available,
        reason: dispatch.reason,
      },
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
    /** Copy prompts edited in the pre-registry settings into global overrides (once). */
    migrateLegacyPrompts: () => migrateLegacyPromptSettings(db, store, deps.settings()),
    state,
    session,
    queue,
    triggers,
    taskDispatcher,
    taskConsolidator,
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

    wake(workspaceId: string, force: boolean) {
      const task = store.tasks.get(workspaceId);
      if (task) {
        queue.enqueue({ kind: "task_done", workspaceId: task.workspaceId, force });
        return { queued: true, message: `已排队整理任务 ${task.workspaceId}` };
      }
      return { queued: false, message: "任务不存在，请使用原生 workspace 任务" };
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
