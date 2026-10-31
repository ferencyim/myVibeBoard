import type { PaseoAgentHandle } from "@getpaseo/client";

// Only armed after the coordinator calls hub.status; ordinary agent turns are unaffected.
export const HUB_TURN_IDLE_TIMEOUT_MS = 15 * 60_000;
const OBSERVATION_TIMEOUT_MS = 15_000;
const RETRY_MS = 30_000;
const active = new Map<string, () => void>();

function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("中枢轮次观察超时")), OBSERVATION_TIMEOUT_MS);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

export function stopHubTurnWatchdogs(): void {
  for (const stop of active.values()) stop();
}

export function armHubTurnWatchdog(handle: PaseoAgentHandle, onTimeout?: () => void): void {
  active.get(handle.id)?.();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  let turnId: string | undefined;
  let lastUserMessageAt: string | null = null;
  let generation = 0;
  let observationGeneration = 0;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    unsubscribe?.();
    if (active.get(handle.id) === stop) active.delete(handle.id);
  };
  active.set(handle.id, stop);
  const retry = (error: unknown) => {
    if (stopped) return;
    generation++;
    observationGeneration++;
    console.error("[vibe-bots] 无法可靠监听中枢轮次进展，将重试", error);
    unsubscribe?.();
    unsubscribe = undefined;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void observe(); }, RETRY_MS);
    (timer as unknown as NodeJS.Timeout).unref?.();
  };
  const schedule = () => {
    if (stopped || !turnId) return;
    if (timer) clearTimeout(timer);
    const expected = ++generation;
    timer = setTimeout(() => {
      void (async () => {
        try {
          await bounded(handle.refresh());
          if (stopped || generation !== expected) return;
          const current = handle.current();
          if (!current || current.activeTurn?.turnId !== turnId || current.lastUserMessageAt !== lastUserMessageAt) return stop();
          if (current.pendingPermissions.length) return schedule();
          console.error(`[vibe-bots] 中枢状态调用后轮次连续 15 分钟无进展，正在取消：${handle.id} (${turnId})`);
          try { onTimeout?.(); } catch (error) { console.error("[vibe-bots] 中枢轮次超时通知失败", error); }
          await bounded(handle.cancelRun());
          stop();
        } catch (error) {
          retry(error);
        }
      })();
    }, HUB_TURN_IDLE_TIMEOUT_MS);
    (timer as unknown as NodeJS.Timeout).unref?.();
  };
  async function observe() {
    const observation = ++observationGeneration;
    try {
      await bounded(handle.refresh());
      if (stopped || observation !== observationGeneration) return;
      const current = handle.current();
      if (!current?.activeTurn) return stop();
      if (turnId && (current.activeTurn.turnId !== turnId || current.lastUserMessageAt !== lastUserMessageAt)) return stop();
      turnId = current.activeTurn.turnId;
      lastUserMessageAt = current.lastUserMessageAt;
      const subscription = handle.timeline.subscribe(({ event }) => {
        if (event.type === "turn_completed" || event.type === "turn_failed" || event.type === "turn_canceled") return stop();
        if (event.type === "error") return retry(new Error(event.error));
        schedule();
      });
      unsubscribe = subscription;
      if (stopped) return unsubscribe();
      await bounded(subscription.ready);
      if (!stopped && observation === observationGeneration) schedule();
    } catch (error) {
      if (observation === observationGeneration) retry(error);
    }
  }
  void observe();
}
