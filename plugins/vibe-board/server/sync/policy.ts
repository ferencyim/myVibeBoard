// Admission rules for phone writes: vibe-shared's phonePolicy (writable tables, draft <-> todo
// only) plus the rules that need the business tables of vibe.db.

import { ChatEventBodySchema, PROMPT_OVERRIDE_MAX_CHARS, parsePromptOverrideId } from "../vibe/contract";
import type { VibeDb } from "../vibe/db";
import { phonePolicy, type SyncPolicy } from "../vibe/sync";

/** The phone may only add plain notes and the owner's chat messages to a card's history. */
const PHONE_EVENT_TYPES = ["note", "chat"];

/** User-fillable keys of a phone chat body; answers / fallback / key are routing bookkeeping. */
const PHONE_CHAT_KEYS = ["text", "kind", "thread"];

/** A body_json value (stored as a JSON string) that a phone may send as a chat message. */
export function isPhoneChatBody(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const body: unknown = JSON.parse(value);
    if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
    if (!Object.keys(body).every((k) => PHONE_CHAT_KEYS.includes(k))) return false;
    return ChatEventBodySchema.safeParse(body).success;
  } catch {
    return false;
  }
}

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
      // A prompt override is cleared by writing empty text, never by deleting the row.
      if (table === "project" || table === "maintenance_rule" || table === "card_event" || table === "prompt_override")
        return readOnly;
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
    if (table === "prompt_override") {
      const scope = parsePromptOverrideId(rowId);
      if (!scope || !db.prepare("SELECT 1 AS x FROM prompt_template WHERE key = ?").get(scope.key)) return readOnly;
      if (scope.projectId !== null && !exists("project", scope.projectId)) return readOnly;
      if (change.kind === "field") {
        if (change.column !== "text") return readOnly;
        if (typeof change.value !== "string" || change.value.length > PROMPT_OVERRIDE_MAX_CHARS) return readOnly;
      }
    }
    if (table === "card" && change.column === "project_id" && exists("card", rowId)) return readOnly;
    if (table === "card_event") {
      // History is append-only: new notes are fine, existing events are immutable.
      if (exists("card_event", rowId)) return readOnly;
      if (change.column === "type" && !PHONE_EVENT_TYPES.includes(String(change.value))) return readOnly;
      if (change.column === "author_kind" && change.value !== "user") return readOnly;
      // The columns of a new row arrive in any order: whichever of type / body_json comes second
      // checks the pair, so a chat row never gets a body with routing fields.
      const field = (column: string) => store.getField("card_event", rowId, column)?.value;
      if (change.column === "type" && change.value === "chat") {
        const body = field("body_json");
        if (body !== undefined && !isPhoneChatBody(body)) return readOnly;
      }
      if (change.column === "body_json" && field("type") === "chat" && !isPhoneChatBody(change.value)) {
        return readOnly;
      }
    }
    return base;
  };
}
