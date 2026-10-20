import { describe, expect, it } from "vitest";
import { DEFAULT_TAGS } from "../contract/enums";
import { SYNC_TABLES } from "../contract/sync-spec";
import {
  MIGRATIONS,
  OWNERS,
  SchemaTooNewError,
  defaultDbPath,
  getSchemaVersion,
  latestVersion,
  migrateAll,
  migrateOwner,
  openVibeDb,
  resolveVibeHome,
} from "../db";
import { openTestDb, runWorker } from "./helpers";

const EXPECTED_TABLES = [
  "project",
  "card",
  "card_event",
  "preset",
  "tag",
  "card_tag",
  "attachment",
  "agent_session",
  "plan_version",
  "git_snapshot",
  "vibe_event",
  "vibe_cursor",
  "vibe_event_dead",
  "sync_meta",
  "sync_tombstone",
  "sync_field",
  "sync_tomb",
  "vibe_meta",
  "verification",
  "verification_item",
  "evidence_file",
  "memory_entry",
  "resource_sample",
  "device",
  "device_lease",
  "usage_event",
  "usage_cursor",
  "maintenance_rule",
  "maintenance_run",
  "work_counter",
  "schema_version",
];

function tableNames(db: ReturnType<typeof openVibeDb>): string[] {
  return db
    .prepare<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )
    .all()
    .map((r) => r.name);
}

describe("migrations", () => {
  it("migrates from zero to latest and creates every table", () => {
    const { db } = openTestDb();
    expect(tableNames(db)).toEqual([]);
    const results = migrateAll(db);
    expect(results.map((r) => r.owner)).toEqual([...OWNERS]);
    for (const owner of OWNERS) expect(getSchemaVersion(db, owner)).toBe(latestVersion(owner));
    expect(tableNames(db).sort()).toEqual([...EXPECTED_TABLES].sort());
    db.close();
  });

  it("is idempotent: a second run applies nothing", () => {
    const { db } = openTestDb();
    migrateAll(db);
    const again = migrateAll(db);
    expect(again.every((r) => r.applied.length === 0 && r.from === r.to)).toBe(true);
    const rows = db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM schema_version").get();
    expect(rows?.n).toBe(OWNERS.reduce((sum, o) => sum + MIGRATIONS[o].length, 0));
    db.close();
  });

  it("migrating a dependent owner brings core along, and only that owner", () => {
    const { db } = openTestDb();
    const result = migrateOwner(db, "verify");
    expect(getSchemaVersion(db, "core")).toBe(latestVersion("core"));
    expect(getSchemaVersion(db, "verify")).toBe(latestVersion("verify"));
    expect(getSchemaVersion(db, "stats")).toBe(0);
    expect(result.applied).toEqual(MIGRATIONS.verify.map((m) => m.version));
    expect(tableNames(db)).not.toContain("usage_event");
    db.close();
  });

  it("seeds the default tag vocabulary once", () => {
    const { db } = openTestDb();
    migrateAll(db);
    migrateAll(db);
    const tags = db
      .prepare<{ name: string; evidence: number }>("SELECT name, evidence FROM tag ORDER BY rowid")
      .all();
    expect(tags.map((t) => t.name)).toEqual(DEFAULT_TAGS.map((t) => t.name));
    expect(tags.find((t) => t.name === "feature")?.evidence).toBe(1);
    expect(tags.find((t) => t.name === "bug")?.evidence).toBe(0);
    db.close();
  });

  it("refuses a database newer than the code", () => {
    const { db } = openTestDb();
    migrateAll(db);
    db.prepare(
      "INSERT INTO schema_version (owner, version, applied_at) VALUES ('core', 99, 'x')",
    ).run();
    expect(() => migrateOwner(db, "core")).toThrow(SchemaTooNewError);
    db.close();
  });

  it("rolls back DDL when a write transaction fails", () => {
    const { db } = openTestDb();
    const failing = () =>
      db.immediate(() => {
        db.exec("CREATE TABLE half_done (x INTEGER)");
        throw new Error("boom");
      });
    expect(failing).toThrow("boom");
    expect(tableNames(db)).not.toContain("half_done");
    db.close();
  });

  it("enforces foreign keys and CHECK constraints", () => {
    const { db } = openTestDb();
    migrateAll(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO card (id, project_id, number, key, title, sort_key, created_at, updated_at)
           VALUES ('c1', 'missing', 1, 'X-1', 't', 'a', 'now', 'now')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
    expect(() =>
      db
        .prepare(
          `INSERT INTO project (id, name, prefix, repo_path, created_at, updated_at)
           VALUES ('p1', 'n', 'lower', '/x', 'now', 'now')`,
        )
        .run(),
    ).toThrow(/CHECK/);
    db.close();
  });

  it("every synced 'both' table has updated_hlc and every listed field is a real column", () => {
    const { db } = openTestDb();
    migrateAll(db);
    for (const spec of SYNC_TABLES.filter((s) => s.direction === "both")) {
      const cols = db
        .prepare<{ name: string }>(`PRAGMA table_info(${spec.table})`)
        .all()
        .map((c) => c.name);
      expect(cols, spec.table).toContain("updated_hlc");
      for (const f of spec.fields) expect(cols, `${spec.table}.${f}`).toContain(f);
      for (const k of spec.pk) expect(cols, `${spec.table}.${k}`).toContain(k);
    }
    db.close();
  });

  it("several processes migrating different owners at the same time end up consistent", async () => {
    const { db, path } = openTestDb();
    db.close();
    const owners = [
      "core",
      "verify",
      "context",
      "scheduler",
      "stats",
      "maintain",
      "core",
      "verify",
    ];
    const runs = await Promise.all(owners.map((o) => runWorker(["migrate", path, o])));
    for (const r of runs) expect(r, r.stderr).toMatchObject({ code: 0 });

    const check = openVibeDb({ path });
    for (const owner of OWNERS) expect(getSchemaVersion(check, owner)).toBe(latestVersion(owner));
    // no duplicated version rows
    const rows = check.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM schema_version").get();
    expect(rows?.n).toBe(OWNERS.reduce((sum, o) => sum + MIGRATIONS[o].length, 0));
    expect(check.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM tag").get()?.n).toBe(
      DEFAULT_TAGS.length,
    );
    check.close();
  });
});

describe("paths", () => {
  it("honours VIBE_HOME and falls back to ~/.vibe", () => {
    expect(resolveVibeHome({ VIBE_HOME: "/tmp/x" } as NodeJS.ProcessEnv)).toBe("/tmp/x");
    expect(defaultDbPath({ VIBE_HOME: "/tmp/x" } as NodeJS.ProcessEnv).replaceAll("\\", "/")).toBe(
      "/tmp/x/vibe.db",
    );
    expect(resolveVibeHome({} as NodeJS.ProcessEnv).replaceAll("\\", "/")).toMatch(/\/\.vibe$/);
  });
});
