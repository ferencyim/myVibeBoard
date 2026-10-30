// vibe.db access for the hub: resource registry, pause rules, finished-job log, settings.

import { randomUUID } from "node:crypto";
import { readResourceMeta, writeResourceMeta, type VibeDb } from "./vibe/db";

export interface HubResource {
  name: string;
  maxShared: number;
  note: string;
}
export interface HubPause {
  id: string;
  scope: string;
  until: string | null;
  reason: string;
  issuedBy: string;
  createdAt: string;
  revokedAt: string | null;
}
export interface HubJobLogRow {
  id: string;
  owner: string;
  project: string | null;
  command: string;
  priority: number;
  queuedAt: string;
  admittedAt: string | null;
  finishedAt: string;
  exitCode: number | null;
  durationMs: number | null;
  outcome: "released" | "reaped";
}

const LOG_KEEP = 500;

export function createHubStore(db: VibeDb, now: () => Date) {
  const iso = () => now().toISOString();
  return {
    readSettings: <T>(fallback: T) => readResourceMeta<T>(db, "hub.settings", fallback),
    hasSettings: () => !!db.prepare("SELECT 1 AS x FROM vibe_meta WHERE key = 'hub.settings'").get(),
    writeSettings: (value: unknown) => writeResourceMeta(db, "hub.settings", value),

    listResources(): HubResource[] {
      return db
        .prepare<{ name: string; max_shared: number; note: string }>(
          "SELECT name,max_shared,note FROM hub_resource ORDER BY name",
        )
        .all()
        .map((r) => ({ name: r.name, maxShared: r.max_shared, note: r.note }));
    },
    upsertResource(input: { name: string; maxShared: number; note?: string }) {
      db.prepare(
        `INSERT INTO hub_resource (name,max_shared,note,created_at,updated_at) VALUES (?,?,?,?,?)
         ON CONFLICT(name) DO UPDATE SET max_shared=excluded.max_shared, note=excluded.note, updated_at=excluded.updated_at`,
      ).run(input.name, input.maxShared, input.note ?? "", iso(), iso());
    },
    removeResource: (name: string) =>
      db.prepare("DELETE FROM hub_resource WHERE name = ?").run(name).changes > 0,

    createPause(input: { scope: string; until: string | null; reason: string; issuedBy: string }): HubPause {
      const pause: HubPause = {
        id: randomUUID(),
        ...input,
        createdAt: iso(),
        revokedAt: null,
      };
      db.prepare(
        "INSERT INTO hub_pause (id,scope,until,reason,issued_by,created_at) VALUES (?,?,?,?,?,?)",
      ).run(pause.id, pause.scope, pause.until, pause.reason, pause.issuedBy, pause.createdAt);
      return pause;
    },
    revokePause: (id: string) =>
      db
        .prepare("UPDATE hub_pause SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
        .run(iso(), id).changes > 0,
    listPauses(activeOnly: boolean): HubPause[] {
      const rows = db
        .prepare<{
          id: string;
          scope: string;
          until: string | null;
          reason: string;
          issued_by: string;
          created_at: string;
          revoked_at: string | null;
        }>(
          activeOnly
            ? "SELECT * FROM hub_pause WHERE revoked_at IS NULL AND (until IS NULL OR until > ?) ORDER BY created_at"
            : "SELECT * FROM hub_pause ORDER BY created_at DESC LIMIT 200",
        )
        .all(...(activeOnly ? [iso()] : []));
      return rows.map((r) => ({
        id: r.id,
        scope: r.scope,
        until: r.until,
        reason: r.reason,
        issuedBy: r.issued_by,
        createdAt: r.created_at,
        revokedAt: r.revoked_at,
      }));
    },

    logJob(row: HubJobLogRow) {
      db.prepare(
        `INSERT OR REPLACE INTO hub_job_log
         (id,owner,project,command,priority,queued_at,admitted_at,finished_at,exit_code,duration_ms,outcome)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        row.id,
        row.owner,
        row.project,
        row.command.slice(0, 500),
        row.priority,
        row.queuedAt,
        row.admittedAt,
        row.finishedAt,
        row.exitCode,
        row.durationMs,
        row.outcome,
      );
      db.prepare(
        "DELETE FROM hub_job_log WHERE id NOT IN (SELECT id FROM hub_job_log ORDER BY finished_at DESC LIMIT ?)",
      ).run(LOG_KEEP);
    },
    recentJobs(limit = 50): HubJobLogRow[] {
      return db
        .prepare<Record<string, unknown>>(
          "SELECT * FROM hub_job_log ORDER BY finished_at DESC LIMIT ?",
        )
        .all(limit)
        .map((r) => ({
          id: r.id as string,
          owner: r.owner as string,
          project: (r.project as string | null) ?? null,
          command: r.command as string,
          priority: r.priority as number,
          queuedAt: r.queued_at as string,
          admittedAt: (r.admitted_at as string | null) ?? null,
          finishedAt: r.finished_at as string,
          exitCode: (r.exit_code as number | null) ?? null,
          durationMs: (r.duration_ms as number | null) ?? null,
          outcome: r.outcome as "released" | "reaped",
        }));
    },
  };
}
export type HubStore = ReturnType<typeof createHubStore>;
