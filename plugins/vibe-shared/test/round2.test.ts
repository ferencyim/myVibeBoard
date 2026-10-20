import { describe, expect, it } from "vitest";
import { EVENT_PAYLOADS } from "../contract/events";
import { PlanSnapshotSchema } from "../contract/model";
import { CommandError, MIGRATIONS, migrateAll, readEvents } from "../db";
import { openTestDb, setup } from "./helpers";

function seed() {
  const s = setup();
  const p = s.store.projects.create({
    name: "Demo",
    prefix: "DEMO",
    repoPath: "<repo>",
    projectType: "web",
  });
  const card = s.store.cards.create({ projectId: p.id, title: "t", column: "todo" });
  const { session } = s.store.cards.dispatch({
    cardId: card.id,
    agentId: "agent-1",
    provider: "claude",
    worktree: "<wt>",
  });
  s.store.sessions.setState(session.id, "working");
  return { s, p, card, session };
}
const types = (s: ReturnType<typeof setup>) =>
  readEvents(s.db, 0, { limit: 1000 }).map((e) => e.type);

describe("round 2 schema", () => {
  it("upgrades an existing pre-round-2 database without losing rows", () => {
    const { db } = openTestDb();
    const upTo = { core: 2, verify: 1 } as const;
    db.exec(
      "CREATE TABLE schema_version (owner TEXT NOT NULL, version INTEGER NOT NULL, applied_at TEXT NOT NULL, PRIMARY KEY (owner, version))",
    );
    for (const owner of ["core", "verify"] as const) {
      for (const m of MIGRATIONS[owner].slice(0, upTo[owner])) {
        db.exec(m.sql);
        db.prepare("INSERT INTO schema_version VALUES (?, ?, ?)").run(owner, m.version, "x");
      }
    }
    db.exec(
      "INSERT INTO preset (id, name, provider, model, created_at, updated_at) VALUES ('p1','n','claude','m','t','t')",
    );
    migrateAll(db);
    const row = db
      .prepare("SELECT fallback_preset_ids_json AS f, role_hint AS r FROM preset")
      .get();
    expect(row).toEqual({ f: null, r: null });
    expect(db.prepare("SELECT kind FROM verification").all()).toEqual([]);
    db.close();
  });

  it("card.reviewerPresetId round-trips and validates the preset", () => {
    const { s, card } = seed();
    expect(card.reviewerPresetId).toBeNull();
    const preset = s.store.presets.create({ name: "rev", provider: "claude", model: "opus" });
    expect(s.store.cards.setReviewer(card.id, preset.id).reviewerPresetId).toBe(preset.id);
    expect(() => s.store.cards.setReviewer(card.id, "nope")).toThrow(CommandError);
    expect(s.store.cards.setReviewer(card.id, null).reviewerPresetId).toBeNull();
    const meta = s.db
      .prepare(
        "SELECT 1 AS x FROM sync_meta WHERE table_name='card' AND row_id=? AND column_name='reviewer_preset_id'",
      )
      .get(card.id);
    expect(meta).toBeTruthy();
    expect(s.store.cards.update(card.id, { reviewerPresetId: preset.id }).reviewerPresetId).toBe(
      preset.id,
    );
  });

  it("preset fallback chain and role hint; deleting a preset scrubs references", () => {
    const { s, card } = seed();
    const a = s.store.presets.create({ name: "a", provider: "claude", model: "m" });
    const b = s.store.presets.create({
      name: "b",
      provider: "codex",
      model: "m",
      roleHint: "scout",
    });
    expect(a.fallbackPresetIds).toBeNull();
    expect(b.roleHint).toBe("scout");
    const upd = s.store.presets.update(a.id, { fallbackPresetIds: [b.id], roleHint: "worker" });
    expect(upd).toMatchObject({ fallbackPresetIds: [b.id], roleHint: "worker" });
    s.store.cards.setReviewer(card.id, b.id);
    s.store.presets.delete(b.id);
    expect(s.store.presets.get(a.id)?.fallbackPresetIds).toBeNull();
    expect(s.store.cards.get(card.id)?.reviewerPresetId).toBeNull();
    expect(s.store.presets.update(a.id, { fallbackPresetIds: null }).fallbackPresetIds).toBeNull();
  });

  it("plan snapshot carries optional files", () => {
    const { s, card } = seed();
    const base = {
      description: "d",
      checks: [],
      subCards: [],
      tags: [],
      recommendedPresetId: null,
    };
    expect(PlanSnapshotSchema.parse(base).files).toBeUndefined();
    const v = s.store.plans.save(card.id, { ...base, files: ["src/**", "README.md"] });
    expect(v.snapshot.files).toEqual(["src/**", "README.md"]);
  });

  it("stalled marker: mark, idempotent, cleared by activity, no state change", () => {
    const { s, card, session } = seed();
    s.tick(60_000);
    const stalled = s.store.sessions.markStalled(session.id, { idleMs: 60_000 });
    expect(stalled.stalledSince).toBe(new Date(s.clock.ms).toISOString());
    expect(stalled.state).toBe("working");
    s.tick();
    expect(s.store.sessions.markStalled(session.id).stalledSince).toBe(stalled.stalledSince);
    s.tick();
    const touched = s.store.sessions.touchActivity(session.id);
    expect(touched.stalledSince).toBeNull();
    expect(touched.lastActivityAt).toBe(new Date(s.clock.ms).toISOString());
    expect(types(s).filter((t) => /stalled/.test(t))).toEqual([
      "session.stalled",
      "session.unstalled",
    ]);
    // clearStalled is a no-op when not stalled, and does not move last_activity_at
    const before = s.store.sessions.get(session.id)!;
    expect(s.store.sessions.clearStalled(session.id).lastActivityAt).toBe(before.lastActivityAt);
    s.store.sessions.markStalled(session.id);
    expect(s.store.sessions.clearStalled(session.id).stalledSince).toBeNull();
    const kinds = s.store.events
      .list(card.id)
      .map((e) => (e.body as { kind?: string }).kind)
      .filter((k) => k?.includes("stalled"));
    expect(kinds).toEqual([
      "session_stalled",
      "session_unstalled",
      "session_stalled",
      "session_unstalled",
    ]);
  });

  it("only starting/working sessions can be stalled; ending clears the marker", () => {
    const { s, session } = seed();
    s.store.sessions.markStalled(session.id);
    expect(s.store.sessions.setState(session.id, "ended").stalledSince).toBeNull();
    expect(() => s.store.sessions.markStalled(session.id)).toThrow(CommandError);
    const w = seed();
    w.s.store.sessions.setState(w.session.id, "waiting");
    expect(() => w.s.store.sessions.markStalled(w.session.id)).toThrow(CommandError);
  });

  it("setComplexity emits only on change", () => {
    const { s, session } = seed();
    expect(s.store.sessions.setComplexity(session.id, "multi").complexity).toBe("multi");
    s.store.sessions.setComplexity(session.id, "multi");
    s.store.sessions.setComplexity(session.id, null);
    const ev = readEvents(s.db, 0, { limit: 100 }).filter(
      (e) => e.type === "session.complexity_changed",
    );
    expect(ev.map((e) => e.payload)).toMatchObject([
      { from: null, to: "multi" },
      { from: "multi", to: null },
    ]);
  });

  it("recordReassign ends the old session and starts the replacement atomically", () => {
    const { s, card, session } = seed();
    const preset = s.store.presets.create({ name: "bk", provider: "codex", model: "m" });
    s.store.sessions.setComplexity(session.id, "long");
    s.store.sessions.setState(session.id, "error", { message: "boom" });
    s.tick();
    const { from, to } = s.store.sessions.recordReassign({
      fromSessionId: session.id,
      agentId: "agent-2",
      provider: "codex",
      reason: "error",
      presetId: preset.id,
    });
    expect(from).toMatchObject({ state: "ended", stalledSince: null });
    expect(to).toMatchObject({
      cardId: card.id,
      agentId: "agent-2",
      role: "worker",
      state: "starting",
      complexity: "long",
      reassignedFromSessionId: session.id,
      currentProvider: "codex",
    });
    expect(s.store.cards.get(card.id)?.presetId).toBe(preset.id);
    const ev = readEvents(s.db, 0, { limit: 100 }).find((e) => e.type === "session.reassigned");
    expect(ev?.payload).toMatchObject({
      sessionId: to.id,
      fromSessionId: session.id,
      reason: "error",
    });
    expect(s.store.events.list(card.id).some((e) => e.type === "switch_agent")).toBe(true);
    // ended sessions cannot be reassigned again, and a failed attempt leaves nothing behind
    expect(() =>
      s.store.sessions.recordReassign({
        fromSessionId: session.id,
        agentId: "agent-3",
        provider: "x",
        reason: "r",
      }),
    ).toThrow(CommandError);
    expect(s.store.sessions.getByAgent("agent-3")).toBeUndefined();
    // duplicate agent id rolls the whole transaction back
    expect(() =>
      s.store.sessions.recordReassign({
        fromSessionId: to.id,
        agentId: "agent-1",
        provider: "x",
        reason: "r",
      }),
    ).toThrow(CommandError);
    expect(s.store.sessions.get(to.id)?.state).toBe("starting");
  });

  it("new event payloads validate", () => {
    expect(
      EVENT_PAYLOADS["review.finished"].parse({ verdict: "issues", issues: ["a"] }).issues,
    ).toEqual(["a"]);
    expect(EVENT_PAYLOADS["review.finished"].parse({ verdict: "pass" }).issues).toEqual([]);
    expect(() => EVENT_PAYLOADS["review.finished"].parse({ verdict: "bad" })).toThrow();
    expect(
      EVENT_PAYLOADS["scout.finished"].parse({ outcome: "ok", complexity: "short" }),
    ).toBeTruthy();
    expect(EVENT_PAYLOADS["review.started"].parse({})).toEqual({});
    expect(EVENT_PAYLOADS["scout.started"].parse({})).toEqual({});
  });

  it("verification rows default kind to check", () => {
    const { s, card } = seed();
    s.db
      .prepare(
        "INSERT INTO verification (id, card_id, commit_hash, mode, started_at) VALUES ('v1', ?, 'abc', 'tests_only', 't')",
      )
      .run(card.id);
    s.db
      .prepare(
        "INSERT INTO verification_item (id, verification_id, check_text) VALUES ('i1','v1','c')",
      )
      .run();
    expect(s.db.prepare("SELECT kind FROM verification").get()).toEqual({ kind: "check" });
    expect(s.db.prepare("SELECT kind FROM verification_item").get()).toEqual({ kind: "check" });
  });
});
