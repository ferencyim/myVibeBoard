// "Only remind" alerts (quota low / quota error). They are published on the vibe_event bus as a
// `session.error` of the master session with a `[master:<kind>]` message prefix: the existing
// event vocabulary has no dedicated alert type, and the daemon's own push already fires when the
// master agent turn errors. The master is never switched automatically; the owner decides.

import { publishEvent, type VibeDb } from "../vibe/db";
import type { Clock } from "../clock";
import type { MasterStateFile } from "./state";

export type AlertKind = "quota_low" | "quota_error";

export interface Alerts {
  raise(kind: AlertKind, provider: string, message: string): boolean;
}

const COOLDOWN_MS: Record<AlertKind, number> = {
  quota_low: 6 * 60 * 60_000,
  quota_error: 10 * 60_000,
};

export function createAlerts(options: {
  db: VibeDb;
  state: MasterStateFile;
  clock: Clock;
  sessionId: () => string | null;
  log?: (message: string) => void;
}): Alerts {
  return {
    raise(kind, provider, message) {
      const now = options.clock.now();
      const bucket = Math.floor(now / COOLDOWN_MS[kind]);
      const text = `[master:${kind}] ${provider}: ${message}`;
      const seq = publishEvent(options.db, {
        type: "session.error",
        payload: { sessionId: options.sessionId() ?? "master", message: text },
        dedupeKey: `master-alert:${kind}:${provider}:${bucket}`,
        ts: new Date(now).toISOString(),
      });
      options.state.update((s) => ({
        ...s,
        lastAlert: { kind, message: `${provider}: ${message}`, at: new Date(now).toISOString() },
      }));
      options.log?.(`alert ${kind} (${provider}): ${message} [event ${seq}]`);
      return true;
    },
  };
}
