// Field-level LWW merge with tombstones.
//
//   * Field: the write with the greater HLC wins (HLC order is total: wall, counter, node).
//   * Delete: tombstones are permanent for single-id tables (ULIDs are never reused), so a late
//     offline edit of a deleted row can never resurrect it. Tables with a composite pk (card_tag:
//     membership that can be removed and re-added) are resurrectable: the row is alive iff its
//     existence marker (ROW_MARKER) is newer than the tombstone.
//   * applyChange is commutative, associative and idempotent, so any delivery order / duplication
//     converges.

import { compareHlc } from "../contract/hlc";
import { syncSpec } from "../contract/sync-spec";
import type { ChangeStore } from "./store";
import { ROW_MARKER, type ApplyResult, type Change, type JsonValue } from "./types";

/** Composite-pk (membership) tables can be re-added after removal; everything else cannot. */
export function isResurrectable(table: string): boolean {
  const spec = syncSpec(table);
  return !!spec && spec.pk.length > 1;
}

export function applyChange(store: ChangeStore, c: Change): ApplyResult {
  if (c.kind === "delete") {
    const cur = store.getTombstone(c.table, c.rowId);
    if (cur !== undefined && compareHlc(c.hlc, cur) <= 0) return "stale";
    store.putTombstone(c);
    if (!isResurrectable(c.table)) store.dropRowFields(c.table, c.rowId);
    return "applied";
  }
  if (!isResurrectable(c.table) && store.getTombstone(c.table, c.rowId) !== undefined) {
    return "ignored";
  }
  const cur = store.getField(c.table, c.rowId, c.column);
  if (cur && compareHlc(c.hlc, cur.hlc) <= 0) return "stale";
  store.putField(c);
  return "applied";
}

export interface RowView {
  rowId: string;
  values: Record<string, JsonValue>;
}

export function isRowAlive(store: ChangeStore, table: string, rowId: string): boolean {
  const tomb = store.getTombstone(table, rowId);
  if (isResurrectable(table)) {
    const marker = store.getField(table, rowId, ROW_MARKER);
    return !!marker && (tomb === undefined || compareHlc(marker.hlc, tomb) > 0);
  }
  if (tomb !== undefined) return false;
  return Object.keys(store.rowFields(table, rowId)).length > 0;
}

/** Materialized row, or undefined when it does not exist / was deleted. */
export function readRow(store: ChangeStore, table: string, rowId: string): RowView | undefined {
  if (!isRowAlive(store, table, rowId)) return undefined;
  const values: Record<string, JsonValue> = {};
  for (const [col, f] of Object.entries(store.rowFields(table, rowId))) {
    if (col !== ROW_MARKER) values[col] = f.value;
  }
  return { rowId, values };
}

/** All live rows of a table, ordered by row id. */
export function listRows(store: ChangeStore, table: string): RowView[] {
  return store
    .rowIds(table)
    .sort()
    .map((id) => readRow(store, table, id))
    .filter((r): r is RowView => r !== undefined);
}

/** Canonical dump of all live rows of the given tables - for convergence assertions. */
export function snapshotState(store: ChangeStore, tables: readonly string[]): string {
  return JSON.stringify(
    tables.map((t) => [t, listRows(store, t).map((r) => [r.rowId, sortObj(r.values)])]),
  );
}

function sortObj(v: Record<string, JsonValue>): Array<[string, JsonValue]> {
  return Object.keys(v)
    .sort()
    .map((k) => [k, v[k] as JsonValue]);
}
