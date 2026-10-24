import { MIGRATIONS, OWNERS, getSchemaVersion, type VibeDb } from "../db";

export const retained = [
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
export const timestamp = "2026-10-23T12:00:00.000Z";

/** Latest fourth-round schema, without running the new task migration. */
export function legacyFixture(db: VibeDb): void {
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
    db.prepare(
      "INSERT INTO git_snapshot(project_id,branch,ahead,behind,dirty_files,diff_stat,taken_at) VALUES ('p1','legacy-branch',2,1,3,'旧看板缓存',?)",
    ).run(timestamp);
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

export function snapshot(db: VibeDb) {
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
export function maintenanceCounts(db: VibeDb) {
  return db
    .prepare(
      "SELECT rule_id,project_id,COUNT(*) AS count FROM maintenance_run GROUP BY rule_id,project_id ORDER BY project_id",
    )
    .all();
}

export function preCutoverSchema(db: VibeDb) {
  for (const owner of OWNERS) {
    const limit = { core: 13, verify: 3 }[owner as "core" | "verify"] ?? Infinity;
    for (const migration of MIGRATIONS[owner]) {
      if (migration.version > limit || migration.version <= getSchemaVersion(db, owner)) continue;
      if (migration.foreignKeysOff) db.exec("PRAGMA foreign_keys = OFF");
      db.immediate(() => {
        db.exec(migration.sql);
        db.prepare("INSERT INTO schema_version VALUES (?,?,?)").run(
          owner,
          migration.version,
          timestamp,
        );
      });
      if (migration.foreignKeysOff) db.exec("PRAGMA foreign_keys = ON");
    }
  }
}
