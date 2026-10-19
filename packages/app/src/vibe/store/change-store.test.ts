import { describe, expect, it } from "vitest";
import { MemoryChangeStore, applyChange, type FieldChange } from "../generated/sync";
import { SqliteChangeStore, LOCAL_SCHEMA } from "./change-store";
import { createTestDb } from "./test-db";

const field = (
  rowId: string,
  column: string,
  value: FieldChange["value"],
  hlc: string,
): FieldChange => ({
  kind: "field",
  table: "card",
  rowId,
  column,
  value,
  hlc,
});
const hlc = (n: number) => `${n.toString(16).padStart(12, "0")}-0000-dev`;

function open() {
  const db = createTestDb();
  db.exec(LOCAL_SCHEMA);
  return { db, store: new SqliteChangeStore(db) };
}

describe("SqliteChangeStore", () => {
  it("behaves like the in-memory store for the merge algorithm", () => {
    const { store } = open();
    const memory = new MemoryChangeStore();
    const changes = [
      field("a", "title", "first", hlc(1)),
      field("a", "title", "second", hlc(3)),
      field("a", "title", "stale", hlc(2)),
      field("b", "title", "kept", hlc(4)),
      { kind: "delete" as const, table: "card", rowId: "b", hlc: hlc(5) },
      field("b", "title", "after delete", hlc(6)),
    ];
    const outcomes = changes.map((c) => applyChange(store, c));
    expect(outcomes).toEqual(changes.map((c) => applyChange(memory, c)));
    expect(store.rowFields("card", "a").title?.value).toBe("second");
    expect(store.rowIds("card")).toEqual(["a"]);
    expect(store.getTombstone("card", "b")).toBe(hlc(5));
  });

  it("pages changes by arrival seq", () => {
    const { store } = open();
    for (let i = 0; i < 5; i++) store.putField(field(`r${i}`, "title", `t${i}`, hlc(i + 1)));
    const first = store.changesSince(0, 2);
    expect(first.changes).toHaveLength(2);
    expect(first.more).toBe(true);
    const rest = store.changesSince(first.cursor);
    expect(rest.changes.map((c) => c.rowId)).toEqual(["r2", "r3", "r4"]);
    expect(rest.more).toBe(false);
    expect(store.changesSince(rest.cursor).changes).toEqual([]);
  });

  it("survives a reopen and keeps counting seq", () => {
    const { db, store } = open();
    store.putField(field("a", "title", "x", hlc(1)));
    store.putTombstone({ kind: "delete", table: "card", rowId: "z", hlc: hlc(2) });
    const reopened = new SqliteChangeStore(db);
    expect(reopened.cursor).toBe(2);
    expect(reopened.getField("card", "a", "title")?.value).toBe("x");
    reopened.putField(field("a", "title", "y", hlc(3)));
    expect(reopened.cursor).toBe(3);
  });

  it("clear wipes fields and tombstones", () => {
    const { store } = open();
    store.putField(field("a", "title", "x", hlc(1)));
    store.putTombstone({ kind: "delete", table: "card", rowId: "z", hlc: hlc(2) });
    store.clear();
    expect(store.rowIds("card")).toEqual([]);
    expect(store.getTombstone("card", "z")).toBeUndefined();
  });
});
