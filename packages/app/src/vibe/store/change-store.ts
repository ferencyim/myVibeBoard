// Persistent ChangeStore of the phone replica (tables sync_field / sync_tomb in vibe-local.db).
// Same layout as the daemon's exchange log, so ClientSync (generated/sync) runs unchanged.

import type { Hlc } from "../generated/contract";
import type {
  Change,
  ChangePage,
  ChangeStore,
  DeleteChange,
  FieldChange,
  FieldRecord,
  JsonValue,
} from "../generated/sync";
import type { VibeSqlDb } from "./sql";

export const LOCAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS sync_field (
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  column_name TEXT NOT NULL,
  value_json TEXT NOT NULL,
  hlc TEXT NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (table_name, row_id, column_name)
);
CREATE TABLE IF NOT EXISTS sync_tomb (
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  hlc TEXT NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (table_name, row_id)
);
CREATE TABLE IF NOT EXISTS vibe_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS plugin_cache (
  server_id TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  catalog_json TEXT NOT NULL
);
`;

interface FieldRow {
  table_name: string;
  row_id: string;
  column_name: string;
  value_json: string;
  hlc: string;
  seq: number;
}

export class SqliteChangeStore implements ChangeStore {
  readonly minCursor = 0;
  private seq: number;

  constructor(
    private readonly db: VibeSqlDb,
    /** Epoch of the server history this store mirrors (kept by ClientSync; informational here). */
    public epoch = "",
  ) {
    const row = db.all<{ m: number | null }>(
      "SELECT MAX(m) AS m FROM (SELECT MAX(seq) AS m FROM sync_field UNION ALL SELECT MAX(seq) FROM sync_tomb)",
    )[0];
    this.seq = row?.m ?? 0;
  }

  get cursor(): number {
    return this.seq;
  }

  getField(table: string, rowId: string, column: string): FieldRecord | undefined {
    const r = this.db.all<FieldRow>(
      "SELECT * FROM sync_field WHERE table_name = ? AND row_id = ? AND column_name = ?",
      [table, rowId, column],
    )[0];
    return r ? { value: JSON.parse(r.value_json) as JsonValue, hlc: r.hlc } : undefined;
  }

  getTombstone(table: string, rowId: string): Hlc | undefined {
    return this.db.all<{ hlc: string }>(
      "SELECT hlc FROM sync_tomb WHERE table_name = ? AND row_id = ?",
      [table, rowId],
    )[0]?.hlc;
  }

  rowFields(table: string, rowId: string): Record<string, FieldRecord> {
    const out: Record<string, FieldRecord> = {};
    for (const r of this.db.all<FieldRow>(
      "SELECT * FROM sync_field WHERE table_name = ? AND row_id = ?",
      [table, rowId],
    )) {
      out[r.column_name] = { value: JSON.parse(r.value_json) as JsonValue, hlc: r.hlc };
    }
    return out;
  }

  rowIds(table: string): string[] {
    return this.db
      .all<{ row_id: string }>("SELECT DISTINCT row_id FROM sync_field WHERE table_name = ?", [
        table,
      ])
      .map((r) => r.row_id);
  }

  /** Every field of a table grouped by row id - one query, for the local RPC readers. */
  tableFields(table: string): Map<string, Record<string, FieldRecord>> {
    const out = new Map<string, Record<string, FieldRecord>>();
    for (const r of this.db.all<FieldRow>("SELECT * FROM sync_field WHERE table_name = ?", [
      table,
    ])) {
      let row = out.get(r.row_id);
      if (!row) out.set(r.row_id, (row = {}));
      row[r.column_name] = { value: JSON.parse(r.value_json) as JsonValue, hlc: r.hlc };
    }
    return out;
  }

  /** Tombstones of a table as rowId -> hlc. */
  tableTombstones(table: string): Map<string, Hlc> {
    return new Map(
      this.db
        .all<{ row_id: string; hlc: string }>(
          "SELECT row_id, hlc FROM sync_tomb WHERE table_name = ?",
          [table],
        )
        .map((r) => [r.row_id, r.hlc]),
    );
  }

  putField(c: FieldChange): void {
    this.db.run(
      `INSERT INTO sync_field (table_name, row_id, column_name, value_json, hlc, seq) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(table_name, row_id, column_name) DO UPDATE SET
         value_json = excluded.value_json, hlc = excluded.hlc, seq = excluded.seq`,
      [c.table, c.rowId, c.column, JSON.stringify(c.value), c.hlc, ++this.seq],
    );
  }

  putTombstone(c: DeleteChange): void {
    this.db.run(
      `INSERT INTO sync_tomb (table_name, row_id, hlc, seq) VALUES (?, ?, ?, ?)
       ON CONFLICT(table_name, row_id) DO UPDATE SET hlc = excluded.hlc, seq = excluded.seq`,
      [c.table, c.rowId, c.hlc, ++this.seq],
    );
  }

  dropRowFields(table: string, rowId: string): void {
    this.db.run("DELETE FROM sync_field WHERE table_name = ? AND row_id = ?", [table, rowId]);
  }

  removeTombstone(table: string, rowId: string): void {
    this.db.run("DELETE FROM sync_tomb WHERE table_name = ? AND row_id = ?", [table, rowId]);
  }

  removeField(table: string, rowId: string, column: string): void {
    this.db.run("DELETE FROM sync_field WHERE table_name = ? AND row_id = ? AND column_name = ?", [
      table,
      rowId,
      column,
    ]);
  }

  changesSince(cursor: number, limit = Infinity): ChangePage {
    const take = Number.isFinite(limit) ? limit : -1;
    const rows = this.db.all<{
      kind: string;
      table_name: string;
      row_id: string;
      column_name: string | null;
      value_json: string | null;
      hlc: string;
      seq: number;
    }>(
      `SELECT * FROM (
         SELECT 'f' AS kind, table_name, row_id, column_name, value_json, hlc, seq FROM sync_field WHERE seq > ?
         UNION ALL
         SELECT 'd', table_name, row_id, NULL, NULL, hlc, seq FROM sync_tomb WHERE seq > ?
       ) ORDER BY seq LIMIT ?`,
      [cursor, cursor, take < 0 ? -1 : take + 1],
    );
    const more = take >= 0 && rows.length > take;
    const page = more ? rows.slice(0, take) : rows;
    const changes: Change[] = page.map((r) =>
      r.kind === "f"
        ? {
            kind: "field",
            table: r.table_name,
            rowId: r.row_id,
            column: r.column_name as string,
            value: JSON.parse(r.value_json as string) as JsonValue,
            hlc: r.hlc,
          }
        : { kind: "delete", table: r.table_name, rowId: r.row_id, hlc: r.hlc },
    );
    const last = page[page.length - 1];
    return { changes, cursor: last ? last.seq : this.seq, more };
  }

  clear(): void {
    this.db.exec("DELETE FROM sync_field; DELETE FROM sync_tomb;");
  }

  compactTombstones(maxSeq: number): void {
    this.db.run("DELETE FROM sync_tomb WHERE seq <= ?", [maxSeq]);
  }
}
