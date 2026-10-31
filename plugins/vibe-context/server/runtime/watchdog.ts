import type { AgentSession } from "../vibe/contract";
import type { VibeStore } from "../vibe/db";

export interface TaskWatchdogOptions {
  store: Pick<VibeStore, "sessions">;
  config(): { enabled: boolean; minutes: number; providerMinutes: Record<string, number> };
  activity(session: AgentSession): Promise<number | null>;
  report(session: AgentSession, text: string): void | Promise<void>;
  now?: () => number;
  /** No activity reads right after daemon start: they would resume every agent while it boots. */
  startDelayMs?: number;
  /** Limit expensive history reads per tick; rotate so every stale session gets a turn. */
  maxActivityReadsPerTick?: number;
}

const FAILED_ACTIVITY_RETRY_MS = 5 * 60_000;

/** Waits for real output. Waiting on a user permission is never a stall; never starts an unadmitted turn. */
export function createTaskWatchdog(options: TaskWatchdogOptions) {
  let running = false;
  const startedAt = (options.now ?? Date.now)();
  const failedAt = new Map<string, number>();
  let nextAgentId: string | undefined;
  const recent = (session: AgentSession, threshold: number, now: number) =>
    !session.stalledSince && now - Date.parse(session.lastActivityAt) < threshold;
  const hasNewActivity = (activity: number | null, session: AgentSession): activity is number =>
    activity !== null && Number.isFinite(activity) && activity > Date.parse(session.lastActivityAt);
  return {
    async tick() {
      if (running) return;
      running = true;
      try {
        const config = options.config();
        if (!config.enabled) return;
        const now = options.now ?? Date.now;
        if (now() - startedAt < (options.startDelayMs ?? 0)) return;
        const sessions = options.store.sessions.list({ states: ["starting", "working"] });
        const start = Math.max(0, sessions.findIndex((s) => s.agentId === nextAgentId));
        let reads = 0;
        for (let offset = 0; offset < sessions.length; offset++) {
          const index = (start + offset) % sessions.length;
          const session = sessions[index]!;
          const threshold =
            (config.providerMinutes[session.currentProvider.split("/")[0]!] ?? config.minutes) *
            60_000;
          // lastActivityAt is persisted. Until it can possibly be stale, history cannot affect
          // the decision; avoid resuming every unchanged agent after each daemon restart.
          if (recent(session, threshold, now())) continue;
          let activity: number | null = null;
          const failed = failedAt.get(session.agentId);
          if (failed === undefined || now() - failed >= FAILED_ACTIVITY_RETRY_MS) {
            if (reads >= (options.maxActivityReadsPerTick ?? Infinity)) continue;
            reads++;
            nextAgentId = sessions[(index + 1) % sessions.length]?.agentId;
            try {
              activity = await options.activity(session);
              failedAt.delete(session.agentId);
            } catch {
              // Unknown activity does not clear a stall; remember it so a broken agent is not re-resumed every tick.
              failedAt.set(session.agentId, now());
            }
          }
          let current = options.store.sessions.get(session.id);
          if (!current || !["starting", "working"].includes(current.state)) continue;
          if (hasNewActivity(activity, current)) {
            current = options.store.sessions.touchActivity(
              session.id,
              new Date(Math.min(activity, now())).toISOString(),
            );
          }
          const idleMs = now() - Date.parse(current.lastActivityAt);
          if (!current.stalledSince && idleMs >= threshold) {
            options.store.sessions.markStalled(current.id, {
              idleMs,
              since: new Date(now()).toISOString(),
            });
            await options.report(current, "会话长时间没有输出，请检查原生会话；资源继续保留。");
          }
        }
      } finally {
        running = false;
      }
    },
  };
}
