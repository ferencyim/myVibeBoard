// SQLite ChangeStore: the exchange log of the phone sync endpoint (tables sync_field / sync_tomb,
// core migration 2). Every record carries the server arrival seq that phones use as cursor.
// Epoch, seq counter and compaction floor live in vibe_meta. All methods are synchronous and meant
// to run inside the caller's write transaction (one exchange = one transaction).

import { newId, type Hlc } from "../vibe/contract";
import type { Row, Statement, VibeDb } from "../vibe/db";
import type {
  Change,
  ChangePage,
  ChangeStore,
  DeleteChange,
  FieldChange,
  FieldRecord,
  JsonValue,
} from "../vibe/sync";

interface FieldRow {
  table_name: string;
  row_id: string;
  column_name: string;
  value_json: string;
  hlc: string;
  seq: number;
}
interface TombRow {
  table_name: string;
  row_id: string;
  hlc: string;
  seq: number;
}

export class SqliteChangeStore implements ChangeStore {
  private readonly statements = new Map<string, Statement<never>>();
  private seq: number | undefined;

  constructor(private readonly db: VibeDb) {}

  /** Prepared statements are cached: a first-contact snapshot runs tens of thousands of them. */
  private q<R = Row>(sql: string): Statement<R> {
    let stmt = this.statements.get(sql);
    if (!stmt) this.statements.set(sql, (stmt = this.db.prepare<never>(sql)));
    return stmt as unknown as Statement<R>;
  }

  private meta(key: string): string | undefined {
    return this.q<{ value: string }>("SELECT value FROM vibe_meta WHERE key = ?").get(key)
      ?.value;
  }

  private setMeta(key: string, value: string): void {
    this
      .q(
        "INSERT INTO vibe_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  get epoch(): string {
    const have = this.meta("sync_epoch");
    if (have) return have;
    this.setMeta("sync_epoch", newId());
    return this.meta("sync_epoch")!;
  }

  get minCursor(): number {
    return Number(this.meta("sync_min_cursor") ?? 0);
  }

  /** Highest seq handed out. Cached: this process is the only writer of the log. */
  get cursor(): number {
    return (this.seq ??= Number(this.meta("sync_seq") ?? 0));
  }

  private nextSeq(): number {
    const seq = this.cursor + 1;
    this.seq = seq;
    this.setMeta("sync_seq", String(seq));
    return seq;
  }

  getField(table: string, rowId: string, column: string): FieldRecord | undefined {
    const r = this
      .q<FieldRow>(
        "SELECT * FROM sync_field WHERE table_name = ? AND row_id = ? AND column_name = ?",
      )
      .get(table, rowId, column);
    return r ? { value: JSON.parse(r.value_json) as JsonValue, hlc: r.hlc } : undefined;
  }

  getTombstone(table: string, rowId: string): Hlc | undefined {
    return this
      .q<TombRow>("SELECT hlc FROM sync_tomb WHERE table_name = ? AND row_id = ?")
      .get(table, rowId)?.hlc;
  }

  rowFields(table: string, rowId: string): Record<string, FieldRecord> {
    const out: Record<string, FieldRecord> = {};
    for (const r of this
      .q<FieldRow>("SELECT * FROM sync_field WHERE table_name = ? AND row_id = ?")
      .all(table, rowId)) {
      out[r.column_name] = { value: JSON.parse(r.value_json) as JsonValue, hlc: r.hlc };
    }
    return out;
  }

  rowIds(table: string): string[] {
    return this.db
      .prepare<{ row_id: string }>("SELECT DISTINCT row_id FROM sync_field WHERE table_name = ?")
      .all(table)
      .map((r) => r.row_id);
  }

  /** All fields of a table grouped by row (one query; used to diff daemon-owned tables). */
  tableFields(table: string): Map<string, Record<string, JsonValue>> {
    const out = new Map<string, Record<string, JsonValue>>();
    for (const r of this
      .q<FieldRow>("SELECT * FROM sync_field WHERE table_name = ?")
      .all(table)) {
      let row = out.get(r.row_id);
      if (!row) out.set(r.row_id, (row = {}));
      row[r.column_name] = JSON.parse(r.value_json) as JsonValue;
    }
    return out;
  }

  putField(c: FieldChange): void {
    this
      .q(
        `INSERT INTO sync_field (table_name, row_id, column_name, value_json, hlc, seq) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(table_name, row_id, column_name) DO UPDATE SET
           value_json = excluded.value_json, hlc = excluded.hlc, seq = excluded.seq`,
      )
      .run(c.table, c.rowId, c.column, JSON.stringify(c.value), c.hlc, this.nextSeq());
  }

  putTombstone(c: DeleteChange): void {
    this
      .q(
        `INSERT INTO sync_tomb (table_name, row_id, hlc, seq) VALUES (?, ?, ?, ?)
         ON CONFLICT(table_name, row_id) DO UPDATE SET hlc = excluded.hlc, seq = excluded.seq`,
      )
      .run(c.table, c.rowId, c.hlc, this.nextSeq());
  }

  dropRowFields(table: string, rowId: string): void {
    this.db.prepare("DELETE FROM sync_field WHERE table_name = ? AND row_id = ?").run(table, rowId);
  }

  removeTombstone(table: string, rowId: string): void {
    this.db.prepare("DELETE FROM sync_tomb WHERE table_name = ? AND row_id = ?").run(table, rowId);
  }

  removeField(table: string, rowId: string, column: string): void {
    this
      .q("DELETE FROM sync_field WHERE table_name = ? AND row_id = ? AND column_name = ?")
      .run(table, rowId, column);
  }

  changesSince(cursor: number, limit = Infinity): ChangePage {
    const take = Number.isFinite(limit) ? limit : -1;
    const rows = this.db
      .prepare<{
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
      )
      .all(cursor, cursor, take < 0 ? -1 : take + 1);
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
    return { changes, cursor: last ? last.seq : this.cursor, more };
  }

  clear(): void {
    this.db.exec("DELETE FROM sync_field; DELETE FROM sync_tomb;");
  }

  compactTombstones(maxSeq: number): void {
    this.db.prepare("DELETE FROM sync_tomb WHERE seq <= ?").run(maxSeq);
    this.setMeta("sync_min_cursor", String(Math.max(this.minCursor, maxSeq)));
  }
}
