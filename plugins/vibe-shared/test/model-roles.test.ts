// WP-108: default models per job (card -> project -> global), new-card prefill and migration 9.

import { describe, expect, it } from "vitest";
import { MIGRATIONS, migrateAll } from "../db";
import { openTestDb } from "./helpers";

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
