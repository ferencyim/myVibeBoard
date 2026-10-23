import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { backupVibeDb } from "../db/backup";
import {
  MIGRATIONS,
  OWNERS,
  getSchemaVersion,
  migrateAll,
  migrateOwner,
  openVibeDb,
  type VibeDb,
  createTaskRuntimeCommands,
} from "../db";
import { openTestDb } from "./helpers";

const retained = [
  "project",
  "preset",
  "vibe_meta",
  "prompt_template",
  "prompt_override",
  "maintenance_rule",
  "maintenance_run",
  "work_counter",
  "memory_entry",
  "usage_event",
  "usage_cursor",
  "resource_sample",
  "device",
  "device_lease",
];
const timestamp = "2026-10-23T12:00:00.000Z";

/** Latest fourth-round schema, without running the new task migration. */
function legacyFixture(db: VibeDb): void {
  db.exec(
    "CREATE TABLE schema_version (owner TEXT NOT NULL, version INTEGER NOT NULL, applied_at TEXT NOT NULL, PRIMARY KEY(owner,version))",
  );
  for (const owner of OWNERS) {
    const historicalVersion = {
      core: 10,
      verify: 2,
      context: 1,
      scheduler: 1,
      stats: 1,
      maintain: 1,
    }[owner];
    for (const migration of MIGRATIONS[owner].filter((m) => m.version <= historicalVersion)) {
      if (migration.foreignKeysOff) db.exec("PRAGMA foreign_keys = OFF");
      db.immediate(() => {
        db.exec(migration.sql);
        db.prepare("INSERT INTO schema_version VALUES (?, ?, ?)").run(
          owner,
          migration.version,
          timestamp,
        );
      });
      if (migration.foreignKeysOff) db.exec("PRAGMA foreign_keys = ON");
    }
  }
  db.immediate(() => {
    const candidates = JSON.stringify([
      { provider: "codex", model: "primary", thinking: "high", permissionMode: "auto" },
      { provider: "claude", model: "fallback", thinking: "", permissionMode: "accept-edits" },
    ]);
    db.prepare(
      "INSERT INTO preset (id,name,provider,model,models_json,instructions,created_at,updated_at) VALUES ('preset','保留预设','codex','primary',?,'预设指令',?,?)",
    ).run(candidates, timestamp, timestamp);
    const defaults = JSON.stringify({
      scout: "preset",
      planner: "preset",
      plan_reviewer: "preset",
      worker: "preset",
      subagent: "preset",
      reviewer: "preset",
      verifier: "preset",
    });
    db.prepare("INSERT INTO vibe_meta VALUES ('models.defaults', ?)").run(defaults);
    db.prepare(
      "INSERT INTO prompt_template (key,plugin,role,title,default_text,updated_at) VALUES ('test.prompt','vibe-master','planner','保留提示词','默认提示词',?)",
    ).run(timestamp);
    db.prepare(
      "INSERT INTO prompt_override (id,key,project_id,text,created_at,updated_at) VALUES ('test.prompt@*','test.prompt',NULL,'自定义提示词',?,?)",
    ).run(timestamp, timestamp);
    db.prepare(
      "INSERT INTO device (id,kind,name,created_at) VALUES ('device','emulator','测试设备',?)",
    ).run(timestamp);
    for (let i = 1; i <= 7; i++) {
      const id = "p" + i;
      db.prepare(
        "INSERT INTO project (id,name,prefix,repo_path,project_types_json,description,requirements_path,concurrency_limit,devices_json,paseo_project_id,default_presets_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        id,
        "项目" + i,
        "P" + i,
        "<repo-" + i + ">",
        JSON.stringify(["web", "android"]),
        "简介" + i,
        "PRODUCT-REQUIREMENTS.md",
        i,
        JSON.stringify(["device"]),
        "native-" + i,
        defaults,
        timestamp,
        timestamp,
      );
      db.prepare(
        "INSERT INTO memory_entry (id,project_id,file,tag,tokens,created_at,touched_at) VALUES (?,?,?,'经验',?,?,?)",
      ).run("memory" + i, id, ".vibe/memory-" + i + ".md", 100 + i, timestamp, timestamp);
      db.prepare(
        "INSERT INTO work_counter (project_id,kind,count,since) VALUES (?,'tokens',?,?)",
      ).run(id, 1000 * i, timestamp);
    }
    for (let i = 1; i <= 3; i++) {
      db.prepare(
        "INSERT INTO card (id,project_id,number,key,title,sort_key,plan_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
      ).run(
        "c" + i,
        "p" + i,
        i,
        "P" + i + "-" + i,
        "旧卡" + i,
        String(i),
        JSON.stringify({ legacy: true }),
        timestamp,
        timestamp,
      );
      db.prepare(
        "INSERT INTO card_event (id,card_id,type,author_kind,body_json,created_at) VALUES (?,?,'note','user',?,?)",
      ).run("event" + i, "c" + i, JSON.stringify({ text: "旧消息" }), timestamp);
      db.prepare(
        "INSERT INTO usage_event (ts,provider,model,session_id,tokens_in,tokens_out,cost,card_id,dedupe_key) VALUES (?,'codex','primary',?,?,?,?,?,?)",
      ).run(timestamp, "session" + i, 100 * i, 30 * i, 0.2 * i, "c" + i, "usage" + i);
    }
    db.prepare(
      "INSERT INTO maintenance_rule (id,project_id,name,trigger_kind,trigger_json,check_json,daily_cap,created_at,updated_at) VALUES ('rule','p1','保留规则','workload',?,?,9,?,?)",
    ).run(JSON.stringify({ tokens: 500 }), JSON.stringify({ kind: "git" }), timestamp, timestamp);
    for (let i = 1; i <= 7; i++) {
      for (let run = 1; run <= i; run++) {
        db.prepare(
          "INSERT INTO maintenance_run (id,rule_id,project_id,triggered_at,status,findings_json,card_ids_json) VALUES (?,'rule',?,?,'done',?,?)",
        ).run(
          "run" + i + "-" + run,
          "p" + i,
          timestamp,
          JSON.stringify(["保留发现"]),
          JSON.stringify(i <= 3 ? ["c" + i] : []),
        );
      }
    }
    db.prepare(
      "INSERT INTO usage_cursor (file_path,byte_offset,size_bytes,mtime_ms,updated_at) VALUES ('<usage-log>',128,256,300,?)",
    ).run(timestamp);
    db.prepare("INSERT INTO resource_sample (ts,cpu,mem) VALUES (?,0.3,0.5)").run(timestamp);
    db.prepare(
      "INSERT INTO device_lease (id,device_id,card_id,acquired_at,released_at) VALUES ('lease','device','c1',?,?)",
    ).run(timestamp, timestamp);
  });
}

function snapshot(db: VibeDb) {
  const addedColumns: Record<string, string[]> = {
    usage_event: ["project_id", "workspace_id", "role", "agent_id"],
    device_lease: ["workspace_id"],
    maintenance_run: ["workspace_ids_json"],
  };
  return Object.fromEntries(
    retained.map((table) => [
      table,
      db
        .prepare("SELECT * FROM " + table + " ORDER BY rowid")
        .all()
        .map((row) =>
          Object.fromEntries(
            Object.entries(row).filter(([key]) => !addedColumns[table]?.includes(key)),
          ),
        ),
    ]),
  );
}
function maintenanceCounts(db: VibeDb) {
  return db
    .prepare(
      "SELECT rule_id,project_id,COUNT(*) AS count FROM maintenance_run GROUP BY rule_id,project_id ORDER BY project_id",
    )
    .all();
}
function backupFiles(path: string) {
  const dir = join(dirname(path), "backups");
  return existsSync(dir) ? readdirSync(dir).map((name) => join(dir, name)) : [];
}

describe("WP-110 task migration", () => {
  it("keeps all retained contents and rule × project counts, without importing seven projects' three cards", () => {
    const { db, path } = openTestDb();
    legacyFixture(db);
    const before = snapshot(db);
    const counts = maintenanceCounts(db);
    expect(before.project).toHaveLength(7);
    expect(db.prepare("SELECT COUNT(*) AS n FROM card").get()).toEqual({ n: 3 });
    expect(migrateOwner(db, "core")).toMatchObject({ from: 10, to: 12, applied: [11, 12] });
    expect(snapshot(db)).toEqual(before);
    expect(maintenanceCounts(db)).toEqual(counts);
    expect(db.prepare("SELECT COUNT(*) AS n FROM task").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM card").get()).toEqual({ n: 3 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM card_event").get()).toEqual({ n: 3 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const backups = backupFiles(path);
    expect(backups).toHaveLength(1);
    const backup = new DatabaseSync(backups[0]!, { readOnly: true });
    expect(backup.prepare("SELECT COUNT(*) AS n FROM project").get()).toEqual({ n: 7 });
    expect(backup.prepare("SELECT COUNT(*) AS n FROM card").get()).toEqual({ n: 3 });
    expect(
      backup.prepare("SELECT name FROM sqlite_master WHERE name = 'task'").get(),
    ).toBeUndefined();
    expect(backup.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    backup.close();
    db.close();
    const restarted = openVibeDb({ path });
    migrateAll(restarted);
    expect(migrateAll(restarted).every((r) => r.applied.length === 0)).toBe(true);
    expect(snapshot(restarted)).toEqual(before);
    expect(backupFiles(path)).toEqual(backups);
    restarted.close();
  });

  it("rolls back the new table and schema version when migration fails after DDL", () => {
    const { db, path } = openTestDb();
    legacyFixture(db);
    const before = snapshot(db);
    const failing: VibeDb = {
      ...db,
      prepare(sql) {
        if (sql.startsWith("INSERT INTO schema_version")) throw new Error("模拟版本写入失败");
        return db.prepare(sql);
      },
    };
    expect(() => migrateOwner(failing, "core")).toThrow("模拟版本写入失败");
    expect(getSchemaVersion(db, "core")).toBe(10);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='task'").get()).toBeUndefined();
    expect(snapshot(db)).toEqual(before);
    expect(backupFiles(path)).toHaveLength(1);
    db.close();
  });

  it("stops before changing the old schema when a consistent backup cannot be created", () => {
    const { db, path } = openTestDb();
    legacyFixture(db);
    const before = snapshot(db);
    writeFileSync(join(dirname(path), "backups"), "阻止目录创建");
    expect(() => migrateOwner(db, "core")).toThrow();
    expect(getSchemaVersion(db, "core")).toBe(10);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='task'").get()).toBeUndefined();
    expect(snapshot(db)).toEqual(before);
    db.close();
  });

  it("backs up committed WAL data read-only under the selected VIBE_HOME, with unique timestamped names", () => {
    const { db, path } = openTestDb();
    legacyFixture(db);
    const reader = new DatabaseSync(path, { readOnly: true });
    reader.exec("BEGIN");
    reader.prepare("SELECT COUNT(*) FROM vibe_meta").get();
    db.prepare("INSERT INTO vibe_meta VALUES ('committed-in-wal','保留WAL')").run();
    const before = snapshot(db);
    const options = { vibeHome: dirname(path), now: () => new Date(timestamp) };
    const first = backupVibeDb(db, options);
    const second = backupVibeDb(db, options);
    expect(first).toContain(join(dirname(path), "backups"));
    expect(first).toContain("2026-10-23T12-00-00.000Z");
    expect(first).not.toBe(second);
    const backup = new DatabaseSync(first, { readOnly: true });
    expect(
      backup.prepare("SELECT value FROM vibe_meta WHERE key='committed-in-wal'").get(),
    ).toEqual({ value: "保留WAL" });
    expect(backup.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    backup.close();
    expect(snapshot(db)).toEqual(before);
    reader.exec("ROLLBACK");
    reader.close();
    db.close();
  });

  it("creates a fresh empty task table without making a needless backup", () => {
    const { db, path } = openTestDb();
    migrateAll(db);
    expect(db.prepare("SELECT COUNT(*) AS n FROM task").get()).toEqual({ n: 0 });
    expect(backupFiles(path)).toEqual([]);
    db.close();
  });
});

describe("WP-112 retained runtime migration", () => {
  it("preserves old verification evidence and foreign keys while adding workspace evidence", () => {
    const { db } = openTestDb();
    legacyFixture(db);
    db.exec(
      "INSERT INTO verification(id,card_id,commit_hash,mode,started_at) VALUES ('v','c1','commit','evidence','now'); INSERT INTO verification_item(id,verification_id,check_text) VALUES ('i','v','验证'); INSERT INTO evidence_file(id,verification_id,item_id,kind,path,sha256,captured_at,commit_hash) VALUES ('e','v','i','log','<evidence>','hash','now','commit')",
    );
    const evidence = db.prepare("SELECT * FROM evidence_file").all();
    const items = db.prepare("SELECT * FROM verification_item").all();
    migrateAll(db);
    expect(db.prepare("SELECT * FROM evidence_file").all()).toEqual(evidence);
    expect(db.prepare("SELECT * FROM verification_item").all()).toEqual(items);
    expect(db.prepare("SELECT id,card_id,project_id FROM verification").get()).toEqual({
      id: "v",
      card_id: "c1",
      project_id: "p1",
    });
    expect(db.prepare("SELECT project_id FROM usage_event ORDER BY id").all()).toEqual([
      { project_id: "p1" },
      { project_id: "p2" },
      { project_id: "p3" },
    ]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("PRAGMA foreign_key_list(verification_item)").all()).toContainEqual(
      expect.objectContaining({
        table: "verification",
        from: "verification_id",
        to: "id",
        on_delete: "CASCADE",
      }),
    );
    expect(() =>
      db
        .prepare(
          "INSERT INTO evidence_file(id,verification_id,kind,path,sha256,captured_at,commit_hash) VALUES ('bad','missing','log','x','x','x','x')",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
    db.exec(
      "INSERT INTO task(workspace_id,anchor_agent_id) VALUES ('w','a'); INSERT INTO verification(id,workspace_id,confirmed_at,project_id,commit_hash,mode,started_at) VALUES ('tv','w','confirmed','p1','commit','evidence','now')",
    );
    expect(db.prepare("SELECT card_id FROM verification WHERE id='tv'").get()).toEqual({
      card_id: null,
    });
    db.prepare("DELETE FROM verification WHERE id='v'").run();
    expect(db.prepare("SELECT * FROM verification_item").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM evidence_file").all()).toEqual([]);
    db.close();
  });
  it("registers all task roles and atomically deduplicates continuations with actual model attribution", () => {
    const { db } = openTestDb();
    migrateAll(db);
    const runtime = createTaskRuntimeCommands(db);
    const old = runtime.registerSession({
      workspaceId: "w",
      projectId: "p",
      agentId: "a",
      role: "plan_reviewer",
      provider: "codex",
      model: "first",
      candidateIndex: 0,
      confirmedAt: "confirmed",
    });
    expect(
      runtime.registerSession({
        workspaceId: "w",
        agentId: "a",
        role: "plan_reviewer",
        provider: "codex",
        model: "first",
        candidateIndex: 0,
      }).id,
    ).toBe(old.id);
    const input = {
      fromSessionId: old.id,
      agentId: "b",
      provider: "claude",
      model: "next",
      thinking: "high",
      candidateIndex: 1,
      reason: "继续",
    };
    const next = runtime.recordContinuation(input);
    expect(next.from.state).toBe("ended");
    expect(next.to).toMatchObject({
      workspaceId: "w",
      projectId: "p",
      previousSessionId: old.id,
      confirmedAt: "confirmed",
    });
    expect(runtime.recordContinuation(input).to.id).toBe(next.to.id);
    expect(runtime.getContinuation(old.id)?.id).toBe(next.to.id);
    expect(() => runtime.recordContinuation({ ...input, agentId: "duplicate" })).toThrow(
      "请停止重复创建",
    );
    expect(runtime.findSessionByAgent("duplicate")).toBeUndefined();
    expect(runtime.getSelection(next.to.id)).toEqual({
      candidateIndex: 1,
      actualModel: { provider: "claude", model: "next", thinking: "high" },
    });
    for (const role of ["scout", "reviewer"] as const)
      expect(
        runtime.registerSession({
          workspaceId: "w",
          agentId: role,
          role,
          provider: "codex",
          model: "m",
          candidateIndex: 0,
        }).role,
      ).toBe(role);
    expect(runtime.listSessions({ workspaceId: "w" })).toHaveLength(4);
    db.close();
  });
});
