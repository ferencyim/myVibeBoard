// Events the hub tells the coordinator bot about (HUB-DESIGN 4). The bot decides whether the user
// needs to hear about it; here we only detect the event and send each one at most once an hour.

import { describeWaitReason, type Hub } from "./hub";
import type { VibeDb } from "./vibe/db/sqlite";

export const NOTIFY_DEDUPE_MS = 60 * 60_000;
export const NOTIFY_RETRY_MS = 5 * 60_000;
export const QUEUE_WARN_MS = 15 * 60_000;
export const METRIC_WARN_MS = 5 * 60_000;

/** A previous alert can remain queued across scheduler restarts while the bot is busy. */
export function hasQueuedMetricAlert(db: VibeDb, key: string): boolean {
  if (!key.startsWith("metric:")) return false;
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bot_message'").get()) return false;
  const suffix = `超过阈值：${describeWaitReason(key.slice("metric:".length))}。`;
  return !!db.prepare(
    `SELECT 1 FROM bot_message m JOIN bot b ON b.id=m.to_bot_id
     WHERE b.role='coordinator' AND b.archived_at IS NULL AND m.status='queued'
       AND m.from_bot_id IS NULL AND m.text LIKE '[中枢] 机器指标已连续 %'
       AND substr(m.text, -length(?))=? LIMIT 1`,
  ).get(suffix, suffix);
}

/** Fire-and-forget sender with a per-key cooldown, including a shorter cooldown on failure. */
export function createCoordinatorNotifier(options: {
  send: (text: string) => Promise<unknown>;
  now?: () => number;
  dedupeMs?: number;
  onError?: (error: unknown) => void;
  hasPending?: (key: string) => boolean;
}) {
  const now = options.now ?? Date.now;
  const dedupeMs = options.dedupeMs ?? NOTIFY_DEDUPE_MS;
  const retryAt = new Map<string, number>();
  const pending = new Set<string>();
  return function notify(key: string, text: string): void {
    const t = now();
    for (const [k, at] of retryAt) if (t >= at) retryAt.delete(k);
    if (pending.has(key) || retryAt.has(key)) return;
    if (options.hasPending?.(key)) return;
    pending.add(key);
    Promise.resolve().then(() => options.send(text)).then(
      (result) => {
        const accepted = !(result && typeof result === "object" && (result as { accepted?: boolean }).accepted === false);
        retryAt.set(key, now() + (accepted ? dedupeMs : NOTIFY_RETRY_MS));
        return undefined;
      },
      (error) => {
        retryAt.set(key, now() + NOTIFY_RETRY_MS);
        options.onError?.(error);
        return undefined;
      },
    ).finally(() => pending.delete(key));
  };
}

export function createHubWatcher(options: {
  hub: Hub;
  notify: (key: string, text: string) => void;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  /** metric reason -> since when it has been continuously over its threshold */
  const over = new Map<string, number>();
  let knownPauses = new Map<string, { scope: string; reason: string }>();

  return async function check(): Promise<void> {
    const t = now();
    const status = await options.hub.status();

    for (const q of status.queue) {
      if (q.kind !== "job" || !q.queuedAt) continue;
      const waited = t - Date.parse(q.queuedAt);
      if (waited < QUEUE_WARN_MS) continue;
      options.notify(
        "queue:" + q.id,
        `重任务已排队 ${Math.round(waited / 60_000)} 分钟：${q.owner} 的「${q.summary.slice(0, 80)}」，` +
          `等待原因：${q.waitReasons.map(describeWaitReason).join("、") || "排在前面的任务之后"}。` +
          `[阈值复核] 若此时机器资源其实闲置，请用 vibe_hub_history 复核阈值是否过紧。`,
      );
    }

    const blocked = new Set(status.machine.blockedBy);
    for (const reason of [...over.keys()]) if (!blocked.has(reason)) over.delete(reason);
    for (const reason of blocked) {
      const since = over.get(reason) ?? t;
      over.set(reason, since);
      if (t - since >= METRIC_WARN_MS)
        options.notify(
          "metric:" + reason,
          `机器指标已连续 ${Math.round((t - since) / 60_000)} 分钟超过阈值：${describeWaitReason(reason)}。`,
        );
    }

    const active = new Map(options.hub.listPauses(true).map((p) => [p.id, p]));
    const revoked = new Set(
      options.hub
        .listPauses(false)
        .filter((p) => p.revokedAt)
        .map((p) => p.id),
    );
    for (const [id, p] of knownPauses)
      if (!active.has(id) && !revoked.has(id))
        options.notify("pause-expired:" + id, `暂停已到期并自动解除：${p.scope}（${p.reason || "无说明"}）。`);
    knownPauses = new Map([...active].map(([id, p]) => [id, { scope: p.scope, reason: p.reason }]));
  };
}
