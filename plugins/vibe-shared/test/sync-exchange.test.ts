import { describe, expect, it } from "vitest";
import {
  PendingReplyQueue,
  serveExchange,
  snapshotState,
  type ExchangeRequest,
  type ExchangeResponse,
} from "../sync";
import { World } from "./sync-helpers";

const HOUR = 3_600_000;
const card = (i: number) => `card-${String(i).padStart(2, "0")}`;

function seedCards(w: World, n: number) {
  for (let i = 0; i < n; i++) {
    w.server.writeFields("card", card(i), {
      title: `T${i}`,
      description: `D${i}`,
      column: "todo",
      sort_key: `k${String(i).padStart(2, "0")}`,
      priority: 1,
    });
  }
}

describe("exchange", () => {
  it("first contact is a snapshot, later exchanges are increments (read-only tables included)", async () => {
    const w = new World();
    const p = w.addPhone("phone-a");
    seedCards(w, 3);
    w.server.publishFields("agent_session", "s1", { state: "running", card_id: card(0) });
    const first = await p.sync(w.transport);
    expect(first.rejected).toEqual([]);
    expect(p.node.listRows("card")).toHaveLength(3);
    expect(p.node.readRow("agent_session", "s1")?.values.state).toBe("running");

    w.server.publishFields("agent_session", "s1", { state: "waiting", card_id: card(0) });
    const req = p.buildRequest();
    const resp = serveExchange(w.server, req);
    expect(resp.ok && !resp.snapshot).toBe(true);
    expect(resp.ok && resp.changes.map((c) => c.kind === "field" && c.column)).toEqual(["state"]);
  });

  it("a changed epoch or compacted history forces a snapshot that drops rows deleted meanwhile", async () => {
    const w = new World();
    const p = w.addPhone("phone-a");
    seedCards(w, 3);
    await p.sync(w.transport);
    w.server.deleteRow("card", card(1));
    w.server.store.compactTombstones(w.server.store.cursor);
    await p.sync(w.transport);
    expect(p.node.readRow("card", card(1))).toBeUndefined();
    expect(snapshotState(p.node.store, ["card"])).toBe(snapshotState(w.server.store, ["card"]));
  });

  it("pagination delivers everything", async () => {
    const w = new World();
    const p = w.addPhone("phone-a");
    seedCards(w, 40);
    await p.sync(w.transport, { limit: 7 });
    expect(p.node.listRows("card")).toHaveLength(40);
    expect(snapshotState(p.node.store, ["card"])).toBe(snapshotState(w.server.store, ["card"]));
  });

  it("offline edit of 20 cards reconnects with zero loss, daemon wins locked columns", async () => {
    const w = new World();
    const p = w.addPhone("phone-a", 30 * 60_000);
    seedCards(w, 30);
    await p.sync(w.transport);

    // phone offline: edits 20 cards
    for (let i = 0; i < 20; i++) {
      w.t += 1000;
      p.write("card", card(i), { title: `phone-${i}`, priority: 5, sort_key: `p${i}` });
      if (i % 2 === 0) p.write("card", card(i), { column: "draft" });
    }
    // meanwhile the daemon edits other fields and starts some cards
    for (let i = 0; i < 10; i++) {
      w.t += 1000;
      w.server.writeFields("card", card(i), { description: `daemon-${i}` });
    }
    for (let i = 4; i < 8; i++) w.server.writeFields("card", card(i), { column: "in_progress" });

    const out = await p.sync(w.transport);
    await p.sync(w.transport);
    for (let i = 0; i < 20; i++) {
      const s = w.server.readRow("card", card(i))!.values;
      expect(s.title).toBe(`phone-${i}`);
      expect(s.priority).toBe(5);
      expect(s.description).toBe(i < 10 ? `daemon-${i}` : `D${i}`);
      const locked = i >= 4 && i < 8;
      expect(s.column).toBe(locked ? "in_progress" : i % 2 === 0 ? "draft" : "todo");
      expect(s.sort_key).toBe(locked ? `k${String(i).padStart(2, "0")}` : `p${i}`);
    }
    // the phone saw the authoritative values and was told about the rejections
    expect(out.rejected.map((r) => r.reason)).toContain("column_locked");
    expect(snapshotState(p.node.store, ["card"])).toBe(snapshotState(w.server.store, ["card"]));
    expect(p.pending).toEqual([]);
  });

  it("rejects phone writes to read-only tables, unknown fields and non-phone columns on create", () => {
    const w = new World();
    const p = w.addPhone("phone-a");
    expect(() => p.write("agent_session", "s1", { state: "x" })).toThrow();
    expect(() => p.write("card", card(0), { nope: 1 })).toThrow();
    // forged request bypassing the client-side guard
    const forged = w.addPhone("phone-b");
    forged.node.writeFields("agent_session", "s1", { state: "hacked" });
    forged.node.writeFields("card", card(9), { title: "x", column: "done" });
    const req: ExchangeRequest = {
      ...forged.buildRequest(),
      changes: [
        ...forged.node.store.changesSince(0).changes,
      ],
    };
    const resp = serveExchange(w.server, req) as Extract<ExchangeResponse, { ok: true }>;
    expect(resp.rejected.map((r) => r.reason).sort()).toEqual(["column_locked", "read_only"]);
    expect(w.server.readRow("agent_session", "s1")).toBeUndefined();
    expect(w.server.readRow("card", card(9))?.values).toEqual({ title: "x", column: "draft" });
  });

  it("a phone cannot delete a running card; its local delete is undone", async () => {
    const w = new World();
    const p = w.addPhone("phone-a");
    seedCards(w, 2);
    await p.sync(w.transport);
    w.server.writeFields("card", card(0), { column: "in_progress" });
    p.remove("card", card(0)); // offline, still thinks it is a todo
    p.remove("card", card(1)); // allowed
    const out = await p.sync(w.transport);
    expect(out.rejected.map((r) => r.reason)).toEqual(["column_locked"]);
    expect(p.node.readRow("card", card(0))?.values.column).toBe("in_progress");
    expect(p.node.readRow("card", card(1))).toBeUndefined();
    expect(w.server.readRow("card", card(1))).toBeUndefined();
    expect(snapshotState(p.node.store, ["card"])).toBe(snapshotState(w.server.store, ["card"]));
  });

  it("deleted cards stay deleted when an offline phone edits them later", async () => {
    const w = new World();
    const a = w.addPhone("phone-a");
    const b = w.addPhone("phone-b", HOUR);
    seedCards(w, 1);
    await a.sync(w.transport);
    await b.sync(w.transport);
    a.remove("card", card(0));
    w.t += 5000;
    b.write("card", card(0), { title: "edited after delete, clock +1h" });
    await a.sync(w.transport);
    await b.sync(w.transport);
    await a.sync(w.transport);
    for (const n of [w.server, a.node, b.node]) expect(n.readRow("card", card(0))).toBeUndefined();
  });

  it("tags: remove + re-add through different phones converges", async () => {
    const w = new World();
    const a = w.addPhone("phone-a");
    const b = w.addPhone("phone-b");
    seedCards(w, 1);
    await w.syncAll();
    a.write("card_tag", `${card(0)}:t1`, {});
    await w.syncAll();
    b.remove("card_tag", `${card(0)}:t1`);
    await w.syncAll();
    w.t += 1000;
    a.write("card_tag", `${card(0)}:t1`, {});
    await w.syncAll();
    await w.syncAll();
    for (const n of [w.server, a.node, b.node]) {
      expect(n.readRow("card_tag", `${card(0)}:t1`)).toBeDefined();
    }
  });
});

describe("clock drift", () => {
  it("+-1h skew is tolerated", async () => {
    const w = new World();
    const ahead = w.addPhone("ahead", HOUR);
    const behind = w.addPhone("behind", -HOUR);
    seedCards(w, 1);
    ahead.write("card", card(0), { title: "ahead" });
    behind.write("card", card(0), { acceptance: "behind" });
    await w.syncAll();
    await w.syncAll();
    expect(w.server.readRow("card", card(0))?.values).toMatchObject({ title: "ahead", acceptance: "behind" });
  });

  it("a phone far outside the limit is told the real time, re-stamps unsent writes and succeeds", async () => {
    const w = new World();
    const bad = w.addPhone("bad", 3 * 24 * HOUR);
    const good = w.addPhone("good");
    seedCards(w, 1);
    await good.sync(w.transport);
    bad.write("card", card(0), { title: "from the future 1" });
    bad.write("card", card(0), { title: "from the future 2", description: "d" });
    w.t += 1000;
    await bad.sync(w.transport);
    // the server clock was not poisoned and the write landed with a sane HLC
    expect(w.server.readRow("card", card(0))?.values.title).toBe("from the future 2");
    w.t += 1000;
    good.write("card", card(0), { title: "good wins later" });
    await good.sync(w.transport);
    await bad.sync(w.transport);
    expect(bad.node.readRow("card", card(0))?.values.title).toBe("good wins later");
  });
});

describe("pending replies", () => {
  const mk = () => {
    const q = new PendingReplyQueue();
    q.enqueue({ id: "r1", cardId: "c1", questionId: "q1", text: "yes", now: 1 });
    q.enqueue({ id: "r2", cardId: "c2", questionId: "q2", text: "no", now: 2 });
    q.enqueue({ id: "r3", cardId: "c3", questionId: "q3", text: "maybe", now: 3 });
    return q;
  };

  it("only sends replies whose question is still pending", async () => {
    const q = mk();
    const sent: string[] = [];
    const res = await q.flush({
      check: async (r) => (r.questionId === "q1" ? "pending" : r.questionId === "q2" ? "answered" : "gone"),
      send: async (r) => void sent.push(r.id),
    });
    expect(res).toEqual({ sent: ["r1"], stale: ["r2", "r3"], failed: [] });
    expect(sent).toEqual(["r1"]);
    expect(q.list("stale").map((r) => r.staleReason)).toEqual(["already_answered", "question_gone"]);
    expect(q.list("pending")).toEqual([]);
  });

  it("failures keep the reply pending and re-check before the retry", async () => {
    const q = mk();
    let checks = 0;
    const r1 = await q.flush({
      check: async () => {
        checks++;
        return "pending";
      },
      send: async (r) => {
        if (r.id === "r2") throw new Error("offline again");
      },
    });
    expect(r1).toEqual({ sent: ["r1", "r3"], stale: [], failed: ["r2"] });
    expect(q.list("pending").map((r) => r.id)).toEqual(["r2"]);
    const r2 = await q.flush({ check: async () => "answered", send: async () => {} });
    expect(r2.stale).toEqual(["r2"]);
    expect(checks).toBe(3);
  });

  it("editing, cancelling and restoring from persisted JSON", () => {
    const q = mk();
    q.enqueue({ id: "r1b", cardId: "c1", questionId: "q1", text: "edited", now: 9 });
    expect(q.list().find((r) => r.id === "r1")?.text).toBe("edited");
    expect(q.list()).toHaveLength(3); // no duplicate for the same question
    expect(q.cancel("r2")).toBe(true);
    q.resolveCheck("r3", "pending"); // simulate crash while sending
    const restored = new PendingReplyQueue(JSON.parse(JSON.stringify(q.toJSON())));
    expect(restored.list("pending").map((r) => r.id)).toEqual(["r1", "r3"]); // "sending" -> re-verified
    expect(restored.list("cancelled").map((r) => r.id)).toEqual(["r2"]);
  });
});
