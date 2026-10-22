import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newId } from "../server/vibe/contract";
import {
  ClientSync,
  MemoryChangeStore,
  PendingReplyQueue,
  type ExchangeResponse,
  type JsonValue,
} from "../server/vibe/sync";
import { createVibeStore, openVibeDb } from "../server/vibe/db";
import * as rpc from "../shared/rpc";
import { registerBoardRpcs } from "../server/rpc";
import { createBoardService, openBoardRuntime } from "../server/service";
import { createReplyService, createSyncService } from "../server/sync";
import { tempDir } from "./helpers";

const START = Date.parse("2026-03-01T08:00:00.000Z");

function setup() {
  const clock = { ms: START };
  const now = () => clock.ms;
  const runtime = openBoardRuntime({ path: join(tempDir(), "vibe.db"), now: () => new Date(clock.ms) });
  const { db, store } = runtime;
  const sync = createSyncService({ db, store, now, log: () => {} });
  const project = store.projects.create({ name: "Demo", prefix: "DEM", repoPath: "/tmp/demo" });
  const eventTypes = () =>
    db.prepare<{ type: string }>("SELECT type FROM vibe_event ORDER BY seq").all().map((r) => r.type);

  function phone(deviceId = "phone-1") {
    const client = new ClientSync({ deviceId, store: new MemoryChangeStore(), now });
    const transport = async (req: Parameters<typeof sync.exchange>[0]): Promise<ExchangeResponse> =>
      sync.exchange(JSON.parse(JSON.stringify(req)));
    const row = (table: string, id: string) => client.node.readRow(table, id)?.values;
    const syncNow = () => client.sync(transport);
    const newCard = (title: string, over: Record<string, JsonValue> = {}) => {
      const id = newId(clock.ms);
      client.write("card", id, {
        project_id: project.id,
        title,
        description: "",
        column: "draft",
        sort_key: `k${id.slice(-6)}`,
        priority: "none",
        acceptance: "",
        ref_images_json: "[]",
        needs_evidence: 0,
        ...over,
      });
      return id;
    };
    return { client, row, syncNow, newCard };
  }
  return { clock, runtime, store, db, sync, project, eventTypes, phone };
}

describe("phone sync endpoint", () => {
  it("first contact is a snapshot with business rows, seed tags and read-only tables", async () => {
    const t = setup();
    const card = t.store.cards.create({ projectId: t.project.id, title: "Existing", column: "todo" });
    t.store.cards.dispatch({ cardId: card.id, agentId: "agent-1", provider: "claude", worktree: null });
    const p = t.phone();
    const out = await p.syncNow();
    expect(out.rejected).toEqual([]);
    expect(p.row("project", t.project.id)?.name).toBe("Demo");
    expect(p.row("card", card.id)).toMatchObject({ title: "Existing", column: "in_progress" });
    expect(p.client.node.listRows("tag").length).toBeGreaterThanOrEqual(1); // seed tags
    const sessions = p.client.node.listRows("agent_session");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.values).toMatchObject({ agent_id: "agent-1", state: "starting" });
  });

  it("offline: 20 edited cards plus 20 new cards reach the daemon with zero loss", async () => {
    const t = setup();
    const ids = Array.from({ length: 20 }, (_, i) => t.store.cards.create({ projectId: t.project.id, title: `Card ${i}` }).id);
    const p = t.phone();
    await p.syncNow();

    // --- offline ---
    t.clock.ms += 60_000;
    ids.forEach((id, i) => {
      p.client.write("card", id, { title: `Edited ${i}`, priority: "high" });
      if (i < 5) p.client.write("card", id, { column: "todo" });
    });
    const created = Array.from({ length: 20 }, (_, i) => p.newCard(`Offline ${i}`, i % 2 ? { column: "todo" } : {}));
    expect(p.client.pending.length).toBeGreaterThan(40);

    // --- reconnect ---
    t.clock.ms += 60_000;
    const before = t.eventTypes().length;
    const out = await p.syncNow();
    expect(out.rejected).toEqual([]);
    expect(p.client.pending).toEqual([]);

    ids.forEach((id, i) => {
      expect(t.store.cards.get(id)).toMatchObject({
        title: `Edited ${i}`,
        priority: "high",
        column: i < 5 ? "todo" : "draft",
      });
    });
    created.forEach((id, i) => {
      expect(t.store.cards.get(id)).toMatchObject({ title: `Offline ${i}`, column: i % 2 ? "todo" : "draft" });
    });
    expect(t.store.cards.list({ projectId: t.project.id })).toHaveLength(40);
    const events = t.eventTypes().slice(before);
    expect(events.filter((e) => e === "card.created")).toHaveLength(20);
    expect(events.filter((e) => e === "card.moved")).toHaveLength(5);
    expect(events.filter((e) => e === "card.updated").length).toBeGreaterThanOrEqual(20);

    // A second phone converges to the same state, and a re-sync is a no-op.
    const other = t.phone("phone-2");
    await other.syncNow();
    for (const id of [...ids, ...created]) expect(other.row("card", id)).toEqual(p.row("card", id));
    const eventsAfter = t.eventTypes().length;
    await p.syncNow();
    await other.syncNow();
    expect(t.eventTypes().length).toBe(eventsAfter);
  });

  it("sees writes of another plugin process on the same vibe.db", async () => {
    const t = setup();
    const p = t.phone();
    await p.syncNow();
    const other = openVibeDb({ path: t.db.path });
    const card = createVibeStore(other, { now: () => new Date(t.clock.ms) }).cards.create({ projectId: t.project.id, title: "From other process" });
    other.close();
    await p.syncNow();
    expect(p.row("card", card.id)?.title).toBe("From other process");
  });

  it("is idempotent when a response is lost and the request is resent", async () => {
    const t = setup();
    const p = t.phone();
    await p.syncNow();
    const id = p.newCard("Once");
    const req = p.client.buildRequest();
    t.sync.exchange(JSON.parse(JSON.stringify(req))); // response lost
    await p.syncNow();
    expect(t.store.cards.list({ projectId: t.project.id }).filter((c) => c.title === "Once")).toHaveLength(1);
    expect(t.store.cards.get(id)?.title).toBe("Once");
  });

  it("publishes display-only columns (card key, project prefix) for the phone", async () => {
    const t = setup();
    const existing = t.store.cards.create({ projectId: t.project.id, title: "Numbered" });
    const p = t.phone();
    await p.syncNow();
    expect(p.row("project", t.project.id)).toMatchObject({ prefix: "DEM" });
    expect(p.row("card", existing.id)).toMatchObject({ key: existing.key, number: existing.number });

    // A card made on the phone gets its key in the same round trip that creates it.
    const id = p.newCard("Phone card");
    await p.syncNow();
    const created = t.store.cards.get(id);
    expect(created?.key).toMatch(/^DEM-\d+$/);
    expect(p.row("card", id)).toMatchObject({ key: created?.key, number: created?.number });
  });

  it("rejects phone column moves outside draft <-> todo and converges to the daemon value", async () => {
    const t = setup();
    const running = t.store.cards.create({ projectId: t.project.id, title: "Running", column: "todo" });
    t.store.cards.dispatch({ cardId: running.id, agentId: "agent-1", provider: "claude", worktree: null });
    const draft = t.store.cards.create({ projectId: t.project.id, title: "Draft" });
    const p = t.phone();
    await p.syncNow();

    t.clock.ms += 1000;
    p.client.write("card", running.id, { column: "todo" }); // pull a running card back
    p.client.write("card", draft.id, { column: "done" }); // jump to done
    const out = await p.syncNow();
    expect(out.rejected.map((r) => r.reason)).toEqual(["column_locked", "column_locked"]);
    expect(p.row("card", running.id)?.column).toBe("in_progress");
    expect(p.row("card", draft.id)?.column).toBe("draft");
    expect(t.store.cards.get(running.id)?.column).toBe("in_progress");
    expect(t.store.cards.get(draft.id)?.column).toBe("draft");
    expect(p.client.pending).toEqual([]);
  });

  it("publishes read-only tables as increments and refuses phone writes to them", async () => {
    const t = setup();
    const card = t.store.cards.create({ projectId: t.project.id, title: "Q", column: "todo" });
    const { session } = t.store.cards.dispatch({ cardId: card.id, agentId: "agent-1", provider: "claude", worktree: null });
    const p = t.phone();
    await p.syncNow();
    const cursor = p.client.cursor;

    t.clock.ms += 30_000;
    t.store.sessions.setState(session.id, "working");
    t.store.sessions.setState(session.id, "waiting", { question: { requestId: "r1", kind: "question", name: "Ask" } });
    await p.syncNow();
    expect(p.client.cursor).toBeGreaterThan(cursor);
    const row = p.row("agent_session", session.id);
    expect(row?.state).toBe("waiting");
    expect(JSON.parse(String(row?.pending_question_json)).requestId).toBe("r1");
    expect(typeof row?.last_activity_at).toBe("string"); // "as of hh:mm" source
    expect(() => p.client.write("agent_session", session.id, { state: "idle" })).toThrow();

    // forged change straight on the wire
    const forged = p.client.buildRequest();
    forged.changes = [
      { kind: "field", table: "agent_session", rowId: session.id, column: "state", value: "idle", hlc: p.client.node.clock.tick() },
    ];
    const resp = t.sync.exchange(forged);
    expect(resp.ok && resp.rejected[0]?.reason).toBe("read_only");
    expect(t.store.sessions.get(session.id)?.state).toBe("waiting");
  });

  it("field-level LWW between daemon and phone edits", async () => {
    const t = setup();
    const card = t.store.cards.create({ projectId: t.project.id, title: "Base" });
    const p = t.phone();
    await p.syncNow();

    // phone edits title offline at T+10s, daemon edits title at T+20s and priority at T+5s
    t.clock.ms += 5_000;
    t.store.cards.update(card.id, { priority: "low" });
    t.clock.ms += 5_000;
    p.client.write("card", card.id, { title: "Phone title", priority: "urgent" });
    t.clock.ms += 10_000;
    t.store.cards.update(card.id, { title: "Daemon title" });
    t.clock.ms += 5_000;
    await p.syncNow();

    expect(t.store.cards.get(card.id)).toMatchObject({ title: "Daemon title", priority: "urgent" });
    expect(p.row("card", card.id)).toMatchObject({ title: "Daemon title", priority: "urgent" });
  });

  it("daemon edits reach the phone as increments, including tags and deletes", async () => {
    const t = setup();
    const keep = t.store.cards.create({ projectId: t.project.id, title: "Keep" });
    const gone = t.store.cards.create({ projectId: t.project.id, title: "Gone" });
    const p = t.phone();
    await p.syncNow();

    t.clock.ms += 1000;
    const tag = t.store.tags.list()[0]!;
    t.store.cards.setTags(keep.id, [tag.id]);
    t.store.cards.update(keep.id, { title: "Kept" });
    t.store.cards.delete(gone.id);
    await p.syncNow();
    expect(p.row("card", keep.id)?.title).toBe("Kept");
    expect(p.row("card", gone.id)).toBeUndefined();
    expect(p.row("card_tag", `${keep.id}:${tag.id}`)).toEqual({});

    t.clock.ms += 1000;
    t.store.cards.setTags(keep.id, []);
    await p.syncNow();
    expect(p.row("card_tag", `${keep.id}:${tag.id}`)).toBeUndefined();
  });

  it("phone tag changes and deletes are applied; locked deletes are refused", async () => {
    const t = setup();
    const draft = t.store.cards.create({ projectId: t.project.id, title: "Draft" });
    const busy = t.store.cards.create({ projectId: t.project.id, title: "Busy", column: "todo" });
    t.store.cards.dispatch({ cardId: busy.id, agentId: "agent-1", provider: "claude", worktree: null });
    const p = t.phone();
    await p.syncNow();
    const tag = t.store.tags.list()[0]!;

    t.clock.ms += 1000;
    p.client.write("card_tag", `${draft.id}:${tag.id}`, {});
    const note = newId(t.clock.ms);
    p.client.write("card_event", note, {
      card_id: draft.id,
      type: "note",
      author_kind: "user",
      author: "phone",
      created_at: new Date(t.clock.ms).toISOString(),
      body_json: JSON.stringify({ text: "hello" }),
    });
    p.client.remove("card", busy.id);
    const out = await p.syncNow();
    expect(out.rejected.map((r) => r.reason)).toEqual(["column_locked"]);
    expect(t.store.cards.get(draft.id)?.tags).toEqual([tag.id]);
    expect(t.store.events.list(draft.id).some((e) => e.id === note)).toBe(true);
    expect(t.store.cards.get(busy.id)).toBeDefined();
    expect(p.row("card", busy.id)).toMatchObject({ title: "Busy" }); // delete undone

    t.clock.ms += 1000;
    p.client.write("card_tag", `${draft.id}:${tag.id}`, {}); // keep
    p.client.remove("card_tag", `${draft.id}:${tag.id}`);
    p.client.remove("card", draft.id);
    await p.syncNow();
    expect(t.store.cards.get(draft.id)).toBeUndefined();
  });

  it("refuses to create projects or non-note events and an unmaterializable card is withdrawn", async () => {
    const t = setup();
    const p = t.phone();
    await p.syncNow();
    t.clock.ms += 1000;
    p.client.write("project", newId(t.clock.ms), { name: "Sneaky" });
    p.client.write("card", newId(t.clock.ms), { project_id: "no-such-project", title: "Orphan", column: "draft", sort_key: "a" });
    const out = await p.syncNow();
    expect(out.rejected.map((r) => r.reason)).toContain("read_only");
    expect(t.store.projects.list(true)).toHaveLength(1);
    expect(p.client.node.listRows("card")).toEqual([]);
    expect(p.client.node.listRows("project")).toHaveLength(1);
  });

  it("a new epoch forces a snapshot", async () => {
    const t = setup();
    t.store.cards.create({ projectId: t.project.id, title: "A" });
    const p = t.phone();
    await p.syncNow();
    p.client.epoch = "stale-epoch";
    const resp = await t.sync.exchange(p.client.buildRequest());
    expect(resp.ok && resp.snapshot).toBe(true);
  });

  it("publishes the HLC clock so later daemon edits order after accepted phone edits", async () => {
    const t = setup();
    const card = t.store.cards.create({ projectId: t.project.id, title: "T" });
    const p = t.phone();
    await p.syncNow();
    t.clock.ms += 1000;
    p.client.write("card", card.id, { title: "From phone" });
    await p.syncNow();
    // daemon wall clock does not advance: the edit must still win via HLC counter order
    t.store.cards.update(card.id, { title: "Daemon after" });
    await p.syncNow();
    expect(t.store.cards.get(card.id)?.title).toBe("Daemon after");
    expect(p.row("card", card.id)?.title).toBe("Daemon after");
  });
});

describe("convergence fuzz", () => {
  it("two phones and the daemon editing at random converge to the business tables", async () => {
    for (const seed of [1, 2, 3]) {
      let x = seed * 7919;
      const rnd = (n: number) => {
        x = (x * 1103515245 + 12345) & 0x7fffffff;
        return x % n;
      };
      const t = setup();
      const phones = [t.phone("fuzz-a"), t.phone("fuzz-b")];
      for (let i = 0; i < 6; i++) t.store.cards.create({ projectId: t.project.id, title: `Seed ${i}` });
      for (const p of phones) await p.syncNow();
      const liveIds = () => t.store.cards.list({ projectId: t.project.id, includeArchived: true }).map((c) => c.id);
      for (let step = 0; step < 120; step++) {
        t.clock.ms += 1 + rnd(5000);
        const p = phones[rnd(2)]!;
        const ids = [...p.client.node.listRows("card")].map((r) => r.rowId);
        const pick = () => ids[rnd(ids.length)];
        const op = rnd(8);
        if (op === 0) p.newCard(`N${step}`);
        else if (op === 1 && pick()) p.client.write("card", pick()!, { title: `T${step}` });
        else if (op === 2 && pick()) p.client.write("card", pick()!, { priority: ["low", "high", "urgent"][rnd(3)]! });
        else if (op === 3 && pick()) p.client.write("card", pick()!, { column: rnd(2) ? "todo" : "draft" });
        else if (op === 4 && pick()) p.client.remove("card", pick()!);
        else if (op === 5 && liveIds().length) t.store.cards.update(liveIds()[rnd(liveIds().length)]!, { title: `D${step}` });
        else if (op === 6) t.store.cards.create({ projectId: t.project.id, title: `Daemon ${step}` });
        else if (op === 7) await p.syncNow();
      }
      for (let round = 0; round < 3; round++) for (const p of phones) await p.syncNow();
      const business = Object.fromEntries(
        t.db.prepare<Record<string, unknown>>("SELECT * FROM card").all().map((r) => [r.id as string, r]),
      );
      for (const p of phones) {
        const rows = p.client.node.listRows("card");
        expect(rows.map((r) => r.rowId).sort()).toEqual(Object.keys(business).sort());
        for (const r of rows) {
          for (const col of ["title", "description", "column", "priority", "sort_key"]) {
            expect(r.values[col], `${seed} ${r.rowId} ${col}`).toEqual(business[r.rowId]![col]);
          }
        }
        expect(p.client.pending).toEqual([]);
      }
    }
  });
});

describe("rpc wiring", () => {
  it("serves vibe.sync.exchange through the registered handler and its schemas", async () => {
    const t = setup();
    const handlers = new Map<string, (input: unknown, ctx: unknown) => unknown>();
    registerBoardRpcs(
      { handle: (def: { name: string }, fn: never) => handlers.set(def.name, fn) } as never,
      createBoardService(t.runtime),
      { sync: t.sync },
    );
    const p = t.phone();
    p.newCard("Via rpc", { column: "todo" });
    const call = async (input: unknown) =>
      rpc.syncExchangeRpc.output.parse(
        await handlers.get("vibe.sync.exchange")!(rpc.syncExchangeRpc.input.parse(input), { paseo: {} }),
      );
    const resp = await call(JSON.parse(JSON.stringify(p.client.buildRequest())));
    expect(resp.ok && resp.snapshot).toBe(true);
    expect(t.store.cards.list({ projectId: t.project.id })[0]?.title).toBe("Via rpc");
    const drift = await call({ ...p.client.buildRequest(), clientNow: 0 });
    expect(drift).toMatchObject({ ok: false, code: "clock_drift" });
  });
});

describe("offline replies", () => {
  function replySetup(opts: { pending?: boolean; ended?: boolean } = {}) {
    const t = setup();
    const card = t.store.cards.create({ projectId: t.project.id, title: "Ask", column: "todo" });
    const { session } = t.store.cards.dispatch({ cardId: card.id, agentId: "agent-1", provider: "claude", worktree: null });
    t.store.sessions.setState(session.id, "waiting", {
      question: { requestId: "req-1", kind: "question", name: "AskUserQuestion", input: { questions: [{ question: "Which?" }] } },
    });
    if (opts.ended) t.store.sessions.setState(session.id, "ended", { outcome: "closed" });
    const responses: unknown[] = [];
    const paseo = {
      agents: {
        ref: () => ({
          refresh: async () => null,
          current: () => ({
            pendingPermissions:
              opts.pending === false ? [] : [{ id: "req-1", kind: "question", input: { questions: [{ question: "Which?" }] } }],
          }),
          respondToPermission: async (o: unknown) => void responses.push(o),
        }),
      },
    } as never;
    const replies = createReplyService({ db: t.db, store: t.store, getPaseo: () => paseo });
    const queue = new PendingReplyQueue();
    queue.enqueue({ id: "reply-1", cardId: card.id, questionId: "req-1", text: "Option A", now: 1 });
    const flush = () =>
      queue.flush({
        check: async (r) => (await replies.check(r)).state,
        send: async (r) => void (await replies.send(r)),
      });
    return { t, card, replies, queue, flush, responses };
  }

  it("sends once when the question is still pending (and is idempotent)", async () => {
    const s = replySetup();
    const out = await s.flush();
    expect(out).toEqual({ sent: ["reply-1"], stale: [], failed: [] });
    expect(s.responses).toEqual([
      { requestId: "req-1", response: { behavior: "allow", updatedInput: { questions: [{ question: "Which?" }], answers: { "Which?": "Option A" } } } },
    ]);
    const again = await s.replies.send({ id: "reply-1", cardId: s.card.id, questionId: "req-1", text: "Option A" });
    expect(again).toEqual({ sent: true, duplicate: true });
    expect(s.responses).toHaveLength(1);
  });

  it("marks the reply stale when the question was answered elsewhere", async () => {
    const s = replySetup({ pending: false });
    const out = await s.flush();
    expect(out).toEqual({ sent: [], stale: ["reply-1"], failed: [] });
    expect(s.queue.list("stale")[0]?.staleReason).toBe("already_answered");
    expect(s.responses).toEqual([]);
    await expect(
      s.replies.send({ id: "x", cardId: s.card.id, questionId: "req-1", text: "late" }),
    ).rejects.toThrow("[stale]");
  });

  it("marks the reply stale when the session is gone", async () => {
    const s = replySetup({ ended: true });
    const out = await s.flush();
    expect(out.stale).toEqual(["reply-1"]);
    expect(s.queue.list("stale")[0]?.staleReason).toBe("question_gone");
  });
});

describe("round 3 fields over sync", () => {
  it("publishes projectTypes / description / requirementsPath / roleHints and maps old single-value phone writes", async () => {
    const t = setup();
    t.store.projects.update(t.project.id, { projectTypes: ["web", "backend"], description: "d", requirementsPath: "docs/R.md" });
    const preset = t.store.presets.create({ name: "rev", provider: "claude", model: "m", roleHints: ["reviewer", "scout"] });
    const chat = t.store.cards.addChat({
      cardId: t.store.cards.create({ projectId: t.project.id, title: "c" }).id,
      authorKind: "master",
      text: "hello",
      kind: "info",
    });
    const p = t.phone();
    await p.syncNow();
    expect(p.row("project", t.project.id)).toMatchObject({
      project_type: "web",
      project_types_json: '["web","backend"]',
      description: "d",
      requirements_path: "docs/R.md",
    });
    expect(p.row("preset", preset.id)).toMatchObject({ role_hint: "reviewer", role_hints_json: '["reviewer","scout"]' });
    expect(p.row("card_event", chat.id)).toMatchObject({ type: "chat", author_kind: "master" });

    // an old phone knows only the single-value columns
    t.clock.ms += 5_000;
    p.client.write("project", t.project.id, { project_type: "android" });
    p.client.write("preset", preset.id, { role_hint: "scout" });
    t.clock.ms += 5_000;
    await p.syncNow();
    expect(t.store.projects.get(t.project.id)).toMatchObject({ projectType: "android", projectTypes: ["android"] });
    expect(t.store.presets.get(preset.id)).toMatchObject({ roleHint: "scout", roleHints: ["scout"] });
  });
});

describe("WP-105 card fields over sync", () => {
  it("maps phone writes of model picks and read positions, and publishes plan / unread columns", async () => {
    const t = setup();
    const preset = t.store.presets.create({ name: "pl", provider: "claude", model: "m", roleHints: ["planner"] });
    const card = t.store.cards.create({ projectId: t.project.id, title: "c", column: "draft" });
    t.store.cards.setPlan(card.id, {
      plan: { description: "Do A", checks: [{ text: "c1" }], subCards: [], tags: [], recommendedPresetId: null },
      acceptance: "model criteria",
    });
    t.store.events.add({ cardId: card.id, type: "chat", authorKind: "master", author: "planner", body: { text: "hi", thread: "plan" } });
    t.store.events.add({ cardId: card.id, type: "chat", authorKind: "executor", author: "executor", body: { text: "go", thread: "exec" } });
    const p = t.phone();
    await p.syncNow();
    const row = p.row("card", card.id)!;
    expect(JSON.parse(String(row.plan_json))).toMatchObject({ description: "Do A" });
    expect(row.model_acceptance).toBe("model criteria");
    expect(row.plan_activity_at).toBeTruthy();
    expect(row.exec_activity_at).toBeTruthy();

    t.clock.ms += 5_000;
    const seen = new Date(t.clock.ms).toISOString();
    p.client.write("card", card.id, {
      scout_preset_id: preset.id,
      planner_preset_id: preset.id,
      plan_seen_at: seen,
      exec_seen_at: seen,
      verify_seen_at: seen,
    });
    t.clock.ms += 5_000;
    await p.syncNow();
    expect(t.store.cards.get(card.id)).toMatchObject({
      scoutPresetId: preset.id,
      plannerPresetId: preset.id,
      planSeenAt: seen,
      execSeenAt: seen,
      verifySeenAt: seen,
    });

    // plan / unread-activity columns are display-only: the phone has no field to write them
    expect(() => p.client.write("card", card.id, { plan_json: "null" })).toThrow(/Unknown field/);
    expect(() => p.client.write("card", card.id, { plan_activity_at: seen })).toThrow(/Unknown field/);
  });
});

describe("WP-108 card fields over sync", () => {
  it("maps plan reviewer / verifier picks and the review read position; phone cards start from the default models", async () => {
    const t = setup();
    const preset = t.store.presets.create({ name: "v", provider: "claude", model: "m", roleHints: ["verifier"] });
    t.store.projects.update(t.project.id, { defaultPresets: { verifier: preset.id } });
    const card = t.store.cards.create({ projectId: t.project.id, title: "c", column: "draft" });
    t.store.events.add({ cardId: card.id, type: "chat", authorKind: "reviewer", author: "r", body: { text: "ok", thread: "review" } });
    const p = t.phone();
    await p.syncNow();
    expect(JSON.parse(String(p.row("project", t.project.id)!.default_presets_json))).toEqual({ verifier: preset.id });
    expect(p.row("card", card.id)).toMatchObject({ verifier_preset_id: preset.id });
    expect(p.row("card", card.id)!.review_activity_at).toBeTruthy();

    t.clock.ms += 5_000;
    const seen = new Date(t.clock.ms).toISOString();
    p.client.write("card", card.id, { plan_reviewer_preset_id: preset.id, verifier_preset_id: null, review_seen_at: seen });
    const offline = p.newCard("written offline");
    t.clock.ms += 5_000;
    await p.syncNow();
    expect(t.store.cards.get(card.id)).toMatchObject({ planReviewerPresetId: preset.id, verifierPresetId: null, reviewSeenAt: seen });
    // The phone set no models on the new card: it starts from the project default like any new card.
    expect(t.store.cards.get(offline)!.verifierPresetId).toBe(preset.id);
    expect(() => p.client.write("card", card.id, { review_activity_at: seen })).toThrow(/Unknown field/);
  });
});
