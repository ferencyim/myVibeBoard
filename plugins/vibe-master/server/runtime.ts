// Wires the master together: wake triggers -> serial queue -> assessor / consolidator -> master
// session, plus the quota monitor and the status/switch/wake operations behind the RPCs.
// Everything external (daemon handle, clock, memory writer, selector) is injected.

import { join } from "node:path";
import type { MasterSettings, MasterStatus, ProviderInfo } from "../shared/rpc";
import { createAssessor } from "./assess/assess";
import { systemClock, type Clock } from "./clock";
import { MASTER_RULES } from "./master/rules.generated";
import { createMasterSession } from "./master/session";
import { createConsolidator } from "./memory/consolidate";
import { createFileMemoryPort, type MemoryPort } from "./memory/files";
import { createPlanning } from "./planning/planner";
import { createPromptPort, rulesFor } from "./prompts/port";
import { migrateLegacyPromptSettings } from "./prompts/migrate";
import { tuningOf } from "./tuning";
import { defaultSelector, type AgentSelector } from "./select";
import { createAlerts } from "./subscription/alerts";
import { createPermissionResolver, isBoardMcpCall } from "./subscription/permission";
import { createQuotaReader } from "./subscription/quota";
import { createStateFile } from "./subscription/state";
import { providerSpec, type TargetRequest } from "./subscription/target";
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
  selector?: AgentSelector;
  rules?: string;
  /** Injectable git for requirements commits (tests use a real temp repo by default). */
  git?: GitRunner;
  pollIntervalMs?: number;
  log?: (message: string, error?: unknown) => void;
}

const PLANNER_LIVE = ["starting", "working", "waiting", "idle", "error"] as const;

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
  const selector = deps.selector ?? defaultSelector;
  const assessor = createAssessor({
    db,
    store,
    master: session,
    quota,
    selector,
    masterLabel: () => {
      const t = state.read().agent?.target;
      return t ? providerSpec(t) : null;
    },
    prompts,
    tuning,
    requirementsChars: () => deps.settings().requirementsExcerptChars,
    log,
  });
  const memory = deps.memory ?? createFileMemoryPort();
  const consolidator = createConsolidator({
    db,
    store,
    master: session,
    assessor,
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
  // Per-card planning sessions (WP-33): separate agents, same model and rules as the master.
  const planning = createPlanning({
    db,
    store,
    getPaseo: deps.getPaseo,
    master: session,
    rules: (projectId) => rulesFor(prompts, projectId),
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
    if (job.kind === "assess_draft") {
      // A live planning session owns the plan of its card: its plan versions must not be overwritten.
      if (store.sessions.list({ cardId: job.cardId, role: "planner", states: PLANNER_LIVE }).length > 0) {
        log(`assess ${job.cardId}: skipped (planning session active)`);
        // A manual review request must not look like a dead button: say where to ask instead.
        if (job.force) {
          store.cards.addChat({
            cardId: job.cardId,
            authorKind: "system",
            author: "master",
            kind: "info",
            text: "规划会话进行中，请直接在群聊里向总 agent 提问。",
            key: `assess-skipped:${job.cardId}:${Math.floor(clock.now() / 60_000)}`,
          });
        }
        return;
      }
      const outcome = await assessor.assess(job.cardId, { force: job.force });
      log(`assess ${job.cardId}: ${outcome.status}${"reason" in outcome ? ` (${outcome.reason})` : ""}`);
    } else if (job.kind === "card_done") {
      const outcome = await consolidator.consolidate(job.cardId, { force: job.force });
      log(`memory ${job.cardId}: ${outcome.status}`);
    } else {
      const outcome = await consolidator.advise(job.cardId, job.question);
      log(`help ${job.cardId}: ${outcome.status}`);
    }
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
  const triggers = createTriggers({
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
        // Reassign or wait is decided per draft from fresh quota numbers; the owner is reminded
        // when it is the master's own provider (never an automatic switch).
        quota.invalidate();
        const own = session.activeProvider() ?? state.read().target?.provider ?? deps.settings().provider;
        if (own.toLowerCase() === signal.provider.toLowerCase()) {
          alerts.raise(
            "quota_low",
            signal.provider,
            `${signal.remainingPct === null ? "little" : `${signal.remainingPct}%`} quota left (${signal.level}); switch the master subscription if needed`,
          );
        }
      }
    },
    db,
    store,
    clock,
    queue,
    enabled: () => deps.settings().enabled,
    debounceMs: () => deps.settings().debounceSeconds * 1000,
    tuning,
    flags: () => deps.settings(),
    pollIntervalMs: deps.pollIntervalMs,
    log,
  });

  // ---- quota monitor: remind only, never switch ----
  let stopMonitor: (() => void) | null = null;
  let monitoring = false;
  async function checkQuota(): Promise<void> {
    const provider = session.activeProvider() ?? state.read().target?.provider ?? deps.settings().provider;
    const levels = await quota.get();
    const q = levels[provider.toLowerCase()];
    if (!q || q.level === "ok" || q.level === "unknown") return;
    alerts.raise(
      "quota_low",
      provider,
      `${q.remainingPct === null ? "little" : `${q.remainingPct}%`} quota left (${q.level}); switch the master subscription if needed`,
    );
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

  async function status(includeProviders: boolean): Promise<MasterStatus> {
    const snap = queue.snapshot();
    const due = new Map(triggers.debouncer.pending().map((p) => [p.key, p.dueAt]));
    const keyOf = (cardId: string) => store.cards.get(cardId)?.key ?? null;
    const record = state.read();
    const switched = record.target;
    let target = switched ?? null;
    if (!target) {
      try {
        target = await session.currentTarget();
      } catch {
        target = null;
      }
    }
    const live = session.liveSession();
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

    let providers: ProviderInfo[] = [];
    const paseo = deps.getPaseo();
    if (includeProviders && paseo) {
      const levels = await quota.get();
      // Whatever Paseo offers (any built-in or plugin provider), plus providers with usage data or presets.
      const catalog = await paseo.providers.listAvailable?.().catch(() => null);
      const ids = [
        ...new Set([
          ...(catalog?.providers ?? []).filter((p) => p.available !== false).map((p) => p.provider),
          ...Object.keys(levels),
          ...store.presets.list().map((p) => p.provider),
        ]),
      ];
      const listed = await Promise.all(
        ids.map(async (id): Promise<ProviderInfo | null> => {
          try {
            const res = await paseo.providers.listModels(id);
            const models = (res.models ?? []).filter((m) => m.isSelectable !== false);
            if (models.length === 0) return null;
            return {
              id,
              label: id,
              remainingPct: levels[id]?.remainingPct ?? null,
              level: levels[id]?.level ?? "unknown",
              models: models.map((m) => ({
                id: m.id,
                label: m.label,
                isDefault: !!m.isDefault,
                thinking: (m.thinkingOptions ?? []).map((o) => ({ id: o.id, label: o.label })),
              })),
            };
          } catch {
            return null;
          }
        }),
      );
      providers = listed.filter((p): p is ProviderInfo => p !== null);
    }

    return {
      enabled: deps.settings().enabled,
      paseoReady: paseo !== null,
      target,
      targetSource: switched ? "switched" : "settings",
      permission,
      session: live
        ? { sessionId: live.id, agentId: live.agentId, provider: live.currentProvider, state: live.state }
        : null,
      queue: {
        running: snap.running
          ? { kind: snap.running.kind, cardKey: keyOf(snap.running.cardId) }
          : null,
        pending: [
          ...snap.pending.map((j) => ({ kind: j.kind, cardKey: keyOf(j.cardId), dueInSeconds: 0 })),
          ...[...due].map(([cardId, dueAt]) => ({
            kind: "assess_draft",
            cardKey: keyOf(cardId),
            dueInSeconds: Math.max(0, Math.ceil((dueAt - clock.now()) / 1000)),
          })),
        ],
        blocked: snap.blocked.length,
      },
      schedulerPaused,
      lastAlert: record.lastAlert ?? null,
      switchHistory: history,
      providers,
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
    assessor,
    consolidator,
    planning,
    quota,
    alerts,
    status,
    startQuotaMonitor,
    checkQuota,

    /** A daemon handle became available: retry parked jobs and catch up on unassessed drafts. */
    onPaseoAvailable(): void {
      queue.resume();
      planning.resume();
    },

    /** Startup catch-up (drafts without a current assessment, recently done cards). */
    sweep: () => (deps.settings().sweepOnStart ? triggers.sweep() : 0),

    /** All master sessions, newest first (the history list of the screen). */
    sessions: (limit?: number) => session.sessions(limit),

    /** Manual switch of the master subscription; parked jobs continue on the new agent. */
    async switchTo(request: TargetRequest, reason?: string) {
      const result = await queue.exclusive(() => session.switchTo(request, reason ?? "manual switch"));
      queue.resume();
      return result;
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

    wake(cardRef: string, reason: "assess_draft" | "card_done", force: boolean) {
      const card = store.cards.get(cardRef);
      if (!card) return { queued: false, message: `Card not found: ${cardRef}` };
      if (reason === "assess_draft") {
        if (card.column !== "draft") {
          return { queued: false, message: `${card.key} is in ${card.column}; only drafts are assessed` };
        }
        triggers.assessNow(card.id, force);
      } else {
        queue.enqueue({ kind: "card_done", cardId: card.id, force });
      }
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
