// Admission rules for phone writes: vibe-shared's phonePolicy (writable tables, draft <-> todo
// only) plus the rules that need the business tables of vibe.db.

import type { VibeDb } from "../vibe/db";
import { phonePolicy, type SyncPolicy } from "../vibe/sync";

/** The phone may only add plain notes to a card's history. */
const PHONE_EVENT_TYPES = ["note"];

export function createServerPolicy(db: VibeDb): SyncPolicy {
  const exists = (table: string, id: string): boolean => {
    try {
      return !!db.prepare(`SELECT 1 AS x FROM ${table} WHERE id = ?`).get(id);
    } catch {
      return false; // table of an owner that never migrated
    }
  };

  return (change, store) => {
    const base = phonePolicy(change, store);
    if (!base.ok) return base;
    const readOnly = { ok: false, reason: "read_only" } as const;
    const { table, rowId } = change;

    if (change.kind === "delete") {
      if (table === "project" || table === "maintenance_rule" || table === "card_event") return readOnly;
      if (table === "tag") {
        const row = db.prepare<{ builtin: number }>("SELECT builtin FROM tag WHERE id = ?").get(rowId);
        if (row?.builtin) return readOnly;
      }
      if (table === "card") {
        const column = db.prepare<{ column: string }>('SELECT "column" AS column FROM card WHERE id = ?').get(rowId);
        const sessions = db.prepare("SELECT 1 AS x FROM agent_session WHERE card_id = ?").get(rowId);
        if (column && (column.column !== "draft" || sessions)) {
          return { ok: false, reason: "column_locked" };
        }
      }
      return base;
    }

    // Projects and maintenance rules are created on the computer (repo path, prefix, checks).
    if ((table === "project" || table === "maintenance_rule") && !exists(table, rowId)) return readOnly;
    if (table === "tag") {
      const row = db.prepare<{ builtin: number }>("SELECT builtin FROM tag WHERE id = ?").get(rowId);
      if (row?.builtin) return readOnly;
    }
    if (table === "card" && change.column === "project_id" && exists("card", rowId)) return readOnly;
    if (table === "card_event") {
      // History is append-only: new notes are fine, existing events are immutable.
      if (exists("card_event", rowId)) return readOnly;
      if (change.column === "type" && !PHONE_EVENT_TYPES.includes(String(change.value))) return readOnly;
      if (change.column === "author_kind" && change.value !== "user") return readOnly;
    }
    return base;
  };
}
