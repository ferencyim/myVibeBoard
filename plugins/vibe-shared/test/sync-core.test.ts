import { describe, expect, it } from "vitest";
import { compareHlc, formatHlc, parseHlc } from "../contract/hlc";
import {
  HlcClock,
  HlcDriftError,
  MemoryChangeStore,
  ROW_MARKER,
  SyncNode,
  applyChange,
  compareByOrder,
  evenSortKeys,
  generateSortKey,
  needsRebalance,
  readRow,
  rebalanceSortKeys,
  receiveHlc,
  snapshotState,
  type Change,
} from "../sync";
import { makeRng } from "./sync-helpers";

const HOUR = 3_600_000;

describe("HLC receive / clock", () => {
  it("receive is greater than both inputs, also with equal walls and counters", () => {
    const a = formatHlc({ wall: 1000, counter: 5, node: "a" });
    const b = formatHlc({ wall: 1000, counter: 9, node: "b" });
    const r = receiveHlc(a, b, 1000, "a");
    expect(compareHlc(r, a)).toBeGreaterThan(0);
    expect(compareHlc(r, b)).toBeGreaterThan(0);
    expect(parseHlc(r)).toMatchObject({ wall: 1000, counter: 10 });
    // physical time ahead of everything resets the counter
    expect(parseHlc(receiveHlc(a, b, 5000, "a"))).toMatchObject({ wall: 5000, counter: 0 });
    // remote wall ahead of us and of physical time
    const far = formatHlc({ wall: 2000, counter: 3, node: "b" });
    expect(parseHlc(receiveHlc(a, far, 1000, "a"))).toMatchObject({ wall: 2000, counter: 4 });
  });

  it("rejects a remote clock too far in the future, accepts within the limit", () => {
    const remote = formatHlc({ wall: 1000 + 2 * HOUR, counter: 0, node: "b" });
    expect(() => receiveHlc(null, remote, 1000, "a", HOUR)).toThrow(HlcDriftError);
    expect(() => receiveHlc(null, remote, 1000, "a", 3 * HOUR)).not.toThrow();
  });

  it("clock stays monotonic when physical time goes backwards, and persists via onAdvance", () => {
    let now = 10_000;
    const seen: string[] = [];
    const clock = new HlcClock({ node: "a", now: () => now, onAdvance: (h) => seen.push(h) });
    const h1 = clock.tick();
    now = 5_000;
    const h2 = clock.tick();
    expect(compareHlc(h2, h1)).toBeGreaterThan(0);
    expect(seen).toEqual([h1, h2]);
    const restarted = new HlcClock({ node: "a", now: () => 1, last: h2 });
    expect(compareHlc(restarted.tick(), h2)).toBeGreaterThan(0);
  });

  it("correct() re-bases a wrong clock", () => {
    let now = 1_000_000;
    const clock = new HlcClock({ node: "a", now: () => now });
    clock.tick();
    clock.correct(500_000);
    expect(parseHlc(clock.tick()).wall).toBe(500_000);
  });
});

describe("field-level LWW and tombstones", () => {
  const field = (hlc: string, value: string, column = "title", rowId = "c1"): Change => ({
    kind: "field",
    table: "card",
    rowId,
    column,
    value,
    hlc,
  });
  const h = (wall: number, node = "a") => formatHlc({ wall, counter: 0, node });

  it("merges per field, not per row", () => {
    const s = new MemoryChangeStore();
    applyChange(s, field(h(10), "A-title"));
    applyChange(s, field(h(20), "B-desc", "description"));
    applyChange(s, field(h(15, "b"), "B-title"));
    applyChange(s, field(h(5, "b"), "old-desc", "description"));
    expect(readRow(s, "card", "c1")?.values).toEqual({ title: "B-title", description: "B-desc" });
  });

  it("is idempotent and order independent", () => {
    const changes = [field(h(10), "x"), field(h(30, "b"), "y"), field(h(20), "z")];
    const a = new MemoryChangeStore();
    const b = new MemoryChangeStore();
    for (const c of changes) applyChange(a, c);
    for (const c of [...changes].reverse()) {
      applyChange(b, c);
      expect(applyChange(b, c)).toBe("stale");
    }
    expect(snapshotState(a, ["card"])).toBe(snapshotState(b, ["card"]));
  });

  it("a tombstone is permanent: older and newer edits of a deleted row never resurrect it", () => {
    const s = new MemoryChangeStore();
    applyChange(s, field(h(10), "x"));
    applyChange(s, { kind: "delete", table: "card", rowId: "c1", hlc: h(20) });
    expect(readRow(s, "card", "c1")).toBeUndefined();
    expect(applyChange(s, field(h(15), "late-older"))).toBe("ignored");
    expect(applyChange(s, field(h(99), "late-newer"))).toBe("ignored");
    expect(readRow(s, "card", "c1")).toBeUndefined();
    expect(s.rowFields("card", "c1")).toEqual({});
  });

  it("delete arriving before the row's fields gives the same result", () => {
    const a = new MemoryChangeStore();
    const b = new MemoryChangeStore();
    const del: Change = { kind: "delete", table: "card", rowId: "c1", hlc: h(20) };
    applyChange(a, field(h(10), "x"));
    applyChange(a, del);
    applyChange(b, del);
    applyChange(b, field(h(10), "x"));
    expect(snapshotState(a, ["card"])).toBe(snapshotState(b, ["card"]));
  });

  it("membership rows (card_tag) can be removed and re-added; stale re-adds lose", () => {
    const s = new MemoryChangeStore();
    const add = (wall: number): Change => ({
      kind: "field",
      table: "card_tag",
      rowId: "c1:t1",
      column: ROW_MARKER,
      value: true,
      hlc: h(wall),
    });
    applyChange(s, add(10));
    applyChange(s, { kind: "delete", table: "card_tag", rowId: "c1:t1", hlc: h(20) });
    expect(readRow(s, "card_tag", "c1:t1")).toBeUndefined();
    applyChange(s, add(15)); // concurrent older add: tombstone wins
    expect(readRow(s, "card_tag", "c1:t1")).toBeUndefined();
    applyChange(s, add(30)); // later re-add wins
    expect(readRow(s, "card_tag", "c1:t1")).toBeDefined();
  });

  it("SyncNode: local writes stamp increasing HLCs, publishFields only emits differences", () => {
    const node = new SyncNode({ deviceId: "d", store: new MemoryChangeStore(), now: () => 1000 });
    const first = node.publishFields("agent_session", "s1", { state: "running", title: "t" });
    expect(first).toHaveLength(2);
    expect(node.publishFields("agent_session", "s1", { state: "running", title: "t" })).toEqual([]);
    const next = node.publishFields("agent_session", "s1", { state: "waiting", title: "t" });
    expect(next.map((c) => c.column)).toEqual(["state"]);
    expect(compareHlc(next[0]!.hlc, first[1]!.hlc)).toBeGreaterThan(0);
  });
});

describe("sort keys", () => {
  it("generated keys are strictly between neighbours, never end in 0", () => {
    const rnd = makeRng(1);
    let keys: string[] = [];
    for (let i = 0; i < 400; i++) {
      const pos = Math.floor(rnd() * (keys.length + 1));
      const k = generateSortKey(keys[pos - 1] ?? null, keys[pos] ?? null, { random: rnd });
      if (pos > 0) expect(k > (keys[pos - 1] as string)).toBe(true);
      if (pos < keys.length) expect(k < (keys[pos] as string)).toBe(true);
      expect(k.endsWith("0")).toBe(false);
      keys.splice(pos, 0, k);
      if (keys.some((x) => needsRebalance(x))) {
        keys = evenSortKeys(keys.length);
      }
    }
    expect(keys).toEqual([...keys].sort());
    expect(Math.max(...keys.map((k) => k.length))).toBeLessThanOrEqual(24);
  });

  it("worst case (always insert at the same spot) stays bounded thanks to rebalancing", () => {
    let keys = evenSortKeys(5);
    let rebalances = 0;
    for (let i = 0; i < 300; i++) {
      const k = generateSortKey(keys[0] as string, keys[1] as string, { random: makeRng(i) });
      keys.splice(1, 0, k);
      if (needsRebalance(k)) {
        keys = evenSortKeys(keys.length);
        rebalances++;
      }
    }
    expect(keys).toEqual([...keys].sort());
    expect(Math.max(...keys.map((k) => k.length))).toBeLessThanOrEqual(24);
    expect(rebalances).toBeGreaterThan(0);
  });

  it("duplicate neighbours do not throw: the key goes after prev", () => {
    const k = generateSortKey("m5", "m5", { random: makeRng(3) });
    expect(k > "m5").toBe(true);
  });

  it("evenSortKeys / rebalanceSortKeys are ordered, equal length, preserve list order", () => {
    for (const n of [1, 2, 35, 36, 37, 500]) {
      const ks = evenSortKeys(n);
      expect(ks).toHaveLength(n);
      expect(ks).toEqual([...ks].sort());
      expect(new Set(ks).size).toBe(n);
      expect(ks.every((k) => !k.endsWith("0") && k.length === ks[0]!.length)).toBe(true);
    }
    const m = rebalanceSortKeys(["c", "a", "b"]);
    expect(m.get("c")! < m.get("a")! && m.get("a")! < m.get("b")!).toBe(true);
  });

  it("concurrent inserts between the same neighbours order identically on every replica", () => {
    const a = "m";
    const b = "n";
    const inserted = [1, 2, 3, 4, 5].map((i) => ({
      id: `card-${i}`,
      sortKey: generateSortKey(a, b, { random: makeRng(100 + i) }),
    }));
    const one = [...inserted].sort(compareByOrder).map((x) => x.id);
    const two = [...inserted].reverse().sort(compareByOrder).map((x) => x.id);
    expect(one).toEqual(two);
    expect(inserted.every((x) => x.sortKey > a && x.sortKey < b)).toBe(true);
    expect(new Set(inserted.map((x) => x.sortKey)).size).toBe(5); // jitter avoids collisions
    // identical keys still order deterministically by id
    expect(
      [
        { id: "b", sortKey: "x" },
        { id: "a", sortKey: "x" },
      ]
        .sort(compareByOrder)
        .map((x) => x.id),
    ).toEqual(["a", "b"]);
  });
});
