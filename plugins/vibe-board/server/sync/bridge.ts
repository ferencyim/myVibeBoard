// Reconciles the sync log (SqliteChangeStore) with the business tables of vibe.db.
//
//   exportBusiness  business -> log   daemon-side edits (field HLCs in sync_meta, tombstones in
//                                     sync_tombstone) are fed into the log with their ORIGINAL HLCs,
//                                     so field-level LWW between phone and daemon is decided by time,
//                                     not by who syncs first
//   publishDown     business -> log   daemon-owned tables (agent_session, verification, ...) as plain
//                                     snapshot + increments (daemon always wins)
//   importBusiness  log -> business   phone writes that won the merge are written back through the
//                                     command layer (createVibeStore), so state-machine rules apply
//                                     and vibe_event rows (card.created / card.moved / ...) are
//                                     published for the other plugins
//
// Synced values are the raw SQLite cells (text / integer / null): `*_json` columns stay JSON text,
// flags stay 0/1. The phone keeps the same column layout.

import { isHlc, syncSpec, type CardColumn } from "../vibe/contract";
import type { Row, SqlParam, VibeDb, VibeStore } from "../vibe/db";
import { ROW_MARKER, applyChange, type JsonValue, type SyncNode } from "../vibe/sync";
import { isPhoneChatBody } from "./policy";
import type { SqliteChangeStore } from "./sqlite-store";

/** HLC for rows that were never stamped (seed tags, rows from before sync existed). */
export const SEED_HLC = "000000000000-0000-seed";

const BOTH_TABLES = [
  "project",
  "preset",
  "tag",
  "card",
  "card_tag",
  "card_event",
  "maintenance_rule",
] as const;
const DOWN_TABLES = [
  "agent_session",
  "plan_version",
  "git_snapshot",
  "verification",
  "verification_item",
  "evidence_file",
  "maintenance_run",
] as const;
/**
 * Display-only columns of the phone-writable tables (card key and number, project prefix, ...).
 * They are not in sync-spec, so the phone can never write them: the daemon publishes them as plain
 * values (no sync_meta) and the phone shows them. Without them the offline board could not show
 * card keys.
 */
const DISPLAY_COLUMNS: Record<string, readonly string[]> = {
  project: ["prefix", "next_number", "created_at", "updated_at"],
  card: [
    "number",
    "key",
    "worktree",
    "origin",
    "origin_ref",
    "plan_session_id",
    "created_at",
    "updated_at",
  ],
  preset: ["builtin", "created_at", "updated_at"],
  tag: ["builtin"],
};
/** Local file paths never leave the computer. */
const DOWN_EXCLUDE: Record<string, readonly string[]> = { evidence_file: ["path", "thumb_path"] };

interface Field {
  value: JsonValue;
  hlc: string;
}
interface Pending {
  rowId: string;
  fields: Record<string, Field>;
  changed: string[];
}

function cell(v: unknown): JsonValue | undefined {
  if (v === null || typeof v === "string" || typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  return undefined; // blobs are not synced
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const asBool = (v: JsonValue | undefined) => v === 1 || v === true;
const asJson = (v: JsonValue | undefined, fallback: unknown) => {
  if (typeof v !== "string") return fallback;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
};
const sqlParam = (v: JsonValue): SqlParam =>
  v === true ? 1 : v === false ? 0 : typeof v === "object" && v !== null ? JSON.stringify(v) : v;

export interface BridgeDeps {
  db: VibeDb;
  vibe: VibeStore;
  node: SyncNode;
  store: SqliteChangeStore;
  log?: (message: string, error?: unknown) => void;
}

export function createBridge({ db, vibe, node, store, log }: BridgeDeps) {
  const warn = log ?? (() => {});
  const existing = new Set(
    db
      .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name),
  );
  const has = (table: string) => existing.has(table);
  const bizRow = (table: string, id: string): Row | undefined =>
    has(table) ? db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) : undefined;

  // ---- business -> log ---------------------------------------------------------------------

  /** Rows written without sync_meta (seed tags, other writers) get stamped so they sync. */
  function backfill(): void {
    for (const table of BOTH_TABLES) {
      const spec = syncSpec(table);
      if (!spec || !has(table) || table === "card_tag") continue;
      const stmt = db.prepare(
        `INSERT OR IGNORE INTO sync_meta (table_name, row_id, column_name, hlc, device_id)
         SELECT ?, id, ?, CASE WHEN updated_hlc = '' THEN ? ELSE updated_hlc END, 'seed' FROM ${table}`,
      );
      for (const column of spec.fields) stmt.run(table, column, SEED_HLC);
    }
  }

  function exportBusiness(): void {
    for (const table of BOTH_TABLES) {
      if (!has(table) || table === "card_tag") continue;
      const dirty = db
        .prepare<{ r: string; c: string; h: string }>(
          `SELECT m.row_id AS r, m.column_name AS c, m.hlc AS h FROM sync_meta m
           LEFT JOIN sync_field f ON f.table_name = m.table_name AND f.row_id = m.row_id AND f.column_name = m.column_name
           WHERE m.table_name = ? AND (f.hlc IS NULL OR m.hlc > f.hlc) ORDER BY m.row_id`,
        )
        .all(table);
      let rowId = "";
      let row: Row | undefined;
      for (const d of dirty) {
        if (d.r !== rowId) {
          rowId = d.r;
          row = bizRow(table, rowId);
        }
        const value = row ? cell(row[d.c]) : undefined;
        if (value === undefined || !isHlc(d.h)) continue;
        applyChange(store, { kind: "field", table, rowId, column: d.c, value, hlc: d.h });
      }
    }
    if (has("card_tag")) {
      const marks = db
        .prepare<{ r: string; h: string }>(
          `SELECT x.r AS r, x.h AS h FROM (
             SELECT card_id || ':' || tag_id AS r, CASE WHEN updated_hlc = '' THEN ? ELSE updated_hlc END AS h FROM card_tag
           ) x
           LEFT JOIN sync_field f ON f.table_name = 'card_tag' AND f.row_id = x.r AND f.column_name = ?
           WHERE f.hlc IS NULL OR x.h > f.hlc`,
        )
        .all(SEED_HLC, ROW_MARKER);
      for (const m of marks) {
        applyChange(store, {
          kind: "field",
          table: "card_tag",
          rowId: m.r,
          column: ROW_MARKER,
          value: true,
          hlc: m.h,
        });
      }
    }
    const tombs = db
      .prepare<{ t: string; r: string; h: string }>(
        `SELECT t.table_name AS t, t.row_id AS r, t.hlc AS h FROM sync_tombstone t
         LEFT JOIN sync_tomb s ON s.table_name = t.table_name AND s.row_id = t.row_id
         WHERE s.hlc IS NULL OR t.hlc > s.hlc`,
      )
      .all();
    for (const t of tombs) {
      if (isHlc(t.h)) applyChange(store, { kind: "delete", table: t.t, rowId: t.r, hlc: t.h });
    }
  }

  /** Daemon-owned tables: full state the first time, only differences afterwards. */
  function publishDown(): void {
    for (const table of DOWN_TABLES) {
      const spec = syncSpec(table);
      if (!spec || !has(table)) continue;
      const skip = new Set(DOWN_EXCLUDE[table] ?? []);
      const known = store.tableFields(table);
      const seen = new Set<string>();
      for (const row of db.prepare(`SELECT * FROM ${table}`).all()) {
        const rowId = spec.pk.map((c) => String(row[c])).join(":");
        seen.add(rowId);
        const have = known.get(rowId);
        const changed: Record<string, JsonValue> = {};
        for (const [col, raw] of Object.entries(row)) {
          if (skip.has(col)) continue;
          const v = cell(raw);
          if (v !== undefined && (!have || !same(have[col], v))) changed[col] = v;
        }
        if (Object.keys(changed).length) node.writeFields(table, rowId, changed);
      }
      for (const rowId of known.keys()) if (!seen.has(rowId)) node.deleteRow(table, rowId);
    }
  }

  /** Display-only columns of live business rows; only differences are written. */
  function publishDisplayColumns(): void {
    for (const [table, columns] of Object.entries(DISPLAY_COLUMNS)) {
      if (!has(table)) continue;
      const known = store.tableFields(table);
      for (const row of db.prepare(`SELECT * FROM ${table}`).all()) {
        const rowId = String(row.id);
        const have = known.get(rowId);
        if (!have) continue; // not exported to the log (yet)
        const changed: Record<string, JsonValue> = {};
        for (const col of columns) {
          const v = cell(row[col]);
          if (v !== undefined && !same(have[col], v)) changed[col] = v;
        }
        if (Object.keys(changed).length) node.writeFields(table, rowId, changed);
      }
    }
  }

  // ---- log -> business ---------------------------------------------------------------------

  let repaired = false;

  function stampMeta(table: string, rowId: string, column: string, hlc: string): void {
    db.prepare(
      "UPDATE sync_meta SET hlc = ? WHERE table_name = ? AND row_id = ? AND column_name = ?",
    ).run(hlc, table, rowId, column);
  }

  /** Make the log agree with the business row again (a phone write could not be applied). */
  function repairFields(table: string, rowId: string, columns: string[], row: Row): void {
    const values: Record<string, JsonValue> = {};
    for (const c of columns) {
      const v = cell(row[c]);
      if (v !== undefined) values[c] = v;
    }
    if (!Object.keys(values).length) return;
    repaired = true;
    for (const w of node.writeFields(table, rowId, values)) stampMeta(table, rowId, w.column, w.hlc);
  }

  /** Create failed: tell the phone the row does not exist. */
  function repairDelete(table: string, rowId: string, error: unknown): void {
    warn(`sync: cannot create ${table} ${rowId}`, error);
    node.deleteRow(table, rowId);
    repaired = true;
  }

  /** Business values should now equal the log: align sync_meta HLCs, or correct the log. */
  function settle(table: string, p: Pending): void {
    const row = bizRow(table, p.rowId);
    if (!row) return;
    const off: string[] = [];
    for (const c of p.changed) {
      if (same(cell(row[c]), p.fields[c]?.value)) stampMeta(table, p.rowId, c, p.fields[c]!.hlc);
      else off.push(c);
    }
    if (off.length) repairFields(table, p.rowId, off, row);
  }

  /** Rows whose log fields are newer than the business table (or missing there). */
  function pendingRows(table: string): Pending[] {
    const spec = syncSpec(table);
    const rows = db
      .prepare<{ r: string; c: string }>(
        `SELECT f.row_id AS r, f.column_name AS c FROM sync_field f
         LEFT JOIN sync_meta m ON m.table_name = f.table_name AND m.row_id = f.row_id AND m.column_name = f.column_name
         WHERE f.table_name = ? AND f.column_name <> ? AND (m.hlc IS NULL OR f.hlc > m.hlc) ORDER BY f.row_id`,
      )
      .all(table, ROW_MARKER);
    const byRow = new Map<string, string[]>();
    for (const r of rows) {
      if (!spec?.fields.includes(r.c)) continue;
      const list = byRow.get(r.r) ?? [];
      list.push(r.c);
      byRow.set(r.r, list);
    }
    return [...byRow].map(([rowId, changed]) => ({
      rowId,
      fields: store.rowFields(table, rowId),
      changed,
    }));
  }

  function rawUpdate(table: string, p: Pending, updatedAt: boolean): void {
    const sets = p.changed.map((c) => `"${c}" = ?`);
    const params: SqlParam[] = p.changed.map((c) => sqlParam(p.fields[c]!.value));
    sets.push("updated_hlc = ?");
    params.push(p.changed.map((c) => p.fields[c]!.hlc).sort().at(-1)!);
    if (updatedAt) {
      sets.push("updated_at = ?");
      params.push(new Date().toISOString());
    }
    db.prepare(`UPDATE ${table} SET ${sets.join(", ")} WHERE id = ?`).run(...params, p.rowId);
  }

  const val = (p: Pending, c: string) => p.fields[c]?.value;

  function importProjects(): void {
    for (const p of pendingRows("project")) {
      const row = bizRow("project", p.rowId);
      if (!row) continue; // phones cannot create projects (policy)
      const patch: Record<string, unknown> = {};
      for (const c of p.changed) {
        const v = val(p, c);
        if (same(cell(row[c]), v)) continue;
        if (c === "name") patch.name = v;
        else if (c === "project_type") patch.projectType = v; // COMPAT(project-types)
        else if (c === "project_types_json") patch.projectTypes = asJson(v, []);
        else if (c === "description") patch.description = v;
        else if (c === "requirements_path") patch.requirementsPath = v;
        else if (c === "default_preset_id") patch.defaultPresetId = v;
        else if (c === "concurrency_limit") patch.concurrencyLimit = v;
        else if (c === "devices_json") patch.devices = asJson(v, []);
        else if (c === "color") patch.color = v;
        else if (c === "archived_at") patch.archived = v !== null;
      }
      try {
        if (Object.keys(patch).length) vibe.projects.update(p.rowId, patch);
      } catch (error) {
        warn(`sync: project ${p.rowId} update failed`, error);
      }
      settle("project", p);
    }
  }

  const PRESET_KEYS: Record<string, string> = {
    name: "name",
    provider: "provider",
    model: "model",
    thinking: "thinking",
    permission_mode: "permissionMode",
    environment_kind: "environmentKind",
    base_branch: "baseBranch",
    runtime_env: "runtimeEnv",
    instructions: "instructions",
    fallback_preset_ids_json: "fallbackPresetIds",
    role_hint: "roleHint", // COMPAT(preset-role-hints)
    role_hints_json: "roleHints",
  };

  function importPresets(): void {
    for (const p of pendingRows("preset")) {
      const input: Record<string, unknown> = {};
      for (const [col, key] of Object.entries(PRESET_KEYS)) {
        if (col in p.fields) {
          input[key] = col.endsWith("_json") ? asJson(val(p, col), null) : val(p, col);
        }
      }
      try {
        if (!bizRow("preset", p.rowId)) {
          vibe.presets.create({ id: p.rowId, ...input } as never);
        } else {
          const patch: Record<string, unknown> = {};
          for (const c of p.changed) if (PRESET_KEYS[c]) patch[PRESET_KEYS[c]] = input[PRESET_KEYS[c]];
          vibe.presets.update(p.rowId, patch as never);
        }
      } catch (error) {
        if (!bizRow("preset", p.rowId)) {
          repairDelete("preset", p.rowId, error);
          continue;
        }
        warn(`sync: preset ${p.rowId} update failed`, error);
      }
      settle("preset", p);
    }
  }

  function importTags(): void {
    for (const p of pendingRows("tag")) {
      try {
        if (!bizRow("tag", p.rowId)) {
          vibe.tags.create(String(val(p, "name")), asBool(val(p, "evidence")), p.rowId);
        } else {
          rawUpdate("tag", p, false);
        }
      } catch (error) {
        if (!bizRow("tag", p.rowId)) {
          repairDelete("tag", p.rowId, error);
          continue;
        }
        warn(`sync: tag ${p.rowId} update failed`, error);
      }
      settle("tag", p);
    }
  }

  function updateCard(p: Pending, row: Row): void {
    const diff = p.changed.filter((c) => !same(cell(row[c]), val(p, c)));
    const patch: Record<string, unknown> = {};
    for (const c of diff) {
      const v = val(p, c);
      if (c === "title" || c === "description" || c === "acceptance" || c === "priority") patch[c] = v;
      else if (c === "ref_images_json") patch.refImages = asJson(v, []);
      else if (c === "needs_evidence") patch.needsEvidence = asBool(v);
      else if (c === "preset_id") patch.presetId = v;
      else if (c === "suggested_preset_id") patch.suggestedPresetId = v;
      else if (c === "reviewer_preset_id") patch.reviewerPresetId = v;
      else if (c === "parent_card_id") patch.parentCardId = v;
    }
    const attempt = (fn: () => void) => {
      try {
        fn();
      } catch (error) {
        warn(`sync: card ${p.rowId} change refused`, error);
      }
    };
    if (Object.keys(patch).length) attempt(() => void vibe.cards.update(p.rowId, patch));
    const sortKey = val(p, "sort_key");
    if (diff.includes("column")) {
      attempt(
        () =>
          void vibe.cards.move(p.rowId, {
            to: val(p, "column") as CardColumn,
            actor: "phone",
            sortKey: typeof sortKey === "string" ? sortKey : undefined,
          }),
      );
    } else if (diff.includes("sort_key") && typeof sortKey === "string") {
      attempt(() => void vibe.cards.reorder(p.rowId, sortKey));
    }
    if (diff.includes("archived_at")) {
      attempt(() => void vibe.cards.archive(p.rowId, val(p, "archived_at") !== null));
    }
  }

  function importCards(): void {
    const parents: Array<{ id: string; parent: string }> = [];
    const done: Pending[] = [];
    for (const p of pendingRows("card")) {
      const row = bizRow("card", p.rowId);
      try {
        if (!row) {
          const parent = val(p, "parent_card_id");
          vibe.cards.create(
            {
              id: p.rowId,
              projectId: String(val(p, "project_id")),
              title: String(val(p, "title") ?? ""),
              description: (val(p, "description") as string | undefined) ?? "",
              column: ((val(p, "column") as string | undefined) ?? "draft") as CardColumn,
              sortKey: val(p, "sort_key") as string | undefined,
              priority: (val(p, "priority") as never) ?? undefined,
              acceptance: (val(p, "acceptance") as string | undefined) ?? "",
              refImages: asJson(val(p, "ref_images_json"), []) as string[],
              needsEvidence: "needs_evidence" in p.fields ? asBool(val(p, "needs_evidence")) : undefined,
              presetId: (val(p, "preset_id") as string | null | undefined) ?? null,
              suggestedPresetId: (val(p, "suggested_preset_id") as string | null | undefined) ?? null,
              reviewerPresetId: (val(p, "reviewer_preset_id") as string | null | undefined) ?? null,
            },
            "phone",
            "phone",
          );
          if (typeof parent === "string") parents.push({ id: p.rowId, parent });
        } else {
          updateCard(p, row);
        }
      } catch (error) {
        if (!bizRow("card", p.rowId)) {
          repairDelete("card", p.rowId, error);
          continue;
        }
        warn(`sync: card ${p.rowId} update failed`, error);
      }
      done.push(p);
    }
    for (const { id, parent } of parents) {
      try {
        if (bizRow("card", parent)) vibe.cards.update(id, { parentCardId: parent });
      } catch (error) {
        warn(`sync: card ${id} parent failed`, error);
      }
    }
    for (const p of done) settle("card", p);
  }

  function importEvents(): void {
    for (const p of pendingRows("card_event")) {
      try {
        if (!bizRow("card_event", p.rowId)) {
          if (val(p, "type") === "chat") {
            // The policy checks type and body_json one column at a time; a chat row is only
            // created once its body is there and passes (a rejected body leaves it unimported).
            const body = val(p, "body_json");
            if (body === undefined) continue;
            if (!isPhoneChatBody(body)) {
              repairDelete("card_event", p.rowId, new Error("invalid phone chat body"));
              continue;
            }
          }
          vibe.events.add({
            id: p.rowId,
            cardId: String(val(p, "card_id")),
            type: val(p, "type") as never,
            authorKind: val(p, "author_kind") as never,
            author: (val(p, "author") as string | undefined) ?? "",
            body: asJson(val(p, "body_json"), {}),
            createdAt: (val(p, "created_at") as string | undefined) ?? undefined,
          });
        } else {
          rawUpdate("card_event", p, false);
        }
      } catch (error) {
        if (!bizRow("card_event", p.rowId)) {
          repairDelete("card_event", p.rowId, error);
          continue;
        }
        warn(`sync: card_event ${p.rowId} update failed`, error);
      }
      settle("card_event", p);
    }
  }

  function importRules(): void {
    if (!has("maintenance_rule")) return;
    for (const p of pendingRows("maintenance_rule")) {
      if (!bizRow("maintenance_rule", p.rowId)) continue; // phones cannot create rules (policy)
      try {
        rawUpdate("maintenance_rule", p, true);
      } catch (error) {
        warn(`sync: maintenance_rule ${p.rowId} update failed`, error);
      }
      settle("maintenance_rule", p);
    }
  }

  function importCardTags(): void {
    if (!has("card_tag")) return;
    const adds = db
      .prepare<{ r: string; h: string }>(
        `SELECT f.row_id AS r, f.hlc AS h FROM sync_field f
         LEFT JOIN sync_tomb s ON s.table_name = f.table_name AND s.row_id = f.row_id
         WHERE f.table_name = 'card_tag' AND f.column_name = ? AND (s.hlc IS NULL OR f.hlc > s.hlc)
           AND NOT EXISTS (SELECT 1 FROM card_tag ct WHERE ct.card_id || ':' || ct.tag_id = f.row_id)`,
      )
      .all(ROW_MARKER);
    const removes = db
      .prepare<{ r: string; h: string }>(
        `SELECT s.row_id AS r, s.hlc AS h FROM sync_tomb s
         JOIN card_tag ct ON ct.card_id || ':' || ct.tag_id = s.row_id
         WHERE s.table_name = 'card_tag' AND s.hlc > ct.updated_hlc`,
      )
      .all();
    const wanted = new Map<string, { add: Map<string, string>; remove: Map<string, string> }>();
    const entry = (cardId: string) => {
      let e = wanted.get(cardId);
      if (!e) wanted.set(cardId, (e = { add: new Map(), remove: new Map() }));
      return e;
    };
    for (const a of adds) {
      const [cardId = "", tagId = ""] = a.r.split(":");
      if (!bizRow("card", cardId) || !bizRow("tag", tagId)) {
        node.deleteRow("card_tag", a.r);
        repaired = true;
        continue;
      }
      entry(cardId).add.set(tagId, a.h);
    }
    for (const r of removes) {
      const [cardId = "", tagId = ""] = r.r.split(":");
      entry(cardId).remove.set(tagId, r.h);
    }
    for (const [cardId, w] of wanted) {
      const next = new Set(
        db
          .prepare<{ tag_id: string }>("SELECT tag_id FROM card_tag WHERE card_id = ?")
          .all(cardId)
          .map((x) => x.tag_id),
      );
      for (const t of w.add.keys()) next.add(t);
      for (const t of w.remove.keys()) next.delete(t);
      try {
        vibe.cards.setTags(cardId, [...next]);
      } catch (error) {
        warn(`sync: card ${cardId} tags failed`, error);
        continue;
      }
      for (const [tagId, hlc] of w.add) {
        db.prepare("UPDATE card_tag SET updated_hlc = ? WHERE card_id = ? AND tag_id = ?").run(
          hlc,
          cardId,
          tagId,
        );
      }
      for (const [tagId, hlc] of w.remove) {
        db.prepare(
          "UPDATE sync_tombstone SET hlc = ? WHERE table_name = 'card_tag' AND row_id = ?",
        ).run(hlc, `${cardId}:${tagId}`);
      }
    }
  }

  function importDeletes(): void {
    const run = (table: string, remove: (id: string) => void) => {
      const dead = db
        .prepare<{ r: string; h: string }>(
          `SELECT s.row_id AS r, s.hlc AS h FROM sync_tomb s JOIN ${table} b ON b.id = s.row_id WHERE s.table_name = ?`,
        )
        .all(table);
      for (const d of dead) {
        try {
          remove(d.r);
          db.prepare("UPDATE sync_tombstone SET hlc = ? WHERE table_name = ? AND row_id = ?").run(
            d.h,
            table,
            d.r,
          );
        } catch (error) {
          warn(`sync: ${table} ${d.r} delete refused`, error);
        }
      }
    };
    run("card", (id) => vibe.cards.delete(id));
    run("preset", (id) => vibe.presets.delete(id));
    run("tag", (id) => vibe.tags.delete(id));
  }

  /** Apply everything the phone won. Returns true when the log was corrected (re-read it). */
  function importBusiness(): boolean {
    repaired = false;
    importProjects();
    importPresets();
    importTags();
    importCards();
    importEvents();
    importRules();
    importCardTags();
    importDeletes();
    return repaired;
  }

  return { backfill, exportBusiness, publishDown, publishDisplayColumns, importBusiness, bizRow, has };
}

export type Bridge = ReturnType<typeof createBridge>;
