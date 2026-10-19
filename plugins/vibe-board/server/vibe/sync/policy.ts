// GENERATED FROM plugins/vibe-shared — DO NOT EDIT (run: node scripts/vibe/sync-shared.mjs)
// Server-side admission rules for changes coming from a phone.
//
//   * Only direction=both tables accept phone writes; down/local tables are daemon-owned.
//   * Phones may only move cards between draft <-> todo, and only while the card is in one of
//     those columns. Every other column (in_progress, verifying, done) is decided by the daemon
//     from session events, whatever the HLCs say.
//   * Reordering (sort_key) and deleting a card is likewise limited to draft/todo cards.

import { syncSpec } from "../contract/sync-spec";
import { isResurrectable } from "./merge";
import type { ChangeStore } from "./store";
import { ROW_MARKER, type Change, type JsonValue } from "./types";

/** Columns a phone may put a card into / take a card out of. */
export const PHONE_MOVABLE_COLUMNS: readonly string[] = ["draft", "todo"];

export type RejectReason =
  | "unknown_table"
  | "read_only"
  | "unknown_field"
  | "column_locked"
  | "clock_drift";

export type PolicyDecision =
  | { ok: true }
  | {
      ok: false;
      reason: RejectReason;
      /** Value to restore when the row has no authoritative value yet. */
      fallback?: JsonValue;
    };

/** Decides whether a phone-originated change is admissible given the authoritative store. */
export type SyncPolicy = (change: Change, store: ChangeStore) => PolicyDecision;

const OK: PolicyDecision = { ok: true };

function cardColumn(store: ChangeStore, cardId: string): JsonValue | undefined {
  return store.getField("card", cardId, "column")?.value;
}

function phoneMayTouch(col: JsonValue | undefined): boolean {
  return col === undefined || (typeof col === "string" && PHONE_MOVABLE_COLUMNS.includes(col));
}

export const phonePolicy: SyncPolicy = (change, store) => {
  const spec = syncSpec(change.table);
  if (!spec) return { ok: false, reason: "unknown_table" };
  if (spec.direction !== "both") return { ok: false, reason: "read_only" };

  if (change.kind === "delete") {
    if (change.table === "card" && !phoneMayTouch(cardColumn(store, change.rowId))) {
      return { ok: false, reason: "column_locked" };
    }
    return OK;
  }

  const known =
    spec.fields.includes(change.column) ||
    (change.column === ROW_MARKER && isResurrectable(change.table));
  if (!known) return { ok: false, reason: "unknown_field" };

  if (change.table === "card") {
    const current = cardColumn(store, change.rowId);
    if (change.column === "column") {
      const target = change.value;
      if (typeof target !== "string" || !PHONE_MOVABLE_COLUMNS.includes(target) || !phoneMayTouch(current)) {
        return { ok: false, reason: "column_locked", fallback: current ?? "draft" };
      }
    } else if (change.column === "sort_key" && !phoneMayTouch(current)) {
      return { ok: false, reason: "column_locked" };
    }
  }
  return OK;
};
