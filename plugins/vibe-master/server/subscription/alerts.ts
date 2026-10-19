// "Only remind" alerts (quota low / quota error). They are published on the vibe_event bus as a
// `master.alert` event; server/notify turns it into a push. The master is never switched
// automatically; the owner decides.

import { publishEvent, type VibeDb } from "../vibe/db";
import type { Clock } from "../clock";
import type { MasterStateFile } from "./state";

export type AlertKind = "quota_low" | "quota_error" | "maintenance_paused";

export interface Alerts {
  /** `subject` is the provider for quota alerts and the rule name for maintenance alerts. */
  raise(kind: AlertKind, subject: string, message: string): boolean;
}

const COOLDOWN_MS: Record<AlertKind, number> = {
  quota_low: 6 * 60 * 60_000,
  quota_error: 10 * 60_000,
  maintenance_paused: 60 * 60_000,
};

export function createAlerts(options: {
  db: VibeDb;
  state: MasterStateFile;
  clock: Clock;
  sessionId: () => string | null;
  log?: (message: string) => void;
}): Alerts {
  return {
    raise(kind, subject, message) {
      const now = options.clock.now();
      const bucket = Math.floor(now / COOLDOWN_MS[kind]);
      const seq = publishEvent(options.db, {
        type: "master.alert",
        payload: {
          kind,
          ...(kind === "maintenance_paused" ? {} : { provider: subject }),
          message,
          sessionId: options.sessionId() ?? "master",
        },
        dedupeKey: `master-alert:${kind}:${subject}:${bucket}`,
        ts: new Date(now).toISOString(),
      });
      options.state.update((s) => ({
        ...s,
        lastAlert: { kind, message: `${subject}: ${message}`, at: new Date(now).toISOString() },
      }));
      options.log?.(`alert ${kind} (${subject}): ${message} [event ${seq}]`);
      return true;
    },
  };
}
