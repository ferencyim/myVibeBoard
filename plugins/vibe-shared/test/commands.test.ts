import { describe, expect, it } from "vitest";
import { compareHlc, isHlc } from "../contract/hlc";
import { CardSchema, AgentSessionSchema } from "../contract/model";
import { StateMachineError } from "../contract/state-machine";
import { CommandError, createVibeStore, readEvents } from "../db";
import { setup } from "./helpers";

function seedProject(s: ReturnType<typeof setup>) {
  return s.store.projects.create({
    name: "Demo",
    prefix: "DEMO",
    repoPath: "<repo>",
    projectType: "web",
  });
}

const types = (s: ReturnType<typeof setup>) =>
  readEvents(s.db, 0, { limit: 1000 }).map((e) => e.type);

describe("projects and cards", () => {
  it("keeps replica-generated ids and creation times (sync materialization)", () => {
    const s = setup();
    const p = seedProject(s);
    const card = s.store.cards.create(
      { id: "01CARDFROMPHONE000000000A", createdAt: "2025-12-31T23:00:00.000Z", projectId: p.id, title: "Offline" },
      "phone",
    );
    expect(card.id).toBe("01CARDFROMPHONE000000000A");
    expect(card.createdAt).toBe("2025-12-31T23:00:00.000Z");
    const ev = s.store.events.add({ id: "01EVENTFROMPHONE00000000A", createdAt: "2025-12-31T23:30:00.000Z", cardId: card.id, type: "note", authorKind: "user" });
    expect(ev).toMatchObject({ id: "01EVENTFROMPHONE00000000A", createdAt: "2025-12-31T23:30:00.000Z" });
    expect(s.store.tags.create("mine", false, "01TAGFROMPHONE00000000AA").id).toBe("01TAGFROMPHONE00000000AA");
    expect(s.store.presets.create({ id: "01PRESETFROMPHONE000000A", name: "p", provider: "x", model: "y" }).id).toBe("01PRESETFROMPHONE000000A");
    const meta = s.db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM sync_meta WHERE table_name = 'card_event' AND row_id = ?").get(ev.id);
    expect(meta?.n).toBe(6); // every synced field of a new event is stamped
  });

  it("creates cards with sequential keys and publishes card.created", () => {
    const s = setup();
    const p = seedProject(s);
    const a = s.store.cards.create({ projectId: p.id, title: "First" });
    const b = s.store.cards.create({ projectId: p.id, title: "Second" });
    expect([a.key, b.key]).toEqual(["DEMO-1", "DEMO-2"]);
    expect(a.column).toBe("draft");
    expect(a.sortKey < b.sortKey).toBe(true);
    expect(s.store.cards.get("DEMO-2")?.id).toBe(b.id);
    const created = readEvents(s.db, 0).filter((e) => e.type === "card.created");
    expect(created.map((e) => e.cardId)).toEqual([a.id, b.id]);
    expect(created[0]?.payload).toMatchObject({ key: "DEMO-1", column: "draft", origin: "manual" });
    // domain objects satisfy the zod contract after a JSON round trip
    expect(CardSchema.parse(JSON.parse(JSON.stringify(a)))).toMatchObject({
      id: a.id,
      needsEvidence: false,
    });
  });

  it("rejects bad prefixes, duplicate prefixes and empty titles", () => {
    const s = setup();
    expect(() => s.store.projects.create({ name: "x", prefix: "bad", repoPath: "r" })).toThrow(
      CommandError,
    );
    seedProject(s);
    expect(() => seedProject(s)).toThrow(/already exists/);
    const p = s.store.projects.list()[0]!;
    expect(() => s.store.cards.create({ projectId: p.id, title: "   " })).toThrow(CommandError);
  });

  it("defaults needs_evidence from tags and stores tags", () => {
    const s = setup();
    const p = seedProject(s);
    const feature = s.store.cards.create({ projectId: p.id, title: "f", tagIds: ["tag_feature"] });
    const bug = s.store.cards.create({ projectId: p.id, title: "b", tagIds: ["tag_bug"] });
    expect(feature.needsEvidence).toBe(true);
    expect(feature.tags).toEqual(["tag_feature"]);
    expect(bug.needsEvidence).toBe(false);
    const explicit = s.store.cards.create({
      projectId: p.id,
      title: "x",
      tagIds: ["tag_feature"],
      needsEvidence: false,
    });
    expect(explicit.needsEvidence).toBe(false);
  });

  it("update writes only given fields, emits card.updated, and validates unknown tags", () => {
    const s = setup();
    const p = seedProject(s);
    const c = s.store.cards.create({ projectId: p.id, title: "t" });
    s.tick();
    const u = s.store.cards.update(c.id, {
      description: "d",
      priority: "high",
      refImages: ["a.png"],
    });
    expect(u).toMatchObject({
      description: "d",
      priority: "high",
      refImages: ["a.png"],
      title: "t",
    });
    const ev = readEvents(s.db, 0).filter((e) => e.type === "card.updated");
    expect(ev).toHaveLength(1);
    expect(ev[0]?.payload).toEqual({ fields: ["description", "priority", "refImages"] });
    expect(() => s.store.cards.setTags(c.id, ["nope"])).toThrow(/Tag not found/);
    // no-op update emits nothing
    s.store.cards.update(c.id, {});
    expect(readEvents(s.db, 0).filter((e) => e.type === "card.updated")).toHaveLength(1);
  });

  it("filters by column, tag and archived state", () => {
    const s = setup();
    const p = seedProject(s);
    const a = s.store.cards.create({ projectId: p.id, title: "a", tagIds: ["tag_bug"] });
    s.store.cards.create({ projectId: p.id, title: "b", column: "todo" });
    s.store.cards.archive(a.id);
    expect(s.store.cards.list({ projectId: p.id }).map((c) => c.title)).toEqual(["b"]);
    expect(s.store.cards.list({ projectId: p.id, includeArchived: true })).toHaveLength(2);
    expect(s.store.cards.list({ column: "todo" })).toHaveLength(1);
    expect(s.store.cards.list({ tagId: "tag_bug", includeArchived: true })).toHaveLength(1);
  });

  it("deletes only drafts and leaves tombstones", () => {
    const s = setup();
    const p = seedProject(s);
    const c = s.store.cards.create({ projectId: p.id, title: "gone", tagIds: ["tag_bug"] });
    s.store.cards.delete(c.id);
    expect(s.store.cards.get(c.id)).toBeUndefined();
    const tombs = s.db
      .prepare<{ table_name: string }>("SELECT table_name FROM sync_tombstone")
      .all()
      .map((r) => r.table_name);
    expect(tombs).toContain("card");
    expect(tombs).toContain("card_tag");
    expect(tombs).toContain("card_event");
    expect(types(s)).toContain("card.deleted");
    const t = s.store.cards.create({ projectId: p.id, title: "todo", column: "todo" });
    s.store.cards.dispatch({
      cardId: t.id,
      agentId: "agent-9",
      provider: "claude",
      worktree: "<wt>",
    });
    expect(() => s.store.cards.delete(t.id)).toThrow(CommandError);
  });
});

describe("moves follow the state machine", () => {
  it("full lifecycle: draft -> todo -> dispatch -> verifying -> reject -> verifying -> done", () => {
    const s = setup();
    const p = seedProject(s);
    const c = s.store.cards.create({ projectId: p.id, title: "work" });

    expect(s.store.cards.move(c.id, { to: "todo", actor: "user" }).column).toBe("todo");

    const { card, session } = s.store.cards.dispatch({
      cardId: c.id,
      agentId: "agent-1",
      workspaceId: "ws-1",
      provider: "claude",
      worktree: "<worktrees>/demo-1",
    });
    expect(card).toMatchObject({ column: "in_progress", worktree: "<worktrees>/demo-1" });
    expect(session).toMatchObject({ state: "starting", role: "worker", cardId: c.id });

    expect(s.store.cards.move(c.id, { to: "verifying", actor: "lifecycle" }).column).toBe(
      "verifying",
    );
    expect(
      s.store.cards.move(c.id, { to: "in_progress", actor: "verifier", reason: "check 2 failed" })
        .column,
    ).toBe("in_progress");
    s.store.cards.move(c.id, { to: "verifying", actor: "lifecycle" });
    expect(s.store.cards.move(c.id, { to: "done", actor: "user" }).column).toBe("done");

    const moves = readEvents(s.db, 0)
      .filter((e) => e.type === "card.moved")
      .map((e) => e.payload as { from: string; to: string; actor: string });
    expect(moves.map((m) => `${m.from}>${m.to}:${m.actor}`)).toEqual([
      "draft>todo:user",
      "todo>in_progress:dispatcher",
      "in_progress>verifying:lifecycle",
      "verifying>in_progress:verifier",
      "in_progress>verifying:lifecycle",
      "verifying>done:user",
    ]);
    expect(types(s)).toContain("card.dispatched");
    expect(types(s)).toContain("session.started");
    // every transition is also a card timeline entry
    const statusEvents = s.store.events.list(c.id).filter((e) => e.type === "status");
    expect(statusEvents.length).toBeGreaterThanOrEqual(7);
  });

  it("rejects illegal moves and leaves no trace (atomic)", () => {
    const s = setup();
    const p = seedProject(s);
    const c = s.store.cards.create({ projectId: p.id, title: "x" });
    const before = readEvents(s.db, 0).length;
    expect(() => s.store.cards.move(c.id, { to: "done", actor: "user" })).toThrow(
      StateMachineError,
    );
    expect(() => s.store.cards.move(c.id, { to: "todo", actor: "master" })).toThrow(/may not move/);
    expect(s.store.cards.get(c.id)?.column).toBe("draft");
    expect(readEvents(s.db, 0)).toHaveLength(before);
  });

  it("the phone moves only draft <-> todo; everything else is daemon-decided", () => {
    const s = setup();
    const p = seedProject(s);
    const c = s.store.cards.create({ projectId: p.id, title: "phone" }, "phone");
    s.store.cards.move(c.id, { to: "todo", actor: "phone" });
    s.store.cards.move(c.id, { to: "draft", actor: "phone" });
    s.store.cards.move(c.id, { to: "todo", actor: "phone" });
    expect(() => s.store.cards.move(c.id, { to: "in_progress", actor: "phone" })).toThrow(
      StateMachineError,
    );
    s.store.cards.dispatch({ cardId: c.id, agentId: "a", provider: "claude", worktree: null });
    expect(() => s.store.cards.move(c.id, { to: "todo", actor: "phone" })).toThrow(
      StateMachineError,
    );
  });

  it("todo -> in_progress is only possible through dispatch", () => {
    const s = setup();
    const p = seedProject(s);
    const c = s.store.cards.create({ projectId: p.id, title: "x", column: "todo" });
    expect(() => s.store.cards.move(c.id, { to: "in_progress", actor: "user" })).toThrow(
      StateMachineError,
    );
    expect(() => s.store.cards.move(c.id, { to: "in_progress", actor: "dispatcher" })).toThrow(
      /dispatch/,
    );
    // dispatch needs a todo card
    const d = s.store.cards.create({ projectId: p.id, title: "draft" });
    expect(() =>
      s.store.cards.dispatch({ cardId: d.id, agentId: "a", provider: "claude", worktree: null }),
    ).toThrow(StateMachineError);
  });

  it("maintenance fix cards can be created directly in progress by the dispatcher", () => {
    const s = setup();
    const p = seedProject(s);
    const c = s.store.cards.create(
      {
        projectId: p.id,
        title: "fix slow query",
        column: "in_progress",
        origin: "maintenance",
        originRef: "rule-1",
        dedupeKey: "q:users",
      },
      "dispatcher",
    );
    expect(c).toMatchObject({ origin: "maintenance", column: "in_progress", dedupeKey: "q:users" });
    expect(() =>
      s.store.cards.create({ projectId: p.id, title: "x", column: "in_progress" }, "dispatcher"),
    ).toThrow(StateMachineError);
    expect(() =>
      s.store.cards.create({ projectId: p.id, title: "x", column: "todo" }, "master"),
    ).toThrow(StateMachineError);
  });

  it("moving to a column appends at its end; reorder keeps the column", () => {
    const s = setup();
    const p = seedProject(s);
    const a = s.store.cards.create({ projectId: p.id, title: "a", column: "todo" });
    const b = s.store.cards.create({ projectId: p.id, title: "b", column: "draft" });
    const moved = s.store.cards.move(b.id, { to: "todo", actor: "user" });
    expect(moved.sortKey > a.sortKey).toBe(true);
    const re = s.store.cards.reorder(b.id, "0a");
    expect(re.column).toBe("todo");
    expect(s.store.cards.list({ column: "todo" }).map((c) => c.title)).toEqual(["b", "a"]);
  });
});

describe("sync metadata (HLC / LWW columns)", () => {
  it("stamps updated_hlc and field-level sync_meta, strictly increasing", () => {
    const s = setup();
    const p = seedProject(s);
    const c = s.store.cards.create({ projectId: p.id, title: "t" });
    expect(isHlc(c.updatedHlc)).toBe(true);
    s.store.cards.update(c.id, { title: "t2" });
    const afterUpdate = s.store.cards.get(c.id)!;
    expect(compareHlc(afterUpdate.updatedHlc, c.updatedHlc)).toBe(1);

    const meta = s.db
      .prepare<{ column_name: string; hlc: string; device_id: string }>(
        "SELECT column_name, hlc, device_id FROM sync_meta WHERE table_name = 'card' AND row_id = ?",
      )
      .all(c.id);
    const byCol = Object.fromEntries(meta.map((m) => [m.column_name, m]));
    expect(byCol.title?.hlc).toBe(afterUpdate.updatedHlc);
    expect(byCol.description?.hlc).toBe(c.updatedHlc); // untouched field keeps its old clock
    expect(byCol.title?.device_id).toBe("dev-test");
    // non-synced (daemon-owned) columns are never stamped
    expect(byCol.worktree).toBeUndefined();
  });

  it("keeps the HLC monotonic when the wall clock goes backwards", () => {
    const s = setup();
    const p = seedProject(s);
    const c = s.store.cards.create({ projectId: p.id, title: "t" });
    s.clock.ms -= 3_600_000;
    const u = s.store.cards.update(c.id, { title: "later" });
    expect(compareHlc(u.updatedHlc, c.updatedHlc)).toBe(1);
  });

  it("a move stamps column and sort_key; tag removal and preset deletion leave tombstones", () => {
    const s = setup();
    const p = seedProject(s);
    const c = s.store.cards.create({ projectId: p.id, title: "t", tagIds: ["tag_bug", "tag_doc"] });
    const m = s.store.cards.move(c.id, { to: "todo", actor: "user" });
    const meta = s.db
      .prepare<{ column_name: string; hlc: string }>(
        "SELECT column_name, hlc FROM sync_meta WHERE table_name='card' AND row_id=?",
      )
      .all(c.id);
    expect(meta.find((x) => x.column_name === "column")?.hlc).toBe(m.updatedHlc);
    expect(meta.find((x) => x.column_name === "sort_key")?.hlc).toBe(m.updatedHlc);

    s.store.cards.setTags(c.id, ["tag_bug"]);
    const tomb = s.db
      .prepare<{ row_id: string }>("SELECT row_id FROM sync_tombstone WHERE table_name='card_tag'")
      .all();
    expect(tomb.map((t) => t.row_id)).toEqual([`${c.id}:tag_doc`]);
    // re-adding clears the tombstone
    s.store.cards.setTags(c.id, ["tag_bug", "tag_doc"]);
    expect(
      s.db.prepare("SELECT 1 AS x FROM sync_tombstone WHERE table_name='card_tag'").get(),
    ).toBeUndefined();

    const preset = s.store.presets.create({ name: "Fast", provider: "claude", model: "sonnet" });
    s.store.presets.delete(preset.id);
    expect(
      s.db
        .prepare("SELECT 1 AS x FROM sync_tombstone WHERE table_name='preset' AND row_id=?")
        .get(preset.id),
    ).toBeTruthy();
  });

  it("persists the device id and shares one HLC sequence across store instances", () => {
    const s = setup();
    const p = seedProject(s);
    const other = createVibeStore(s.db, { now: () => new Date(s.clock.ms) });
    const a = s.store.cards.create({ projectId: p.id, title: "a" });
    const b = other.cards.create({ projectId: p.id, title: "b" });
    expect(compareHlc(b.updatedHlc, a.updatedHlc)).toBe(1);
    expect(other.deviceId()).toBe(other.deviceId());
  });
});

describe("presets and tags", () => {
  it("round-trips presets and enforces unique names", () => {
    const s = setup();
    const p = s.store.presets.create({
      name: "Claude Opus",
      provider: "claude",
      model: "opus",
      thinking: "high",
      permissionMode: "auto",
      environmentKind: "new-worktree",
      baseBranch: "main",
      runtimeEnv: "android-emulator",
    });
    expect(p).toMatchObject({
      permissionMode: "auto",
      runtimeEnv: "android-emulator",
      builtin: false,
    });
    expect(() =>
      s.store.presets.create({ name: "claude opus", provider: "x", model: "y" }),
    ).toThrow(/already exists/);
    expect(s.store.presets.update(p.id, { thinking: "max" }).thinking).toBe("max");
    expect(s.store.presets.list()).toHaveLength(1);
  });

  it("deleting a preset detaches it from projects and cards", () => {
    const s = setup();
    const preset = s.store.presets.create({ name: "P", provider: "codex", model: "m" });
    const proj = s.store.projects.create({
      name: "n",
      prefix: "AB",
      repoPath: "r",
      defaultPresetId: preset.id,
    });
    const card = s.store.cards.create({ projectId: proj.id, title: "t", presetId: preset.id });
    s.store.presets.delete(preset.id);
    expect(s.store.projects.get(proj.id)?.defaultPresetId).toBeNull();
    expect(s.store.cards.get(card.id)?.presetId).toBeNull();
  });

  it("custom tags can be added and removed; built-ins cannot be deleted", () => {
    const s = setup();
    const t = s.store.tags.create("spike", true);
    expect(s.store.tags.list().map((x) => x.name)).toContain("spike");
    s.store.tags.delete(t.id);
    expect(() => s.store.tags.delete("tag_bug")).toThrow(/Built-in/);
  });

  it("renames and recolors a tag in place: cards keep it, sync fields are stamped", () => {
    const s = setup();
    const p = s.store.projects.create({ name: "n", prefix: "AB", repoPath: "r" });
    const t = s.store.tags.create("spike", false, undefined, "#ff0000");
    expect(t.color).toBe("#ff0000");
    const card = s.store.cards.create({ projectId: p.id, title: "c", tagIds: [t.id] });
    const next = s.store.tags.update(t.id, { name: "experiment", color: "#00ff00", evidence: true });
    expect(next).toMatchObject({ id: t.id, name: "experiment", color: "#00ff00", evidence: true });
    expect(s.store.tags.list().filter((x) => !x.builtin)).toHaveLength(1);
    expect(s.store.cards.get(card.id)?.tags).toEqual([t.id]);
    const stamped = s.db
      .prepare<{ column_name: string }>("SELECT column_name FROM sync_meta WHERE table_name='tag' AND row_id=?")
      .all(t.id)
      .map((r) => r.column_name)
      .sort();
    expect(stamped).toEqual(["color", "evidence", "name"]);
    // Built-ins can be recolored too; names stay unique and non-empty.
    expect(s.store.tags.update("tag_bug", { color: "#123456" }).color).toBe("#123456");
    expect(() => s.store.tags.update(t.id, { name: "BUG" })).toThrow(/already exists/);
    expect(() => s.store.tags.update(t.id, { name: "  " })).toThrow(/empty/);
    expect(() => s.store.tags.update("nope", { color: "#000" })).toThrow(/not found/i);
  });
});

describe("card events and plan versions", () => {
  it("evaluation events publish card.assessed; other types do not", () => {
    const s = setup();
    const p = seedProject(s);
    const c = s.store.cards.create({ projectId: p.id, title: "t" });
    const note = s.store.events.add({
      cardId: c.id,
      type: "note",
      authorKind: "user",
      author: "me",
      body: { text: "hi" },
    });
    const ev = s.store.events.add({
      cardId: c.id,
      type: "evaluation",
      authorKind: "agent",
      author: "master",
      body: { clear: true },
    });
    const assessed = readEvents(s.db, 0).filter((e) => e.type === "card.assessed");
    expect(assessed).toHaveLength(1);
    expect(assessed[0]?.payload).toEqual({ cardEventId: ev.id });
    expect(note.body).toEqual({ text: "hi" });
  });

  it("keeps a numbered plan version history", () => {
    const s = setup();
    const p = seedProject(s);
    const c = s.store.cards.create({ projectId: p.id, title: "t" });
    const snap = {
      description: "v",
      checks: [{ text: "works" }],
      subCards: [],
      tags: ["tag_bug"],
      recommendedPresetId: null,
    };
    const v1 = s.store.plans.save(c.id, snap);
    const v2 = s.store.plans.save(c.id, { ...snap, description: "v2" });
    expect([v1.version, v2.version]).toEqual([1, 2]);
    expect(s.store.plans.list(c.id).map((v) => v.snapshot.description)).toEqual(["v", "v2"]);
    expect(
      readEvents(s.db, 0)
        .filter((e) => e.type === "plan.updated")
        .map((e) => e.payload),
    ).toEqual([{ version: 1 }, { version: 2 }]);
    expect(() => s.store.plans.save(c.id, { description: 1 } as never)).toThrow();
  });
});

describe("agent sessions", () => {
  function started() {
    const s = setup();
    const p = seedProject(s);
    const c = s.store.cards.create({ projectId: p.id, title: "t", column: "todo" });
    const { session } = s.store.cards.dispatch({
      cardId: c.id,
      agentId: "agent-1",
      provider: "claude",
      worktree: "<wt>",
    });
    return { s, c, session };
  }

  it("tracks waiting_since / pending question and emits waiting/answered", () => {
    const { s, c, session } = started();
    s.store.sessions.setState(session.id, "working");
    s.tick(5000);
    const waiting = s.store.sessions.setState(session.id, "waiting", {
      question: { text: "which db?" },
    });
    expect(waiting).toMatchObject({ state: "waiting", pendingQuestion: { text: "which db?" } });
    expect(waiting.waitingSince).toBe(new Date(s.clock.ms).toISOString());
    // re-asserting waiting keeps the original waiting_since
    s.tick(5000);
    expect(s.store.sessions.setState(session.id, "waiting").waitingSince).toBe(
      waiting.waitingSince,
    );

    const answered = s.store.sessions.setState(session.id, "working");
    expect(answered).toMatchObject({ waitingSince: null, pendingQuestion: null });
    expect(types(s).filter((t) => t.startsWith("session."))).toEqual([
      "session.started",
      "session.waiting",
      "session.answered",
    ]);
    expect(
      s.store.events
        .list(c.id)
        .some((e) => (e.body as { kind?: string }).kind === "session_waiting"),
    ).toBe(true);
  });

  it("validates session transitions and handles end/error", () => {
    const { s, session } = started();
    s.store.sessions.setState(session.id, "working");
    const err = s.store.sessions.setState(session.id, "error", { message: "rate limit" });
    expect(err).toMatchObject({ state: "error", errorMessage: "rate limit" });
    expect(s.store.sessions.setState(session.id, "working").errorMessage).toBeNull();
    const ended = s.store.sessions.setState(session.id, "ended", { outcome: "completed" });
    expect(ended.endedAt).not.toBeNull();
    expect(() => s.store.sessions.setState(session.id, "working")).toThrow(StateMachineError);
    expect(types(s)).toEqual(expect.arrayContaining(["session.error", "session.ended"]));
    expect(AgentSessionSchema.parse(JSON.parse(JSON.stringify(ended)))).toMatchObject({
      id: session.id,
    });
  });

  it("records provider switches, compactions and cache expiry", () => {
    const { s, c, session } = started();
    const sw = s.store.sessions.switchProvider(session.id, "codex", "quota low");
    expect(sw.currentProvider).toBe("codex");
    expect(sw.switchHistory).toMatchObject([{ from: "claude", to: "codex", reason: "quota low" }]);
    expect(s.store.sessions.switchProvider(session.id, "codex").switchHistory).toHaveLength(1);
    s.store.sessions.recordCompaction(session.id, "compact");
    const touched = s.store.sessions.touch(session.id, {
      cacheExpiresAt: "2026-01-01T01:00:00.000Z",
    });
    expect(touched.cacheExpiresAt).toBe("2026-01-01T01:00:00.000Z");
    expect(types(s)).toEqual(expect.arrayContaining(["session.switched", "session.compacted"]));
    expect(s.store.events.list(c.id).map((e) => e.type)).toEqual(
      expect.arrayContaining(["switch_agent", "compaction"]),
    );
  });

  it("one session per Paseo agent; the master session has no card", () => {
    const { s } = started();
    expect(() =>
      s.store.sessions.start({
        cardId: null,
        agentId: "agent-1",
        role: "master",
        provider: "claude",
      }),
    ).toThrow(/already has a session/);
    const master = s.store.sessions.start({
      cardId: null,
      agentId: "agent-m",
      role: "master",
      provider: "claude",
    });
    expect(master.cardId).toBeNull();
    expect(s.store.sessions.getByAgent("agent-m")?.id).toBe(master.id);
    expect(s.store.sessions.list({ role: "master" })).toHaveLength(1);
  });

  it("stores git snapshots (upsert per project)", () => {
    const s = setup();
    const p = seedProject(s);
    s.store.gitSnapshots.upsert({
      projectId: p.id,
      branch: "main",
      ahead: 1,
      behind: 0,
      dirtyFiles: 2,
      diffStat: "2 files",
    });
    const second = s.store.gitSnapshots.upsert({
      projectId: p.id,
      branch: "dev",
      ahead: 0,
      behind: 3,
      dirtyFiles: 0,
      diffStat: "",
    });
    expect(second).toMatchObject({ branch: "dev", behind: 3 });
    expect(s.store.gitSnapshots.get(p.id)?.branch).toBe("dev");
  });
});
