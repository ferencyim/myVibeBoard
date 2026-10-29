// GENERATED FROM plugins/vibe-shared — DO NOT EDIT (run: node scripts/vibe/sync-shared.mjs)
// Versioned, per-owner migrations for the shared vibe.db.
//
// schema_version(owner, version, applied_at) has one row per applied migration; the current
// version of an owner is MAX(version). Several plugin processes may call migrateOwner at the
// same time: each migration runs inside BEGIN IMMEDIATE and re-reads the version first, so
// the loser of the race sees the work already done and skips it.

import { dirname } from "node:path";
import { backupVibeDb } from "./backup";
import { MIGRATIONS, OWNER_DEPENDS, OWNERS, type Owner } from "./migrations";
import type { VibeDb } from "./sqlite";

export interface Migration {
  /** 1-based, strictly increasing, never edited once released. */
  version: number;
  name: string;
  sql: string;
  /**
   * Run with `PRAGMA foreign_keys = OFF` (table rebuilds that must not trigger ON DELETE actions
   * of referencing tables). The pragma only works outside a transaction, so it is switched around
   * the migration; violations are checked before commit.
   */
  foreignKeysOff?: boolean;
}

export interface MigrateResult {
  owner: Owner;
  from: number;
  to: number;
  applied: number[];
}

export class SchemaTooNewError extends Error {
  constructor(owner: string, dbVersion: number, codeVersion: number) {
    super(
      `vibe.db schema for "${owner}" is at version ${dbVersion}, newer than this build supports (${codeVersion}). Update the plugin.`,
    );
    this.name = "SchemaTooNewError";
  }
}

const CREATE_VERSION_TABLE = `
CREATE TABLE IF NOT EXISTS schema_version (
  owner TEXT NOT NULL,
  version INTEGER NOT NULL,
  applied_at TEXT NOT NULL,
  PRIMARY KEY (owner, version)
)`;

export function getSchemaVersion(db: VibeDb, owner: Owner): number {
  const exists = db
    .prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='schema_version'")
    .get();
  if (!exists) return 0;
  const row = db
    .prepare<{ v: number | null }>("SELECT MAX(version) AS v FROM schema_version WHERE owner = ?")
    .get(owner);
  return row?.v ?? 0;
}

export function latestVersion(owner: Owner): number {
  return MIGRATIONS[owner].at(-1)?.version ?? 0;
}

function validate(owner: Owner, list: readonly Migration[]): void {
  list.forEach((m, i) => {
    if (m.version !== i + 1)
      throw new Error(`Migration list for "${owner}" is not contiguous at index ${i}`);
  });
}

/** Bring one owner (and the owners it depends on) to the latest schema. Idempotent. */
export function migrateOwner(
  db: VibeDb,
  owner: Owner,
  now: () => Date = () => new Date(),
): MigrateResult {
  return migrateSchema(db, owner, now, true);
}

function migrateSchema(
  db: VibeDb,
  owner: Owner,
  now: () => Date,
  dependencies: boolean,
  targetVersion?: number,
): MigrateResult {
  if (dependencies) for (const dep of OWNER_DEPENDS[owner]) migrateOwner(db, dep, now);

  const list = MIGRATIONS[owner];
  validate(owner, list);
  const latest = targetVersion ?? latestVersion(owner);
  const from = getSchemaVersion(db, owner);
  if (from > latestVersion(owner)) throw new SchemaTooNewError(owner, from, latestVersion(owner));
  if (from >= latest) return { owner, from, to: from, applied: [] };

  // Existing databases are backed up before any upgrade writes or legacy deletion. Fresh databases
  // have no retained data; an explicit db path defines its own isolated VIBE_HOME.
  if (owner === "core" && from > 0 && from < 14 && db.path !== ":memory:")
    backupVibeDb(db, { vibeHome: dirname(db.path), now });

  db.exec(CREATE_VERSION_TABLE);
  const applied: number[] = [];
  for (const migration of list) {
    if (migration.version > latest) break;
    if (getSchemaVersion(db, owner) >= migration.version) continue;
    // The last legacy readers first materialize retained project attribution and task
    // evidence. They depend only on core, which has reached v13 at this point.
    if (owner === "core" && migration.version === 14)
      for (const retainedOwner of OWNERS.filter((candidate) => candidate !== "core"))
        migrateSchema(db, retainedOwner, now, false, retainedOwner === "verify" ? 3 : undefined);
    if (migration.foreignKeysOff) db.exec("PRAGMA foreign_keys = OFF");
    try {
      db.immediate(() => {
        // Re-check under the write lock: another process may have applied it meanwhile.
        if (getSchemaVersion(db, owner) >= migration.version) return;
        // Card evidence and the card tables disappear atomically. A failed cutover leaves
        // all legacy data available, including verification attachments.
        if (owner === "core" && migration.version === 14) migrateSchema(db, "verify", now, false);
        db.exec(migration.sql);
        if (migration.foreignKeysOff && db.prepare("PRAGMA foreign_key_check").all().length > 0)
          throw new Error(`Migration ${owner}/${migration.version} left foreign key violations`);
        db.prepare("INSERT INTO schema_version (owner, version, applied_at) VALUES (?, ?, ?)").run(
          owner,
          migration.version,
          now().toISOString(),
        );
        applied.push(migration.version);
      });
    } finally {
      if (migration.foreignKeysOff) db.exec("PRAGMA foreign_keys = ON");
    }
  }
  return { owner, from, to: latest, applied };
}

/** Migrate every owner (tests, tooling). Plugins normally migrate only their own owner. */
export function migrateAll(db: VibeDb, now?: () => Date): MigrateResult[] {
  return OWNERS.map((owner) => migrateOwner(db, owner, now));
}
