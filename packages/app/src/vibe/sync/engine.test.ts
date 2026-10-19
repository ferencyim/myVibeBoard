import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalVibeRpc } from "../rpc/local-rpc";
import { LocalReplica } from "../store/replica";
import { createTestDb } from "../store/test-db";
import { createSyncEngine } from "./engine";
import { createFakeDaemon, seedBoard } from "./test-daemon";

function setup(now: () => number = Date.now) {
  const daemon = createFakeDaemon(now);
  seedBoard(daemon);
  const db = createTestDb();
  const replica = LocalReplica.open(db, { now });
  const engine = createSyncEngine({ replica, invoke: (m, i) => daemon.invoke(m, i) });
  const rpc = createLocalVibeRpc(replica, { now });
  return { daemon, db, replica, engine, rpc };
}

describe("sync engine", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("takes a snapshot on first contact and answers from it", async () => {
    const { engine, rpc } = setup();
    expect((await engine.run()).ok).toBe(true);
    const { cards } = (await rpc.invoke("vibe.cards.list", {})) as {
      cards: Array<{ key: string }>;
    };
    expect(cards.map((c) => c.key)).toEqual(["ALP-1", "ALP-2", "ALP-3", "ALP-4"]);
  });

  it("sends offline edits on the next exchange and keeps them across a restart", async () => {
    const { daemon, db, replica, engine, rpc } = setup();
    await engine.run();

    await rpc.invoke("vibe.cards.update", { card: "ALP-1", title: "Renamed offline" });
    const created = (await rpc.invoke("vibe.cards.create", {
      project: "ALP",
      title: "Made offline",
    })) as { card: { id: string } };
    expect(replica.hasPending).toBe(true);

    // App killed and restarted: the outbox comes back from the database.
    const restarted = LocalReplica.open(db);
    expect(restarted.sync.pending.length).toBe(replica.sync.pending.length);
    const engine2 = createSyncEngine({ replica: restarted, invoke: (m, i) => daemon.invoke(m, i) });
    expect((await engine2.run()).ok).toBe(true);

    expect(restarted.hasPending).toBe(false);
    expect(daemon.node.readRow("card", "C1")?.values.title).toBe("Renamed offline");
    expect(daemon.node.readRow("card", created.card.id)?.values).toMatchObject({
      title: "Made offline",
      project_id: "P1",
      column: "draft",
    });
  });

  it("applies the daemon value when a phone move is refused", async () => {
    const { daemon, replica, engine, rpc } = setup();
    await engine.run();
    await rpc.invoke("vibe.cards.move", { card: "ALP-2", to: "draft" });
    // Meanwhile the dispatcher started the card on the computer.
    daemon.publish("card", "C2", { column: "in_progress" });
    const result = await engine.run();
    expect(result.rejected.map((r) => r.reason)).toContain("column_locked");
    const { card } = (await rpc.invoke("vibe.cards.get", { card: "ALP-2" })) as {
      card: { column: string };
    };
    expect(card.column).toBe("in_progress");
    expect(replica.hasPending).toBe(false);
  });

  it("keeps the outbox when the daemon is unreachable, then delivers it", async () => {
    const { daemon, replica, engine, rpc } = setup();
    await engine.run();
    await rpc.invoke("vibe.events.add", { card: "ALP-2", text: "remember this" });
    const down = createSyncEngine({
      replica,
      invoke: () => Promise.reject(new Error("socket closed")),
    });
    expect((await down.run()).ok).toBe(false);
    expect(replica.hasPending).toBe(true);
    expect((await engine.run()).ok).toBe(true);
    const events = daemon.node.listRows("card_event").filter((r) => r.values.card_id === "C2");
    expect(events).toHaveLength(1);
  });

  it("corrects a badly wrong phone clock and still delivers", async () => {
    let skew = 0;
    const base = Date.now();
    let daemonTime = base;
    const daemon = createFakeDaemon(() => (daemonTime += 5));
    seedBoard(daemon);
    const now = () => base + skew;
    const replica = LocalReplica.open(createTestDb(), { now });
    const engine = createSyncEngine({ replica, invoke: (m, i) => daemon.invoke(m, i) });
    const rpc = createLocalVibeRpc(replica, { now });
    await engine.run();
    skew = -3 * 24 * 60 * 60 * 1000;
    await rpc.invoke("vibe.cards.update", { card: "ALP-1", title: "Clock was off" });
    expect((await engine.run()).ok).toBe(true);
    expect(daemon.node.readRow("card", "C1")?.values.title).toBe("Clock was off");
  });

  it("flushes pending replies only for questions that are still open", async () => {
    const { replica, daemon } = setup();
    replica.replies.enqueue({ id: "r1", cardId: "C3", questionId: "q-open", text: "yes", now: 1 });
    replica.replies.enqueue({ id: "r2", cardId: "C3", questionId: "q-gone", text: "no", now: 2 });
    const sent: string[] = [];
    const engine = createSyncEngine({
      replica,
      invoke: async (method, input) => {
        const body = input as { id: string; questionId: string };
        if (method === "vibe.reply.check") {
          return { state: body.questionId === "q-open" ? "pending" : "gone" };
        }
        if (method === "vibe.reply.send") {
          sent.push(body.id);
          return { sent: true, duplicate: false };
        }
        return daemon.invoke(method, input);
      },
    });
    const result = await engine.run();
    expect(result.replies).toMatchObject({ sent: ["r1"], stale: ["r2"], failed: [] });
    expect(sent).toEqual(["r1"]);
    const reopened = LocalReplica.open(replica.db);
    expect(reopened.replies.list("sent").map((r) => r.id)).toEqual(["r1"]);
    expect(reopened.replies.list("stale").map((r) => r.id)).toEqual(["r2"]);
  });
});
