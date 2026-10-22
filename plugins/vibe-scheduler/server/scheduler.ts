// Admission control. Each tick decides which todo cards may start now and publishes
// `scheduler.admitted` for them (vibe-board's admission consumer then dispatches). Everything the
// decision depends on (clock, resources, quota, devices, ports) is injected.
//
// Order: priority (urgent first), then the time the card entered todo, then key.
// Limits: global, per provider and per project; the device pool limits through exclusive leases.
// Gates: memory pressure pauses all admissions; a tight provider only admits high priority cards;
// an exhausted provider admits nothing.

import type { CardView, DeviceKind } from "./vibe/contract";
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
    const minRank = PRIORITY_RANK[config.tightMinPriority];

    for (const { card } of waiting) {
      if (counts.total >= config.globalLimit) {
        deferred[card.key] = `已达全局并发上限 ${config.globalLimit}`;
        continue;
      }
      const failure = failures.get(card.id);
      if (failure && (failure.count >= config.maxAdmitAttempts || failure.until > now().getTime())) {
        deferred[card.key] =
          failure.count >= config.maxAdmitAttempts ? "多次派发失败，已放弃" : "派发失败后冷却中，稍后重试";
        continue;
      }
      const project = store.projects.get(card.projectId);
      // Same order as vibe-board's dispatcher: card, master recommendation, project default.
      const presetId = pickPresetId(card, project, (id) => !!store.presets.get(id));
      const preset = presetId ? store.presets.get(presetId) : undefined;
      if (!project || !preset) {
        deferred[card.key] = "没有执行预设（请在卡片上选择，或给项目设默认预设）";
        continue;
      }
      const provider = preset.provider;
      const providerLimit = effectiveLimit(config, provider, null);
      if ((counts.byProvider[provider] ?? 0) >= providerLimit) {
        deferred[card.key] = `${provider} 已达并发上限 ${providerLimit}`;
        continue;
      }
      if (project.concurrencyLimit != null && (counts.byProject[project.id] ?? 0) >= project.concurrencyLimit) {
        deferred[card.key] = `项目已达并发上限 ${project.concurrencyLimit}`;
        continue;
      }
      if (config.conflictAvoidance) {
        const files = plannedFiles(card.id);
        const other = files.length ? conflictWith(card.projectId, card.id, files) : null;
        if (other) {
          deferred[card.key] = `与 ${other} 改动相同的文件，等它结束`;
          continue;
        }
      }
      const q = quotaFor(quota, provider);
      if (q.level === "exhausted") {
        deferred[card.key] = `${provider} 额度已用完${q.resetsAt ? `，${q.resetsAt} 恢复` : ""}`;
        continue;
      }
      if (q.level === "tight" && PRIORITY_RANK[card.priority] > minRank) {
        deferred[card.key] = `${provider} 额度紧张，仅留给 ${config.tightMinPriority} 及以上优先级`;
        continue;
      }

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
      admitted.push(admission);
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

  return {
    tick,
    handleDispatchFailed,
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
    }),
  };
}

export type Scheduler = ReturnType<typeof createScheduler>;
