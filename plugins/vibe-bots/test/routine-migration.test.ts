import { describe, expect, it } from "vitest";
import { getSchemaVersion, latestVersion, migrateOwner, migrateOwnerThrough } from "../server/vibe/db/migrate";
import { BOT_MIGRATIONS } from "../server/vibe/db/migrations/bots";
import { openVibeDb } from "../server/vibe/db/sqlite";

describe("vibe-bots 例程迁移", () => {
  it("从 v1 一次迁移到 v3，按顺序执行 v2 和 v3 并保留数据", () => {
    const db = openVibeDb({ path: ":memory:" });
    try {
      db.exec("CREATE TABLE schema_version(owner TEXT NOT NULL, version INTEGER NOT NULL, applied_at TEXT NOT NULL, PRIMARY KEY(owner,version))");
      db.prepare("INSERT INTO schema_version VALUES ('core', ?, 'old')").run(latestVersion("core"));
      db.exec(BOT_MIGRATIONS[0]!.sql);
      db.exec("INSERT INTO schema_version VALUES ('vibe-bots', 1, 'old')");
      db.exec("INSERT INTO bot(id,kind,name,created_at,updated_at) VALUES ('bot_old','independent','旧助手','old','old')");
      db.exec("INSERT INTO bot_memory(id,bot_id,text,source,created_at,updated_at) VALUES ('memory_old','bot_old','保留记忆','user','old','old')");
      expect(migrateOwner(db, "vibe-bots")).toMatchObject({ from: 1, to: 4, applied: [2, 3, 4] });
      expect(db.prepare("SELECT name FROM bot WHERE id='bot_old'").get()).toEqual({ name: "旧助手" });
      expect(db.prepare("SELECT text FROM bot_memory WHERE id='memory_old'").get()).toEqual({ text: "保留记忆" });
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('bot_thread','bot_routine','bot_routine_run') ORDER BY name").all())
        .toEqual([{ name: "bot_routine" }, { name: "bot_routine_run" }, { name: "bot_thread" }]);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(migrateOwner(db, "vibe-bots").applied).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("既有 v2 升级 v3 时保留 bot、记忆和旁线程", () => {
    const db = openVibeDb({ path: ":memory:" });
    try {
      // Set up the released v1 schema directly. Core's current version is recorded so its
      // historical cutover does not migrate all owners before this staged upgrade is exercised.
      db.exec("CREATE TABLE schema_version(owner TEXT NOT NULL, version INTEGER NOT NULL, applied_at TEXT NOT NULL, PRIMARY KEY(owner,version))");
      db.prepare("INSERT INTO schema_version VALUES ('core', ?, 'old')").run(latestVersion("core"));
      db.exec(BOT_MIGRATIONS[0]!.sql);
      db.exec("INSERT INTO schema_version VALUES ('vibe-bots', 1, 'old')");
      db.exec("INSERT INTO bot(id,kind,name,created_at,updated_at) VALUES ('bot_old','independent','旧助手','old','old')");
      db.exec("INSERT INTO bot_memory(id,bot_id,text,source,created_at,updated_at) VALUES ('memory_old','bot_old','保留记忆','user','old','old')");

      expect(migrateOwnerThrough(db, "vibe-bots", 2)).toMatchObject({ from: 1, to: 2, applied: [2] });
      db.exec("INSERT INTO bot_thread(id,bot_id,title,agent_id,created_at) VALUES ('thread_old','bot_old','旧话题','agent_old','old')");
      expect(migrateOwner(db, "vibe-bots")).toMatchObject({ from: 2, to: 4, applied: [3, 4] });
      expect(getSchemaVersion(db, "vibe-bots")).toBe(4);
      expect(db.prepare("SELECT name FROM bot WHERE id='bot_old'").get()).toEqual({ name: "旧助手" });
      expect(db.prepare("SELECT text FROM bot_memory WHERE id='memory_old'").get()).toEqual({ text: "保留记忆" });
      expect(db.prepare("SELECT title,agent_id FROM bot_thread WHERE id='thread_old'").get()).toEqual({ title: "旧话题", agent_id: "agent_old" });
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('bot_routine','bot_routine_run') ORDER BY name").all())
        .toEqual([{ name: "bot_routine" }, { name: "bot_routine_run" }]);
      db.exec(`INSERT INTO bot_routine(id,bot_id,title,schedule_json,timezone,prompt,target,quiet,paused,missed_policy,created_at,updated_at)
        VALUES ('routine_old','bot_old','定时检查','{"kind":"interval","minutes":60}','UTC','检查','main',0,0,'skip','old','old')`);
      db.exec("INSERT INTO bot_routine_run(id,routine_id,scheduled_at,status) VALUES ('run_old','routine_old','old','queued')");
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(migrateOwner(db, "vibe-bots").applied).toEqual([]);
      expect(db.prepare("SELECT routine_id,status FROM bot_routine_run WHERE id='run_old'").get()).toEqual({ routine_id: "routine_old", status: "queued" });
    } finally {
      db.close();
    }
  });
});
