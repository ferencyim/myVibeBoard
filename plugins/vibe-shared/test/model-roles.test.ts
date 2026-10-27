// WP-108: default models per job (card -> project -> global), new-card prefill and migration 9.

import { describe, expect, it } from "vitest";
import {
  cleanDefaults,
  plannerList,
  resolvePlannerIds,
  resolveTaskRoles,
} from "../contract/model-roles";
import { MIGRATIONS, migrateAll } from "../db";
import { openTestDb, setup } from "./helpers";

describe("default models in the store", () => {
  it("migration 9 moves project.default_preset_id to defaultPresets.worker and drops the column", () => {
    const { db } = openTestDb();
    db.exec(
      "CREATE TABLE schema_version (owner TEXT NOT NULL, version INTEGER NOT NULL, applied_at TEXT NOT NULL, PRIMARY KEY (owner, version))",
    );
    for (const m of MIGRATIONS.core.slice(0, 8)) {
      if (m.foreignKeysOff) db.exec("PRAGMA foreign_keys = OFF");
      db.exec(m.sql);
      if (m.foreignKeysOff) db.exec("PRAGMA foreign_keys = ON");
      db.prepare("INSERT INTO schema_version VALUES ('core', ?, 'x')").run(m.version);
    }
    db.exec(`
      INSERT INTO preset (id, name, provider, model, created_at, updated_at) VALUES ('s1','P','claude','m','t','t');
      INSERT INTO project (id, name, prefix, repo_path, project_type, default_preset_id, created_at, updated_at)
        VALUES ('pr1','A','AA','/r','web','s1','t','t'), ('pr2','B','BB','/r','web',NULL,'t','t');
      INSERT INTO sync_meta (table_name, row_id, column_name, hlc, device_id) VALUES ('project','pr1','default_preset_id','h','d');
    `);
    migrateAll(db);
    expect(
      db.prepare("SELECT id, default_presets_json AS d FROM project ORDER BY id").all(),
    ).toEqual([
      { id: "pr1", d: '{"worker":"s1"}' },
      { id: "pr2", d: "{}" },
    ]);
    const columns = db
      .prepare<{ name: string }>("PRAGMA table_info(project)")
      .all()
      .map((c) => c.name);
    expect(columns).not.toContain("default_preset_id");
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='sync_meta'").get(),
    ).toBeUndefined();
    db.close();
  });
});

describe("round 8: #2 方案 model list (WP-130)", () => {
  it("cleanDefaults turns the legacy planner + plan reviewer into the list; planners wins", () => {
    expect(cleanDefaults({ planner: "a", plan_reviewer: "b", worker: "w" })).toEqual({
      worker: "w",
      planners: ["a", "b"],
    });
    expect(cleanDefaults({ planner: "a", plan_reviewer: null })).toEqual({ planners: ["a"] });
    // A level that only set the reviewer cannot be expressed as a list; it inherits.
    expect(cleanDefaults({ plan_reviewer: "b" })).toEqual({});
    expect(cleanDefaults({ planners: ["x", " ", "y"], planner: "legacy" })).toEqual({
      planners: ["x", "y"],
    });
    expect(cleanDefaults({ planners: [] })).toEqual({});
    expect(plannerList({ planners: ["x", "x"] })).toEqual(["x", "x"]);
  });

  it("resolves the list: task writer pin, project list over global as a whole, review disable", () => {
    const global = { planners: ["g1", "g2", "g3"] };
    expect(resolvePlannerIds({}, undefined, global)).toEqual({
      ids: ["g1", "g2", "g3"],
      source: "global",
    });
    expect(resolvePlannerIds({}, { planners: ["p1"] }, global)).toEqual({
      ids: ["p1"],
      source: "project",
    });
    expect(
      resolvePlannerIds({ planner: { mode: "preset", presetId: "t" } }, undefined, global),
    ).toEqual({ ids: ["t", "g2", "g3"], source: "task" });
    expect(resolvePlannerIds({ plan_reviewer: { mode: "disabled" } }, undefined, global).ids).toEqual(
      ["g1"],
    );
    expect(resolvePlannerIds({}, undefined, {}).ids).toEqual([]);
  });

  it("the role snapshot keeps planner = first and plan_reviewer = second (or disabled)", () => {
    const { store, db } = setup();
    try {
      const a = store.presets.create({ name: "A", provider: "codex", model: "a" });
      const b = store.presets.create({ name: "B", provider: "claude", model: "b" });
      const base = { worker: a.id, verifier: a.id };
      const two = resolveTaskRoles({}, undefined, { ...base, planners: [a.id, b.id] }, store.presets.get);
      expect(two.planner.presetId).toBe(a.id);
      expect(two.plan_reviewer?.presetId).toBe(b.id);
      const one = resolveTaskRoles({}, { planners: [b.id] }, { ...base, planners: [a.id, b.id] }, store.presets.get);
      expect(one.planner.presetId).toBe(b.id);
      expect(one.planner.source).toBe("project");
      expect(one.plan_reviewer).toBeNull();
    } finally {
      db.close();
    }
  });

  it("migration 19 converts project and global defaults; deleting a preset drops it from the list", () => {
    const { db } = openTestDb();
    migrateAll(db);
    // Rows written before round 8 still carry the legacy keys; rerun migration 19 over them.
    db.exec(`
      INSERT INTO project (id, name, prefix, repo_path, project_type, default_presets_json, created_at, updated_at) VALUES
        ('both','A','AA','/r','web','{"planner":"p","plan_reviewer":"r","worker":"w"}','t','t'),
        ('off','B','BB','/r','web','{"planner":"p","plan_reviewer":null}','t','t'),
        ('only-review','C','CC','/r','web','{"plan_reviewer":"r","scout":null}','t','t'),
        ('none','D','DD','/r','web','{"worker":"w"}','t','t'),
        ('inherit-off','E','EE','/r','web','{"plan_reviewer":null,"worker":"w"}','t','t');
      INSERT INTO vibe_meta (key, value) VALUES ('models.defaults', '{"planner":"g","plan_reviewer":"h","verifier":"v"}');
    `);
    db.exec(MIGRATIONS.core.find((m) => m.version === 19)!.sql);
    const rows = db
      .prepare<{ id: string; d: string }>("SELECT id, default_presets_json AS d FROM project ORDER BY id")
      .all()
      .map((row) => [row.id, JSON.parse(row.d)]);
    expect(Object.fromEntries(rows)).toEqual({
      both: { worker: "w", planners: ["p", "r"] },
      off: { planners: ["p"] },
      "only-review": { scout: null },
      none: { worker: "w" },
      // Review was off while the planner was inherited: still off, with the global planner.
      "inherit-off": { worker: "w", planners: ["g"] },
    });
    expect(
      JSON.parse(
        db.prepare<{ value: string }>("SELECT value FROM vibe_meta WHERE key = 'models.defaults'").get()!.value,
      ),
    ).toEqual({ verifier: "v", planners: ["g", "h"] });
    expect(db.prepare("SELECT updated_at FROM task LIMIT 0").all()).toEqual([]);
    // Without a global planner there is nothing to pin; the legacy keys are only removed.
    db.exec(`
      DELETE FROM vibe_meta WHERE key = 'models.defaults';
      INSERT INTO project (id, name, prefix, repo_path, project_type, default_presets_json, created_at, updated_at) VALUES
        ('no-global','F','FF','/r','web','{"plan_reviewer":null}','t','t');
    `);
    db.exec(MIGRATIONS.core.find((m) => m.version === 19)!.sql);
    expect(
      JSON.parse(
        db.prepare<{ d: string }>("SELECT default_presets_json AS d FROM project WHERE id = 'no-global'").get()!.d,
      ),
    ).toEqual({});
    db.close();

    const s = setup();
    try {
      const a = s.store.presets.create({ name: "A", provider: "codex", model: "a" });
      const b = s.store.presets.create({ name: "B", provider: "codex", model: "b" });
      s.store.modelDefaults.setGlobal({ planners: [a.id, b.id], worker: b.id });
      s.store.projects.create({
        name: "P",
        prefix: "PP",
        repoPath: "r",
        defaultPresets: { planners: [b.id] },
      });
      expect(() => s.store.modelDefaults.setGlobal({ planners: ["missing"] })).toThrow(
        /Preset not found/,
      );
      s.store.presets.delete(b.id);
      expect(s.store.modelDefaults.global()).toEqual({ planners: [a.id] });
      expect(s.store.projects.list()[0]?.defaultPresets).toEqual({});
    } finally {
      s.db.close();
    }
  });
});
