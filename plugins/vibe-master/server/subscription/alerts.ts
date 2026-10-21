// "Only remind" alerts (quota low / quota error). They are published on the vibe_event bus as a
// `master.alert` event; server/notify turns it into a push. The master is never switched
// automatically; the owner decides.

import { publishEvent, type VibeDb } from "../vibe/db";
import type { Clock } from "../clock";
import { defaultTuning, type TuningSource } from "../tuning";
import type { MasterStateFile } from "./state";

export type AlertKind = "quota_low" | "quota_error" | "maintenance_paused" | "permission_wait" | "requirements_failed";

export interface Alerts {
  /** `subject` is the provider for quota alerts and the rule name for maintenance alerts. */
  raise(kind: AlertKind, subject: string, message: string): boolean;
}

/** Which cooldown group (settings) an alert kind belongs to. */
const COOLDOWN_GROUP = {
  quota_low: "quotaLow",
  quota_error: "urgent",
  maintenance_paused: "routine",
  permission_wait: "urgent",
  requirements_failed: "routine",
} as const satisfies Record<AlertKind, "quotaLow" | "urgent" | "routine">;

export function createAlerts(options: {
  db: VibeDb;
  state: MasterStateFile;
  clock: Clock;
  sessionId: () => string | null;
  tuning?: TuningSource;
  log?: (message: string) => void;
}): Alerts {
  return {
    raise(kind, subject, message) {
      const now = options.clock.now();
      const cooldown = (options.tuning ?? defaultTuning)().alertCooldownMs[COOLDOWN_GROUP[kind]];
      const bucket = Math.floor(now / cooldown);
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
