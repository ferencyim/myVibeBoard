import { describe, expect, it } from "vitest";
import { getSchemaVersion, migrateOwner, migrateOwnerThrough, type VibeDb } from "../db";
import { openTestDb } from "./helpers";

const STAMP = "2026-01-01T00:00:00.000Z";

/** A db at core version 20: the last schema before role settings. */
function coreAtV20(db: VibeDb) {
  migrateOwnerThrough(db, "core", 20);
}

function seed(db: VibeDb) {
  const models = JSON.stringify([
    { provider: "codex", model: "primary", thinking: "high", permissionMode: "auto" },
    { provider: "claude", model: "fallback", thinking: "", permissionMode: "accept-edits" },
  ]);
  db.prepare(
    `INSERT INTO preset (id,name,provider,model,thinking,permission_mode,environment_kind,base_branch,runtime_env,
       instructions,builtin,created_at,updated_at,updated_hlc,fallback_preset_ids_json,role_hints_json,models_json)
     VALUES ('p1','Worker','codex','primary','high','auto','new-worktree','main','android-emulator',
       '先读文档',1,?,?,'h1','["p2"]','["worker"]',?)`,
  ).run(STAMP, STAMP, models);
  db.prepare(
    `INSERT INTO preset (id,name,provider,model,created_at,updated_at) VALUES ('p2','Plain','claude','opus',?,?)`,
  ).run(STAMP, STAMP);
  db.prepare(
    `INSERT INTO project (id,name,prefix,repo_path,default_presets_json,created_at,updated_at)
     VALUES ('proj','Proj','PRJ','/r',?,?,?)`,
  ).run(JSON.stringify({ worker: "p1", scout: "gone", planners: ["p2", "missing"] }), STAMP, STAMP);
  db.prepare("INSERT INTO vibe_meta VALUES ('models.defaults', ?)").run(
    JSON.stringify({ main: "p2", reviewer: "also-gone", planners: ["p1"] }),
  );
}

describe("core migration 21: role settings", () => {
  it("moves every preset field over unchanged and cleans dangling references with a log", () => {
    const { db } = openTestDb();
    coreAtV20(db);
    seed(db);
    expect(migrateOwner(db, "core")).toMatchObject({ from: 20, to: 21, applied: [21] });

    const copied = db.prepare("SELECT * FROM role_setting WHERE id = 'p1'").get() as Record<string, unknown>;
    const original = db.prepare("SELECT * FROM preset WHERE id = 'p1'").get() as Record<string, unknown>;
    for (const [column, value] of Object.entries(original)) expect(copied[column], column).toEqual(value);
    expect(copied).toMatchObject({ fast_mode: 0, owner_scope: null, owner_role: null });
    expect(db.prepare("SELECT COUNT(*) AS n FROM role_setting").get()).toEqual({ n: 2 });

    const project = db.prepare("SELECT default_presets_json AS j FROM project").get() as { j: string };
    expect(JSON.parse(project.j)).toEqual({ worker: "p1", planners: ["p2"] });
    const meta = db.prepare("SELECT value FROM vibe_meta WHERE key='models.defaults'").get() as { value: string };
    expect(JSON.parse(meta.value)).toEqual({ main: "p2", planners: ["p1"] });
    const notes = db
      .prepare("SELECT kind, detail FROM role_setting_migration_note ORDER BY kind")
      .all();
    expect(notes).toEqual([
      { kind: "global.default.reviewer", detail: "also-gone" },
      { kind: "project.default.planners", detail: "missing" },
      { kind: "project.default.scout", detail: "gone" },
    ]);
  });

  it("is idempotent and leaves the preset table unread", () => {
    const { db } = openTestDb();
    coreAtV20(db);
    seed(db);
    migrateOwner(db, "core");
    const settings = db.prepare("SELECT * FROM role_setting ORDER BY id").all();
    const presets = db.prepare("SELECT * FROM preset ORDER BY id").all();
    expect(migrateOwner(db, "core").applied).toEqual([]);
    expect(getSchemaVersion(db, "core")).toBe(21);
    expect(db.prepare("SELECT * FROM role_setting ORDER BY id").all()).toEqual(settings);
    expect(db.prepare("SELECT * FROM preset ORDER BY id").all()).toEqual(presets);
  });
});

describe("core migration 21: bot preset expansion", () => {
  it("copies the setting's model chain into the bot and drops missing settings", () => {
    const { db } = openTestDb();
    coreAtV20(db);
    seed(db);
    const insert = db.prepare(
      "INSERT INTO bot (id,kind,name,preset_id,created_at,updated_at) VALUES (?,'independent',?,?,?,?)",
    );
    insert.run("bot_a", "A", "p1", STAMP, STAMP);
    insert.run("bot_b", "B", "gone", STAMP, STAMP);
    migrateOwner(db, "core");
    const a = db.prepare("SELECT * FROM bot WHERE id='bot_a'").get() as Record<string, unknown>;
    expect(a).toMatchObject({
      preset_id: "p1",
      provider: "codex",
      model: "primary",
      thinking: "high",
      permission_mode: "auto",
    });
    expect(JSON.parse(String(a.backup_models_json))).toEqual([
      { provider: "claude", model: "fallback", thinking: "", permissionMode: "accept-edits" },
    ]);
    expect(db.prepare("SELECT preset_id, provider FROM bot WHERE id='bot_b'").get()).toEqual({
      preset_id: null,
      provider: null,
    });
    expect(
      db.prepare("SELECT kind, detail FROM role_setting_migration_note WHERE kind='bot.preset_id'").all(),
    ).toEqual([{ kind: "bot.preset_id", detail: "gone" }]);
  });
});
