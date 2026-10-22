// WP-108: default models per job (card -> project -> global), new-card prefill and migration 9.

import { describe, expect, it } from "vitest";
import { cleanDefaults, prefillModels, resolveModel } from "../contract/model-roles";
import { MIGRATIONS, migrateAll } from "../db";
import { openTestDb, setup } from "./helpers";

describe("resolveModel: card -> project -> global", () => {
  const project = { defaultPresets: { planner: "p-plan", verifier: "p-ver", reviewer: "p-rev" } };
  const global = { planner: "g-plan", worker: "g-work", verifier: "g-ver", scout: "g-scout" };

  it("the card's pick wins, then the project, then the global default", () => {
    expect(resolveModel("planner", { plannerPresetId: "own" }, project, global)).toEqual({ presetId: "own", source: "card" });
    expect(resolveModel("planner", { plannerPresetId: null }, project, global)).toEqual({ presetId: "p-plan", source: "project" });
    expect(resolveModel("worker", { presetId: null }, project, global)).toEqual({ presetId: "g-work", source: "global" });
    expect(resolveModel("subagent", { subagentPresetId: null }, project, global)).toEqual({ presetId: null, source: null });
  });

  it("deleted presets are skipped", () => {
    const exists = (id: string) => id !== "own" && id !== "p-ver";
    expect(resolveModel("verifier", { verifierPresetId: "own" }, project, global, exists).presetId).toBe("g-ver");
  });

  it("an empty scout / reviewer pick on a card means skip; a new card still gets the defaults", () => {
    expect(resolveModel("reviewer", { reviewerPresetId: null }, project, global).presetId).toBeNull();
    expect(resolveModel("scout", { scoutPresetId: null }, project, global).presetId).toBeNull();
    expect(resolveModel("reviewer", null, project, global).presetId).toBe("p-rev");
    expect(resolveModel("scout", null, project, global).presetId).toBe("g-scout");
  });

  it("prefill fills only the jobs the caller left open", () => {
    expect(prefillModels({ plannerPresetId: null, presetId: "mine" }, project, global)).toEqual({
      scoutPresetId: "g-scout",
      reviewerPresetId: "p-rev",
      verifierPresetId: "p-ver",
    });
  });

  it("cleanDefaults drops unknown jobs and blank ids", () => {
    expect(cleanDefaults({ planner: " x ", worker: "", bogus: "y" })).toEqual({ planner: "x" });
    expect(cleanDefaults("nope")).toEqual({});
  });
});

describe("default models in the store", () => {
  it("new cards are prefilled project -> global; explicit values (also null) are kept", () => {
    const s = setup();
    const a = s.store.presets.create({ name: "A", provider: "claude", model: "m" });
    const b = s.store.presets.create({ name: "B", provider: "codex", model: "m" });
    s.store.modelDefaults.setGlobal({ planner: a.id, verifier: a.id, worker: a.id });
    const p = s.store.projects.create({ name: "n", prefix: "MR", repoPath: "r", defaultPresets: { verifier: b.id } });
    const card = s.store.cards.create({ projectId: p.id, title: "t", presetId: null });
    expect(card.plannerPresetId).toBe(a.id);
    expect(card.verifierPresetId).toBe(b.id);
    expect(card.presetId).toBeNull();
    expect(card.reviewerPresetId).toBeNull();
    expect(() => s.store.modelDefaults.setGlobal({ planner: "missing" })).toThrow(/Preset not found/);
    const updated = s.store.projects.update(p.id, { defaultPresets: { worker: a.id } });
    expect(updated.defaultPresets).toEqual({ worker: a.id });
  });

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
    expect(db.prepare("SELECT id, default_presets_json AS d FROM project ORDER BY id").all()).toEqual([
      { id: "pr1", d: '{"worker":"s1"}' },
      { id: "pr2", d: "{}" },
    ]);
    const columns = db.prepare<{ name: string }>("PRAGMA table_info(project)").all().map((c) => c.name);
    expect(columns).not.toContain("default_preset_id");
    expect(db.prepare("SELECT COUNT(*) AS n FROM sync_meta WHERE column_name = 'default_preset_id'").get()).toEqual({ n: 0 });
    db.close();
  });
});
