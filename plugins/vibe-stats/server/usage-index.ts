import type { VibeDb } from "./vibe/db";

/** Relinking probes by provider and session; create this optional read index once per database. */
export function ensureUsageSessionIndex(db: VibeDb): void {
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_usage_event_provider_session ON usage_event(provider, session_id)",
  );
}
