import { describe, expect, it, vi } from "vitest";
import { EVENT_TYPES, isEvent, parseEvent, type VibeEvent } from "../contract/events";
import {
  advanceCursor,
  createEventConsumer,
  createVibeStore,
  getCursor,
  getMaxSeq,
  listDeadLetters,
  openVibeDb,
  publishEvent,
  pruneEvents,
  readEvents,
} from "../db";
import { runWorker, setup } from "./helpers";

describe("publishEvent", () => {
  it("validates payloads and assigns increasing seq", () => {
    const { db } = setup();
    const a = publishEvent(db, { type: "plan.updated", payload: { version: 1 } });
    const b = publishEvent(db, { type: "plan.updated", payload: { version: 2 } });
    expect(b).toBeGreaterThan(a);
    expect(() =>
      publishEvent(db, { type: "plan.updated", payload: { version: "x" } as never }),
    ).toThrow();
    expect(() => publishEvent(db, { type: "nope" as never, payload: {} as never })).toThrow();
    expect(getMaxSeq(db)).toBe(b);
  });

  it("retains host file scopes and retryable resource results", () => {
    const { db } = setup();
    publishEvent(db, {
      type: "scheduler.task_resource_request",
      payload: {
        requestId: "r",
        workspaceId: "w",
        action: "acquire",
        role: "master",
        files: [".vibe/**", "PRODUCT-REQUIREMENTS.md"],
        hostLease: true,
      },
    });
    publishEvent(db, {
      type: "scheduler.task_resource_result",
      payload: {
        requestId: "r",
        workspaceId: "w",
        ok: false,
        reason: "文件正在使用",
        retryable: true,
      },
    });
    const events = readEvents(db, 0);
    expect(events[0]?.payload).toMatchObject({
      files: [".vibe/**", "PRODUCT-REQUIREMENTS.md"],
      hostLease: true,
    });
    expect(events[1]?.payload).toMatchObject({ retryable: true });
    db.close();
  });

  it("is idempotent per dedupeKey and returns the original seq", () => {
    const { db } = setup();
    const a = publishEvent(db, { type: "plan.updated", payload: { version: 1 }, dedupeKey: "k1" });
    const again = publishEvent(db, {
      type: "plan.updated",
      payload: { version: 99 },
      dedupeKey: "k1",
    });
    expect(again).toBe(a);
    expect(readEvents(db, 0)).toHaveLength(1);
    expect(readEvents(db, 0)[0]?.payload).toEqual({ version: 1 });
  });

  it("covers every documented event type with a payload schema", () => {
    expect([...EVENT_TYPES].sort()).toEqual(
      [
        "task.updated",
        "task.stop_requested",
        "task.stop_result",
        "task.fix_requested",
        "context.continuation_requested",
        "context.continuation_result",
        "scheduler.task_dispatch_wanted",
        "scheduler.task_admitted",
        "scheduler.task_resource_request",
        "scheduler.task_resource_result",
        "master.task_dispatch_chosen",
        "master.task_dispatch_failed",
        "card.created",
        "card.updated",
        "card.deleted",
        "card.moved",
        "card.review_requested",
        "card.assessed",
        "card.dispatched",
        "session.started",
        "session.waiting",
        "session.answered",
        "session.ended",
        "session.error",
        "session.switched",
        "session.compacted",
        "verification.started",
        "verification.finished",
        "verification.decision_requested",
        "maintenance.triggered",
        "maintenance.paused",
        "master.alert",
        "plan.updated",
        "scheduler.admitted",
        "scheduler.dispatch_failed",
        "scheduler.dispatch_wanted",
        "master.dispatch_chosen",
        "master.dispatch_failed",
        "scheduler.quota_low",
        "scheduler.paused",
        "scheduler.resumed",
        "session.stalled",
        "session.unstalled",
        "session.reassigned",
        "session.complexity_changed",
        "review.started",
        "review.finished",
        "scout.started",
        "scout.finished",
      ].sort(),
    );
  });

  it("parseEvent narrows by type", () => {
    const e = parseEvent({
      seq: 1,
      ts: "t",
      type: "card.moved",
      cardId: "c",
      projectId: "p",
      payload: { from: "draft", to: "todo", actor: "user" },
      dedupeKey: null,
    });
    expect(isEvent(e, "card.moved") && e.payload.to).toBe("todo");
    expect(() =>
      parseEvent({
        seq: 1,
        ts: "t",
        type: "x.y",
        cardId: null,
        projectId: null,
        payload: {},
        dedupeKey: null,
      }),
    ).toThrow(/Unknown/);
  });
});

describe("event consumer", () => {
  it("delivers each event once, in order, and persists the cursor", async () => {
    const { db } = setup();
    for (let i = 1; i <= 5; i++)
      publishEvent(db, { type: "plan.updated", payload: { version: i } });
    const seen: number[] = [];
    const c = createEventConsumer({ db, consumer: "a", handler: (e) => void seen.push(e.seq) });
    expect(await c.poll()).toBe(5);
    expect(await c.poll()).toBe(0);
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    expect(getCursor(db, "a")).toBe(5);

    // a restarted consumer (new instance, same name) resumes after the cursor: no redelivery
    publishEvent(db, { type: "plan.updated", payload: { version: 6 } });
    const seen2: number[] = [];
    const c2 = createEventConsumer({ db, consumer: "a", handler: (e) => void seen2.push(e.seq) });
    await c2.poll();
    expect(seen2).toEqual([6]);
  });

  it("keeps independent cursors per consumer", async () => {
    const { db } = setup();
    publishEvent(db, { type: "plan.updated", payload: { version: 1 } });
    const a: number[] = [];
    const b: number[] = [];
    await createEventConsumer({ db, consumer: "a", handler: (e) => void a.push(e.seq) }).poll();
    publishEvent(db, { type: "plan.updated", payload: { version: 2 } });
    await createEventConsumer({ db, consumer: "b", handler: (e) => void b.push(e.seq) }).poll();
    expect(a).toEqual([1]);
    expect(b).toEqual([1, 2]);
  });

  it("startAt=now skips history", async () => {
    const { db } = setup();
    publishEvent(db, { type: "plan.updated", payload: { version: 1 } });
    const seen: number[] = [];
    const c = createEventConsumer({
      db,
      consumer: "late",
      startAt: "now",
      handler: (e) => void seen.push(e.seq),
    });
    publishEvent(db, { type: "plan.updated", payload: { version: 2 } });
    await c.poll();
    expect(seen).toEqual([2]);
  });

  it("filters by type but still advances past other events", async () => {
    const { db } = setup();
    publishEvent(db, { type: "plan.updated", payload: { version: 1 } });
    publishEvent(db, { type: "card.deleted", payload: { key: "X-1" } });
    publishEvent(db, { type: "plan.updated", payload: { version: 2 } });
    publishEvent(db, { type: "card.deleted", payload: { key: "X-2" } });
    const seen: string[] = [];
    const c = createEventConsumer({
      db,
      consumer: "f",
      types: ["plan.updated"],
      handler: (e) => void seen.push(e.type),
    });
    expect(await c.poll()).toBe(2);
    expect(seen).toEqual(["plan.updated", "plan.updated"]);
    expect(getCursor(db, "f")).toBe(getMaxSeq(db));
  });

  it("retries a failing handler and does not skip the event", async () => {
    const { db } = setup();
    publishEvent(db, { type: "plan.updated", payload: { version: 1 } });
    publishEvent(db, { type: "plan.updated", payload: { version: 2 } });
    let failures = 2;
    const seen: number[] = [];
    const onError = vi.fn();
    const c = createEventConsumer({
      db,
      consumer: "r",
      onError,
      handler: (e) => {
        if (e.seq === 1 && failures-- > 0) throw new Error("transient");
        seen.push(e.seq);
      },
    });
    await c.poll();
    await c.poll();
    expect(seen).toEqual([]);
    await c.poll();
    expect(seen).toEqual([1, 2]);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(listDeadLetters(db)).toEqual([]);
  });

  it("dead-letters a poison event after maxAttempts so the stream moves on", async () => {
    const { db } = setup();
    publishEvent(db, { type: "plan.updated", payload: { version: 1 } });
    publishEvent(db, { type: "plan.updated", payload: { version: 2 } });
    const seen: number[] = [];
    const c = createEventConsumer({
      db,
      consumer: "p",
      maxAttempts: 3,
      handler: (e) => {
        if (e.seq === 1) throw new Error("poison");
        seen.push(e.seq);
      },
    });
    await c.poll();
    await c.poll();
    await c.poll();
    expect(seen).toEqual([2]);
    expect(listDeadLetters(db, "p")).toMatchObject([{ consumer: "p", seq: 1, error: "poison" }]);
  });

  it("handles async handlers and never runs two polls at once", async () => {
    const { db } = setup();
    for (let i = 1; i <= 3; i++)
      publishEvent(db, { type: "plan.updated", payload: { version: i } });
    let active = 0;
    let maxActive = 0;
    const seen: number[] = [];
    const c = createEventConsumer({
      db,
      consumer: "async",
      handler: async (e) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        seen.push(e.seq);
        active--;
      },
    });
    const [x, y] = await Promise.all([c.poll(), c.poll()]);
    expect(x).toBe(y);
    expect(maxActive).toBe(1);
    expect(seen).toEqual([1, 2, 3]);
  });

  it("start() polls on a timer and stop() waits for in-flight work", async () => {
    const { db } = setup();
    const seen: number[] = [];
    const c = createEventConsumer({
      db,
      consumer: "timer",
      pollIntervalMs: 10,
      handler: (e) => void seen.push(e.seq),
    });
    c.start();
    publishEvent(db, { type: "plan.updated", payload: { version: 1 } });
    await vi.waitFor(() => expect(seen).toEqual([1]));
    await c.stop();
    publishEvent(db, { type: "plan.updated", payload: { version: 2 } });
    await new Promise((r) => setTimeout(r, 40));
    expect(seen).toEqual([1]);
  });

  it("receives the events the command layer emits, with typed payloads", async () => {
    const { db, store } = setup();
    const p = store.projects.create({ name: "n", prefix: "Q", repoPath: "r" });
    const card = store.cards.create({ projectId: p.id, title: "t" });
    store.cards.move(card.id, { to: "todo", actor: "user" });
    const moved: VibeEvent[] = [];
    await createEventConsumer({
      db,
      consumer: "cmd",
      types: ["card.moved"],
      handler: (e) => void moved.push(e),
    }).poll();
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({
      cardId: card.id,
      projectId: p.id,
      payload: { from: "draft", to: "todo" },
    });
  });

  it("a command that fails publishes nothing (event and state share one transaction)", () => {
    const { db, store } = setup();
    const p = store.projects.create({ name: "n", prefix: "Q", repoPath: "r" });
    const before = getMaxSeq(db);
    expect(() =>
      store.cards.create({ projectId: p.id, title: "t", tagIds: ["missing-tag"] }),
    ).toThrow();
    expect(getMaxSeq(db)).toBe(before);
    expect(store.cards.list()).toEqual([]);
    expect(store.projects.get(p.id)?.nextNumber).toBe(1);
  });
});

describe("retention and cursors", () => {
  it("never rewinds a cursor", () => {
    const { db } = setup();
    advanceCursor(db, "c", 10);
    advanceCursor(db, "c", 4);
    expect(getCursor(db, "c")).toBe(10);
  });

  it("prunes only old events every consumer has passed", () => {
    const { db } = setup();
    for (let i = 1; i <= 4; i++) {
      publishEvent(db, {
        type: "plan.updated",
        payload: { version: i },
        ts: `2026-01-0${i}T00:00:00.000Z`,
      });
    }
    advanceCursor(db, "slow", 2);
    advanceCursor(db, "fast", 4);
    expect(pruneEvents(db, "2026-01-10T00:00:00.000Z")).toBe(2);
    expect(readEvents(db, 0).map((e) => e.seq)).toEqual([3, 4]);
    expect(pruneEvents(db, "2026-01-02T00:00:00.000Z")).toBe(0);
  });
});

describe("concurrent writers (separate processes)", () => {
  it("assign unique seqs, honour dedupe keys and lose nothing", async () => {
    const { db, path } = setup();
    db.close();
    const workers = 5;
    const per = 20;
    const runs = await Promise.all(
      Array.from({ length: workers }, () => runWorker(["events", path, String(per)])),
    );
    for (const r of runs) expect(r, r.stderr).toMatchObject({ code: 0 });

    const check = openVibeDb({ path });
    const events = readEvents(check, 0, { limit: 10_000 });
    expect(events).toHaveLength(workers * per);
    const seqs = events.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    check.close();
  });

  it("command-layer writes from several processes keep keys, HLCs and events consistent", async () => {
    const { db, path, store } = setup();
    const project = store.projects.create({ name: "n", prefix: "CC", repoPath: "r" });
    db.close();
    const workers = 4;
    const per = 10;
    const runs = await Promise.all(
      Array.from({ length: workers }, () => runWorker(["cards", path, project.id, String(per)])),
    );
    for (const r of runs) expect(r, r.stderr).toMatchObject({ code: 0 });

    const check = openVibeDb({ path });
    const reader = createVibeStore(check);
    const cards = reader.cards.list({ projectId: project.id });
    expect(cards).toHaveLength(workers * per);
    expect(new Set(cards.map((c) => c.key)).size).toBe(workers * per);
    expect(cards.map((c) => c.number).sort((a, b) => a - b)).toEqual(
      Array.from({ length: workers * per }, (_, i) => i + 1),
    );
    // every card's last write got its own HLC (monotonic sequence shared through the db)
    expect(new Set(cards.map((c) => c.updatedHlc)).size).toBe(cards.length);
    expect(new Set(cards.map((c) => c.sortKey)).size).toBe(cards.length);
    const created = readEvents(check, 0, { limit: 10_000 }).filter(
      (e) => e.type === "card.created",
    );
    expect(created).toHaveLength(workers * per);
    expect(reader.projects.get(project.id)?.nextNumber).toBe(workers * per + 1);
    check.close();
  });
});
