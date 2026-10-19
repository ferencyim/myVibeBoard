// GENERATED FROM plugins/vibe-shared — DO NOT EDIT (run: node scripts/vibe/sync-shared.mjs)
// Storage abstraction for the merge algorithm. Everything is synchronous so SQLite adapters
// (node:sqlite, expo-sqlite sync API) can wrap one exchange in a single transaction.
//
// Every stored record (field or tombstone) carries a local arrival `seq`. Cursors are seqs, NOT
// HLCs: a change from a device that was offline for a day has an old HLC but a new seq, so
// "everything since cursor" cannot miss it.

import type { Hlc } from "../contract/hlc";
import type { Change, DeleteChange, FieldChange, JsonValue } from "./types";

export interface FieldRecord {
  value: JsonValue;
  hlc: Hlc;
}

export interface ChangePage {
  changes: Change[];
  /** Cursor to continue from (seq of the last returned change, or the current cursor if none). */
  cursor: number;
  more: boolean;
}

export interface ChangeStore {
  /** Identifies this store's history; a changed epoch tells clients to take a fresh snapshot. */
  readonly epoch: string;
  /** Clients whose cursor is below this must take a snapshot (history was compacted). */
  readonly minCursor: number;
  /** Highest seq handed out so far. */
  readonly cursor: number;

  getField(table: string, rowId: string, column: string): FieldRecord | undefined;
  getTombstone(table: string, rowId: string): Hlc | undefined;
  rowFields(table: string, rowId: string): Record<string, FieldRecord>;
  /** Ids of rows that currently hold at least one field. */
  rowIds(table: string): string[];

  /** Raw writes (no LWW comparison; merge.ts does that). Each assigns a fresh seq. */
  putField(c: FieldChange): void;
  putTombstone(c: DeleteChange): void;
  /** Forget the field values of a row (after a permanent delete). Tombstone stays. */
  dropRowFields(table: string, rowId: string): void;
  removeTombstone(table: string, rowId: string): void;
  removeField(table: string, rowId: string, column: string): void;

  /** Current records (one per field / tombstone) with seq > cursor, ascending by seq. */
  changesSince(cursor: number, limit?: number): ChangePage;
  /** Wipe all fields and tombstones (client side, before applying a snapshot). */
  clear(): void;
  /**
   * Drop tombstones with seq <= maxSeq and raise minCursor so stale clients resync from a
   * snapshot instead of resurrecting rows.
   */
  compactTombstones(maxSeq: number): void;
}

const SEP = "\u0000";

interface StoredField extends FieldChange {
  seq: number;
}
interface StoredTomb extends DeleteChange {
  seq: number;
}

function newEpoch(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export class MemoryChangeStore implements ChangeStore {
  epoch: string;
  minCursor = 0;
  private seq = 0;
  private readonly fields = new Map<string, StoredField>();
  private readonly tombs = new Map<string, StoredTomb>();

  constructor(epoch: string = newEpoch()) {
    this.epoch = epoch;
  }

  get cursor(): number {
    return this.seq;
  }

  getField(table: string, rowId: string, column: string): FieldRecord | undefined {
    const f = this.fields.get(table + SEP + rowId + SEP + column);
    return f ? { value: f.value, hlc: f.hlc } : undefined;
  }

  getTombstone(table: string, rowId: string): Hlc | undefined {
    return this.tombs.get(table + SEP + rowId)?.hlc;
  }

  rowFields(table: string, rowId: string): Record<string, FieldRecord> {
    const out: Record<string, FieldRecord> = {};
    for (const f of this.fields.values()) {
      if (f.table === table && f.rowId === rowId) out[f.column] = { value: f.value, hlc: f.hlc };
    }
    return out;
  }

  rowIds(table: string): string[] {
    const ids = new Set<string>();
    for (const f of this.fields.values()) if (f.table === table) ids.add(f.rowId);
    return [...ids];
  }

  putField(c: FieldChange): void {
    this.fields.set(c.table + SEP + c.rowId + SEP + c.column, { ...c, seq: ++this.seq });
  }

  putTombstone(c: DeleteChange): void {
    this.tombs.set(c.table + SEP + c.rowId, { ...c, seq: ++this.seq });
  }

  dropRowFields(table: string, rowId: string): void {
    for (const [k, f] of this.fields) if (f.table === table && f.rowId === rowId) this.fields.delete(k);
  }

  removeTombstone(table: string, rowId: string): void {
    this.tombs.delete(table + SEP + rowId);
  }

  removeField(table: string, rowId: string, column: string): void {
    this.fields.delete(table + SEP + rowId + SEP + column);
  }

  changesSince(cursor: number, limit = Infinity): ChangePage {
    const all: Array<StoredField | StoredTomb> = [];
    for (const f of this.fields.values()) if (f.seq > cursor) all.push(f);
    for (const t of this.tombs.values()) if (t.seq > cursor) all.push(t);
    all.sort((a, b) => a.seq - b.seq);
    const page = all.slice(0, limit);
    const more = all.length > page.length;
    const changes = page.map(({ seq: _seq, ...c }) => c as Change);
    const last = page[page.length - 1];
    return { changes, cursor: last ? last.seq : this.seq, more };
  }

  clear(): void {
    this.fields.clear();
    this.tombs.clear();
  }

  compactTombstones(maxSeq: number): void {
    for (const [k, t] of this.tombs) if (t.seq <= maxSeq) this.tombs.delete(k);
    this.minCursor = Math.max(this.minCursor, maxSeq);
  }
}
