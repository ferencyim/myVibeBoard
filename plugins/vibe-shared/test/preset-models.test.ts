import { describe, expect, it } from "vitest";
import { PresetModelSchema, PresetModelInputSchema, presetModeId, presetModels, withPresetModel, isModelUnavailableError } from "../contract";
import { MIGRATIONS, createVibeStore, migrateOwner } from "../db";
import { openTestDb, setup } from "./helpers";

const first = { provider: "claude", model: "opus", thinking: "high", permissionMode: "auto" as const };
const second = { provider: "codex", model: "gpt", thinking: "medium", permissionMode: "accept-edits" as const };

describe("ordered models in a preset", () => {
  it("converts fallback chains supplied by older clients to candidates", () => {
    const { store, db } = setup();
    const fallback = store.presets.create({ name: "fallback", ...second });
    const preset = store.presets.create({ name: "work", ...first, fallbackPresetIds: [fallback.id] });
    expect(preset.models).toEqual([first, second]);
    expect(store.presets.update(preset.id, { model: "sonnet" }).models).toEqual([{ ...first, model: "sonnet" }, second]);
    expect(store.presets.update(preset.id, { fallbackPresetIds: null }).models).toEqual([{ ...first, model: "sonnet" }]);
    db.close();
  });
  it.each(["quota exceeded", "rate limit", "401 Unauthorized", "403 Forbidden", "login expired", "provider not installed", "model not found", "spawn ENOENT"])("recognizes unavailable candidates: %s", (message) => {
    expect(isModelUnavailableError(message)).toBe(true);
    expect(isModelUnavailableError(new Error(message))).toBe(true);
  });

  it.each(["Tests failed", "User canceled", "Waiting for permission", "Task rejected", ""])("keeps ordinary failures on the selected model: %s", (message) => {
    expect(isModelUnavailableError(message)).toBe(false);
  });
  it("mirrors the first candidate and preserves later candidates when an older client edits it", () => {
    const { store, db } = setup();
    const preset = store.presets.create({ name: "work", ...second, models: [first, second] });
    expect(preset).toMatchObject({ ...first, models: [first, second] });
    expect(store.presets.update(preset.id, { model: "sonnet" })).toMatchObject({
      model: "sonnet", models: [{ ...first, model: "sonnet" }, second],
    });
    expect(store.presets.update(preset.id, { models: [second, first] })).toMatchObject({
      ...second, models: [second, first],
    });
    expect(store.presets.update(preset.id, { name: "renamed" }).models).toEqual([second, first]);
    expect(() => store.presets.update(preset.id, { models: [] })).toThrow();
    db.close();
  });

  it("retains preset identity and settings while applying a candidate, and supports old snapshots", () => {
    const { store, db } = setup();
    const preset = store.presets.create({ name: "work", ...first, instructions: "project rules" });
    const { models: _models, ...legacy } = preset;
    expect(presetModels(legacy)).toEqual([first]);
    expect(withPresetModel(preset, second)).toEqual({ ...preset, ...second });
    expect(PresetModelSchema.safeParse({ ...first, provider: " " }).success).toBe(false);
    expect(PresetModelInputSchema.safeParse({ ...first, model: " " }).success).toBe(false);
    db.close();
  });

  it("migrates legacy chains in order, deduplicating models and ignoring loops and missing presets", () => {
    const { db } = openTestDb();
    db.exec("CREATE TABLE schema_version (owner TEXT, version INTEGER, applied_at TEXT, PRIMARY KEY(owner, version))");
    for (const migration of MIGRATIONS.core.filter((entry) => entry.version < 10)) {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_version VALUES ('core', ?, 'old')").run(migration.version);
    }
    const insert = db.prepare(`INSERT INTO preset
      (id, name, provider, model, thinking, permission_mode, fallback_preset_ids_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`);
    insert.run("a", "a", first.provider, first.model, first.thinking, first.permissionMode, '["b","c","missing"]');
    insert.run("b", "b", second.provider, second.model, second.thinking, second.permissionMode, '["a"]');
    insert.run("c", "c", second.provider, second.model, second.thinking, second.permissionMode, null);
    insert.run("legacy", "legacy", first.provider, "", first.thinking, first.permissionMode, null);
    migrateOwner(db, "core");
    const store = createVibeStore(db);
    expect(store.presets.get("a")?.models).toEqual([first, second]);
    expect(store.presets.get("b")?.models).toEqual([second, first]);
    expect(store.presets.get("a")?.fallbackPresetIds).toEqual(["b", "c", "missing"]);
    expect(store.presets.get("legacy")?.models).toEqual([{ ...first, model: "" }]);
    expect(store.presets.list().find((preset) => preset.id === "legacy")?.model).toBe("");
    expect(() => store.presets.update("legacy", { models: [{ ...first, model: "" }] })).toThrow();
    expect(migrateOwner(db, "core").applied).toEqual([]);
    db.close();
  });
});

describe("permission tiers to native modes", () => {
  it("maps the auto tier to Claude's auto mode and Codex's auto-reviewer", () => {
    expect(presetModeId("claude", "auto")).toBe("auto");
    expect(presetModeId("codex", "auto")).toBe("auto-review");
    expect(presetModeId("codex", "full")).toBe("full-access");
    expect(presetModeId("opencode", "auto")).toBeUndefined();
  });
});
