// GENERATED FROM plugins/vibe-shared — DO NOT EDIT (run: node scripts/vibe/sync-shared.mjs)
// Wire/storage types of the sync algorithm library. Runtime neutral: no node:* imports, so the
// same code runs in the daemon (Node) and in the App (Expo / Hermes).

import type { Hlc } from "../contract/hlc";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

/** Existence marker column used by resurrectable (composite-pk membership) rows such as card_tag. */
export const ROW_MARKER = "__row";

/** One field of one row was written. Rows are created by writing their fields. */
export interface FieldChange {
  kind: "field";
  table: string;
  rowId: string;
  column: string;
  value: JsonValue;
  hlc: Hlc;
}

/** A row was deleted (tombstone). */
export interface DeleteChange {
  kind: "delete";
  table: string;
  rowId: string;
  hlc: Hlc;
}

export type Change = FieldChange | DeleteChange;

export type ApplyResult = "applied" | "stale" | "ignored";

export function changeKey(c: Change): string {
  return c.kind === "field"
    ? `f\u0000${c.table}\u0000${c.rowId}\u0000${c.column}`
    : `d\u0000${c.table}\u0000${c.rowId}`;
}

/** Identity of one concrete write (key + hlc). */
export function changeId(c: Change): string {
  return `${changeKey(c)}\u0000${c.hlc}`;
}
