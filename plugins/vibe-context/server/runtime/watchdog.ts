import type { AgentSession } from "../vibe/contract";
import type { VibeStore } from "../vibe/db";

export interface TaskWatchdogOptions {
  store: Pick<VibeStore, "sessions">;
  config(): { enabled: boolean; minutes: number; providerMinutes: Record<string, number> };
  activity(session: AgentSession): Promise<number | null>;
  report(session: AgentSession, text: string): void | Promise<void>;
  now?: () => number;
}
/** Waits for real output. Waiting on a user permission is never a stall; never starts an unadmitted turn. */
export function createTaskWatchdog(options: TaskWatchdogOptions) {
  let running = false;
  return {
    async tick() {
      if (running) return;
      running = true;
      try {
        const config = options.config();
        if (!config.enabled) return;
        const now = options.now ?? Date.now;
        for (const session of options.store.sessions.list({ states: ["starting", "working"] })) {
          let activity: number | null = null;
          try {
            activity = await options.activity(session);
          } catch {
            /* Unknown activity does not clear a stall. */
          }
          let current = options.store.sessions.get(session.id);
          if (!current || !["starting", "working"].includes(current.state)) continue;
          if (
            activity !== null &&
            Number.isFinite(activity) &&
            activity > Date.parse(current.lastActivityAt)
          ) {
            current = options.store.sessions.touchActivity(
              session.id,
              new Date(Math.min(activity, now())).toISOString(),
            );
          }
          const idleMs = now() - Date.parse(current.lastActivityAt);
          const threshold =
            (config.providerMinutes[current.currentProvider.split("/")[0]!] ?? config.minutes) *
            60_000;
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
