// Admission control. Each tick decides which todo cards may start now and publishes
// `scheduler.admitted` for them (vibe-board's admission consumer then dispatches). Everything the
// decision depends on (clock, resources, quota, devices, ports) is injected.
//
// Order: priority (urgent first), then the time the card entered todo, then key.
// Limits: global, per provider and per project; the device pool limits through exclusive leases.
// Gates: memory pressure pauses all admissions; a tight provider only admits high priority cards;
// an exhausted provider admits nothing.

import type { CardView, DeviceKind, Preset, Project } from "./vibe/contract";
import { publishEvent, type DeviceLeases, type VibeDb, type createVibeStore } from "./vibe/db";
import { quotaFor } from "./quota";
import { topSessions, type ResourceSnapshot } from "./resources";
import { PRIORITY_RANK, pickPresetId, takesSlot, type Priority, type ProviderQuota } from "./vibe/contract";
import type { PortAllocator } from "./ports";
import { findOverlap } from "./overlap";

type Store = ReturnType<typeof createVibeStore>;

export interface SchedulerConfig {
  globalLimit: number;
  providerLimits: Record<string, number>;
  memoryThreshold: number;
  tightMinPriority: Priority;
  leaseTtlMinutes: number;
  retryCooldownSeconds: number;
  maxAdmitAttempts: number;
  /** An admitted card nobody dispatched within this many minutes is released and backed off. */
  pendingTimeoutMinutes: number;
  /** Hold back a card whose planned files overlap a running card of the same project. */
  conflictAvoidance: boolean;
}

export const DEFAULT_CONFIG: SchedulerConfig = {
  globalLimit: 4,
  providerLimits: {},
  memoryThreshold: 0.85,
  tightMinPriority: "high",
  leaseTtlMinutes: 240,
  retryCooldownSeconds: 120,
  maxAdmitAttempts: 3,
  pendingTimeoutMinutes: 5,
  conflictAvoidance: true,
};

export interface SchedulerDeps {
  db: VibeDb;
  store: Store;
  leases: DeviceLeases;
  ports: PortAllocator;
  config: () => SchedulerConfig;
  now: () => Date;
  resources: () => ResourceSnapshot | null;
  quota: () => Record<string, ProviderQuota>;
}

export interface Admission {
  cardId: string;
  cardKey: string;
  provider: string;
  presetId: string;
  port: number;
  deviceIds: string[];
  at: string;
}

export interface TickResult {
  admitted: Admission[];
  /** Why waiting cards were not admitted (card key -> reason). */
  deferred: Record<string, string>;
  paused: boolean;
}

/** Rules dispatch for this long after the master failed or timed out. */
const FALLBACK_MS = 5 * 60_000;
/** ...and for this long after a pick that no card could follow. */
const RETRY_AFTER_EMPTY_MS = 60_000;

const ACTIVE_STATES = ["starting", "working", "waiting", "idle"] as const;

/** Device kind a runtime environment needs, or null when it needs no exclusive device. */
export function deviceKindFor(runtimeEnv: string | null | undefined): DeviceKind | null {
  const env = (runtimeEnv ?? "").toLowerCase();
  if (/android|emulator/.test(env)) return "emulator";
  if (/\bios\b|simulator/.test(env)) return "simulator";
  if (/board|embedded|firmware/.test(env)) return "board";
  return null;
}

/** Concurrency cap for one provider: the smallest of global, provider and device-pool limits. */
export function effectiveLimit(
  config: Pick<SchedulerConfig, "globalLimit" | "providerLimits">,
  provider: string,
  devicePoolSize: number | null,
): number {
  return Math.min(
    config.globalLimit,
    config.providerLimits[provider] ?? Infinity,
    devicePoolSize ?? Infinity,
  );
}

export function createScheduler(deps: SchedulerDeps) {
  const { db, store, leases, ports, now } = deps;
  const pending = new Map<string, Admission>();
  const failures = new Map<string, { count: number; until: number }>();
  let paused = false;
  let lastDeferred: Record<string, string> = {};
  const announcedQuota = new Map<string, string>();
  // WP-109 master dispatch: at most one question to the master at a time, and a back-off window in
  // which the scheduler's own rules dispatch because the master could not answer.
  type Round =
    | { kind: "asking"; requestId: string; since: number }
    | { kind: "chosen"; requestId: string; cardIds: string[]; reason: string };
  let round: Round | null = null;
  let fallback: { until: number; reason: string } | null = null;
  let requestSeq = 0;

  const leaseOwner = (cardId: string) => `scheduler:${cardId}`;

  function todoSince(card: CardView): string {
    const row = db
      .prepare<{ ts: string }>(
        `SELECT ts FROM vibe_event WHERE card_id = ? AND type = 'card.moved'
         AND json_extract(payload_json, '$.to') = 'todo' ORDER BY seq DESC LIMIT 1`,
      )
      .get(card.id);
    return row?.ts ?? card.createdAt;
  }

  function releaseCard(cardId: string) {
    pending.delete(cardId);
    ports.release(cardId);
    for (const l of leases.activeLeases()) {
      if (l.session_id === leaseOwner(cardId)) leases.release(l.id);
    }
  }

  /** Free leases/ports/pending entries of cards that are no longer waiting or running. */
  function reconcile() {
    leases.reapExpired();
    const live = (id: string) => {
      const c = store.cards.get(id);
      return !!c && !c.archivedAt && (c.column === "todo" || c.column === "in_progress");
    };
    for (const id of [...pending.keys()]) {
      const c = store.cards.get(id);
      if (!c || c.column !== "todo") pending.delete(id); // dispatched (now counted as a session) or gone
      else if (now().getTime() - Date.parse(pending.get(id)!.at) > deps.config().pendingTimeoutMinutes * 60_000) {
        handleDispatchFailed(id); // nobody dispatched it: free the slot and back off
      }
    }
    for (const l of leases.activeLeases()) {
      const owner = l.session_id;
      if (owner?.startsWith("scheduler:") && !live(owner.slice("scheduler:".length))) leases.release(l.id);
    }
    for (const key of ports.keys()) if (!live(key)) ports.release(key);
  }

  function runningCounts() {
    const byProvider: Record<string, number> = {};
    const byProject: Record<string, number> = {};
    let total = 0;
    // Sub-agents of a card count like card executors while they work (WP-106, takesSlot).
    const running = store.sessions.list({ states: ACTIVE_STATES }).filter(takesSlot);
    for (const s of running) {
      total++;
      byProvider[s.currentProvider] = (byProvider[s.currentProvider] ?? 0) + 1;
      const card = s.cardId ? store.cards.get(s.cardId) : undefined;
      if (card) byProject[card.projectId] = (byProject[card.projectId] ?? 0) + 1;
    }
    for (const a of pending.values()) {
      total++;
      byProvider[a.provider] = (byProvider[a.provider] ?? 0) + 1;
      const card = store.cards.get(a.cardId);
      if (card) byProject[card.projectId] = (byProject[card.projectId] ?? 0) + 1;
    }
    return { total, byProvider, byProject };
  }

  /** Planned files (globs) of a card: the card's plan (WP-105), else its latest plan version; empty when none. */
  function plannedFiles(cardId: string): string[] {
    const plan = store.cards.get(cardId)?.plan;
    if (plan) return plan.files ?? [];
    const versions = store.plans.list(cardId);
    return versions[versions.length - 1]?.snapshot.files ?? [];
  }

  /** Key of a running (or just admitted) card of the project whose files overlap `files`, if any. */
  function conflictWith(projectId: string, cardId: string, files: string[]): string | null {
    const busy = new Map<string, string>();
    for (const column of ["in_progress", "verifying"] as const) {
      for (const c of store.cards.list({ projectId, column })) busy.set(c.id, c.key);
    }
    for (const a of pending.values()) {
      const c = store.cards.get(a.cardId);
      if (c?.projectId === projectId) busy.set(c.id, c.key);
    }
    for (const [id, key] of busy) {
      if (id !== cardId && findOverlap(files, plannedFiles(id))) return key;
    }
    return null;
  }

  type Verdict =
    | { ok: true; project: Project; preset: Preset; provider: string }
    | { ok: false; reason: string };

  /** Every admission rule that has no side effect (devices and ports are taken only on admission). */
  function check(
    card: CardView,
    config: SchedulerConfig,
    counts: ReturnType<typeof runningCounts>,
    quota: Record<string, ProviderQuota>,
  ): Verdict {
    const no = (reason: string): Verdict => ({ ok: false, reason });
    if (counts.total >= config.globalLimit) return no(`已达全局并发上限 ${config.globalLimit}`);
    const failure = failures.get(card.id);
    if (failure && (failure.count >= config.maxAdmitAttempts || failure.until > now().getTime())) {
      return no(failure.count >= config.maxAdmitAttempts ? "多次派发失败，已放弃" : "派发失败后冷却中，稍后重试");
    }
    const project = store.projects.get(card.projectId);
    // Same order as vibe-board's dispatcher: card, master recommendation, project default.
    const presetId = pickPresetId(card, project, (id) => !!store.presets.get(id));
    const preset = presetId ? store.presets.get(presetId) : undefined;
    if (!project || !preset) return no("没有执行预设（请在卡片上选择，或给项目设默认预设）");
    const provider = preset.provider;
    const providerLimit = effectiveLimit(config, provider, null);
    if ((counts.byProvider[provider] ?? 0) >= providerLimit) return no(`${provider} 已达并发上限 ${providerLimit}`);
    if (project.concurrencyLimit != null && (counts.byProject[project.id] ?? 0) >= project.concurrencyLimit) {
      return no(`项目已达并发上限 ${project.concurrencyLimit}`);
    }
    if (config.conflictAvoidance) {
      const files = plannedFiles(card.id);
      const other = files.length ? conflictWith(card.projectId, card.id, files) : null;
      if (other) return no(`与 ${other} 改动相同的文件，等它结束`);
    }
    const q = quotaFor(quota, provider);
    if (q.level === "exhausted") return no(`${provider} 额度已用完${q.resetsAt ? `，${q.resetsAt} 恢复` : ""}`);
    if (q.level === "tight" && PRIORITY_RANK[card.priority] > PRIORITY_RANK[config.tightMinPriority]) {
      return no(`${provider} 额度紧张，仅留给 ${config.tightMinPriority} 及以上优先级`);
    }
    return { ok: true, project, preset, provider };
  }

  /** The card timeline says who decided the dispatch (the owner reads why a card started). */
  function noteDispatch(cardId: string, via: { kind: "master" | "fallback"; reason: string }) {
    try {
      store.events.add({
        cardId,
        type: "note",
        authorKind: via.kind === "master" ? "master" : "system",
        author: via.kind === "master" ? "master" : "scheduler",
        body:
          via.kind === "master"
            ? { kind: "dispatch_by_master", text: `总 agent 选择现在派发这张卡${via.reason ? `：${via.reason}` : ""}` }
            : { kind: "dispatch_fallback", text: `总 agent 派发不可用（${via.reason}），已按调度器规则派发。` },
      });
    } catch {
      // The note is informational; a card that vanished meanwhile must not stop the admission.
    }
  }

  function updateMemoryGate(config: SchedulerConfig) {
    const snap = deps.resources();
    if (!snap) return;
    if (!paused && snap.mem >= config.memoryThreshold) {
      paused = true;
      publishEvent(
        db,
        {
          type: "scheduler.paused",
          payload: { reason: "memory", mem: snap.mem, top: topSessions(snap) },
          dedupeKey: `paused:${snap.ts}`,
        },
        now,
      );
    } else if (paused && snap.mem < config.memoryThreshold - 0.05) {
      paused = false;
      publishEvent(db, { type: "scheduler.resumed", payload: { reason: "memory" }, dedupeKey: `resumed:${snap.ts}` }, now);
    }
  }

  function announceQuota(quota: Record<string, ProviderQuota>) {
    for (const [provider, q] of Object.entries(quota)) {
      if (q.level !== "tight" && q.level !== "exhausted") {
        announcedQuota.delete(provider);
        continue;
      }
      const sig = `${q.level}:${q.resetsAt ?? ""}`;
      if (announcedQuota.get(provider) === sig) continue;
      announcedQuota.set(provider, sig);
      publishEvent(
        db,
        {
          type: "scheduler.quota_low",
          payload: { provider, level: q.level, remainingPct: q.remainingPct, resetsAt: q.resetsAt ?? null },
          dedupeKey: `quota:${provider}:${sig}:${now().toISOString()}`,
        },
        now,
      );
    }
  }

  async function tick(): Promise<TickResult> {
    const config = deps.config();
    reconcile();
    updateMemoryGate(config);
    const quota = deps.quota();
    announceQuota(quota);

    const admitted: Admission[] = [];
    const deferred: Record<string, string> = {};
    const result = () => {
      lastDeferred = deferred;
      return { admitted, deferred, paused };
    };

    const waiting = store.cards
      .list({ column: "todo" })
      .filter((c) => !pending.has(c.id))
      .map((c) => ({ card: c, since: todoSince(c) }))
      .sort(
        (a, b) =>
          PRIORITY_RANK[a.card.priority] - PRIORITY_RANK[b.card.priority] ||
          (a.since < b.since ? -1 : a.since > b.since ? 1 : 0) ||
          a.card.key.localeCompare(b.card.key),
      );

    if (paused) {
      for (const { card } of waiting) deferred[card.key] = "内存超过阈值，暂停放行";
      return result();
    }

    const counts = runningCounts();

    // ---- who decides the order: the scheduler's rules, or (WP-109) the master agent ----
    const mode = store.masterDispatch.get();
    let order = waiting;
    let via: { kind: "master" | "fallback"; reason: string } | null = null;
    if (!mode.enabled) {
      round = null;
      fallback = null;
    } else if (!mode.available) {
      via = { kind: "fallback", reason: mode.reason || "总 agent 不可用" };
    } else if (round?.kind === "chosen") {
      const chosen = round;
      round = null;
      const byId = new Map(waiting.map((w) => [w.card.id, w]));
      order = chosen.cardIds.map((id) => byId.get(id)).filter((w): w is (typeof waiting)[number] => !!w);
      for (const w of waiting) {
        if (!chosen.cardIds.includes(w.card.id)) deferred[w.card.key] = "总 agent 本轮没有选这张卡";
      }
      via = { kind: "master", reason: chosen.reason };
    } else if (round?.kind === "asking") {
      const limitMs = (mode.timeoutSeconds + 30) * 1000;
      if (now().getTime() - round.since <= limitMs) {
        for (const w of waiting) deferred[w.card.key] = "等待总 agent 选择派发";
        return result();
      }
      round = null;
      fallback = { until: now().getTime() + FALLBACK_MS, reason: `总 agent 超过 ${mode.timeoutSeconds} 秒没有回应` };
      via = { kind: "fallback", reason: fallback.reason };
    } else if (fallback && fallback.until > now().getTime()) {
      via = { kind: "fallback", reason: fallback.reason };
    } else {
      fallback = null;
      const candidates = waiting.filter((w) => check(w.card, config, counts, quota).ok);
      if (candidates.length > 0) {
        const requestId = `${now().getTime()}-${++requestSeq}`;
        round = { kind: "asking", requestId, since: now().getTime() };
        publishEvent(
          db,
          {
            type: "scheduler.dispatch_wanted",
            payload: {
              requestId,
              slots: Math.max(0, config.globalLimit - counts.total),
              cardIds: candidates.map((w) => w.card.id),
            },
            dedupeKey: `dispatch_wanted:${requestId}`,
          },
          now,
        );
        for (const w of waiting) deferred[w.card.key] = "等待总 agent 选择派发";
        return result();
      }
    }

    for (const { card } of order) {
      const verdict = check(card, config, counts, quota);
      if (!verdict.ok) {
        deferred[card.key] = verdict.reason;
        continue;
      }
      const { project, preset, provider } = verdict;

      const deviceIds: string[] = [];
      const kind = deviceKindFor(preset.runtimeEnv);
      if (kind && leases.listDevices(kind).length > 0) {
        const mine = leases.activeLeases().find((l) => l.session_id === leaseOwner(card.id));
        if (mine) {
          deviceIds.push(mine.device_id);
        } else {
          const preferred = project.devices.length ? project.devices : [undefined];
          let handle = null;
          for (const want of preferred) {
            try {
              handle = leases.tryAcquire({
                kind,
                cardId: card.id,
                sessionId: leaseOwner(card.id),
                preferredDeviceId: want,
                ttlMs: config.leaseTtlMinutes * 60_000,
              });
            } catch {
              handle = null; // listed device not registered under that name
            }
            if (handle) break;
          }
          if (!handle) {
            deferred[card.key] = `没有空闲的 ${kind} 设备`;
            continue;
          }
          deviceIds.push(handle.deviceId);
        }
      }

      let port: number;
      try {
        port = await ports.allocate(card.id);
      } catch (error) {
        releaseCard(card.id);
        deferred[card.key] = error instanceof Error ? error.message : String(error);
        continue;
      }

      const admission: Admission = {
        cardId: card.id,
        cardKey: card.key,
        provider,
        presetId: preset.id,
        port,
        deviceIds,
        at: now().toISOString(),
      };
      pending.set(card.id, admission);
      counts.total++;
      counts.byProvider[provider] = (counts.byProvider[provider] ?? 0) + 1;
      counts.byProject[project.id] = (counts.byProject[project.id] ?? 0) + 1;
      publishEvent(
        db,
        {
          type: "scheduler.admitted",
          cardId: card.id,
          projectId: card.projectId,
          payload: { cardId: card.id, presetId: preset.id, provider, port, deviceIds },
          // Time-based: a restarted scheduler must be able to admit the same card again.
          dedupeKey: `admit:${card.id}:${now().toISOString()}`,
        },
        now,
      );
      if (via) noteDispatch(card.id, via);
      admitted.push(admission);
    }
    // The master's pick got nothing through the checks: rules dispatch for a while instead of asking again at once.
    if (via?.kind === "master" && admitted.length === 0) {
      fallback = { until: now().getTime() + RETRY_AFTER_EMPTY_MS, reason: "总 agent 所选的卡片没有通过调度器检查" };
    }
    return result();
  }

  /** vibe-board could not dispatch an admitted card: free its slot and back off. */
  function handleDispatchFailed(cardId: string) {
    releaseCard(cardId);
    const prev = failures.get(cardId);
    const config = deps.config();
    const count = (prev?.count ?? 0) + 1;
    failures.set(cardId, { count, until: now().getTime() + config.retryCooldownSeconds * 1000 * count });
  }

  /** The master answered a request (events.ts `master.dispatch_chosen`). Stale ids are ignored. */
  function handleMasterChosen(payload: { requestId: string; cardIds: string[]; reason: string }) {
    if (round?.kind === "asking" && round.requestId === payload.requestId) {
      round = { kind: "chosen", requestId: payload.requestId, cardIds: payload.cardIds, reason: payload.reason };
    }
  }

  /** The master could not answer (`master.dispatch_failed`): rules dispatch for a while. */
  function handleMasterFailed(payload: { requestId: string; reason: string }) {
    if (round?.kind === "asking" && round.requestId === payload.requestId) {
      round = null;
      fallback = { until: now().getTime() + FALLBACK_MS, reason: payload.reason };
    }
  }

  return {
    tick,
    handleDispatchFailed,
    handleMasterChosen,
    handleMasterFailed,
    /** Forget failure history (a card the user touched may be retried). */
    resetFailures: (cardId: string) => void failures.delete(cardId),
    isPaused: () => paused,
    /** Emulator/simulator launches must wait while memory is above the threshold. */
    canStartEmulator: () => !paused,
    status: () => ({
      paused,
      pending: [...pending.values()],
      deferred: lastDeferred,
      running: runningCounts(),
      failures: Object.fromEntries([...failures].map(([k, v]) => [k, v.count])),
      masterDispatch: { ...store.masterDispatch.get(), round: round?.kind ?? null, fallbackReason: fallback?.reason ?? null },
    }),
  };
}

export type Scheduler = ReturnType<typeof createScheduler>;
