// A replica: HLC clock + change store. Used directly as the authoritative (daemon/server) side and
// wrapped by ClientSync on the phone.

import type { Hlc } from "../contract/hlc";
import { HlcClock, type HlcClockOptions } from "./clock";
import { applyChange, isResurrectable, listRows, readRow, type RowView } from "./merge";
import type { ChangeStore } from "./store";
import {
  ROW_MARKER,
  type ApplyResult,
  type Change,
  type DeleteChange,
  type FieldChange,
  type JsonValue,
} from "./types";

export interface SyncNodeOptions extends Omit<HlcClockOptions, "node"> {
  deviceId: string;
  store: ChangeStore;
}

export class SyncNode {
  readonly deviceId: string;
  readonly store: ChangeStore;
  readonly clock: HlcClock;

  constructor(opts: SyncNodeOptions) {
    this.deviceId = opts.deviceId;
    this.store = opts.store;
    this.clock = new HlcClock({ ...opts, node: opts.deviceId });
  }

  /**
   * Local write of some fields of a row (creates the row if needed). Returns the changes that
   * took effect (none if the row is dead). Resurrectable rows get their existence marker.
   */
  writeFields(table: string, rowId: string, values: Record<string, JsonValue>): FieldChange[] {
    const entries = Object.entries(values);
    if (isResurrectable(table)) entries.push([ROW_MARKER, true]);
    const out: FieldChange[] = [];
    for (const [column, value] of entries) {
      const c: FieldChange = {
        kind: "field",
        table,
        rowId,
        column,
        value,
        hlc: this.clock.tick(),
      };
      if (applyChange(this.store, c) === "applied") out.push(c);
    }
    return out;
  }

  /** Like writeFields but skips fields whose value is unchanged (keeps increments small). */
  publishFields(table: string, rowId: string, values: Record<string, JsonValue>): FieldChange[] {
    const changed: Record<string, JsonValue> = {};
    for (const [col, v] of Object.entries(values)) {
      const cur = this.store.getField(table, rowId, col);
      if (!cur || JSON.stringify(cur.value) !== JSON.stringify(v)) changed[col] = v;
    }
    return Object.keys(changed).length ? this.writeFields(table, rowId, changed) : [];
  }

  deleteRow(table: string, rowId: string): DeleteChange {
    const c: DeleteChange = { kind: "delete", table, rowId, hlc: this.clock.tick() };
    applyChange(this.store, c);
    return c;
  }

  /** Merge remote changes (any order, duplicates fine). Advances the clock for every change. */
  applyRemote(changes: readonly Change[]): ApplyResult[] {
    return changes.map((c) => {
      this.clock.receive(c.hlc);
      return applyChange(this.store, c);
    });
  }

  readRow(table: string, rowId: string): RowView | undefined {
    return readRow(this.store, table, rowId);
  }

  listRows(table: string): RowView[] {
    return listRows(this.store, table);
  }

  get lastHlc(): Hlc | null {
    return this.clock.lastHlc;
  }
}
