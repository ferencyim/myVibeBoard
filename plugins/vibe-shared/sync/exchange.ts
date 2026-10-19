// Exchange protocol (RPC `vibe.sync.exchange`) - server handler and client engine.
//
//   request : { deviceId, epoch?, since, clientNow, changes[], limit? }
//   response: { ok:true, epoch, cursor, more, snapshot, changes[], rejected[], serverNow }
//             | { ok:false, code:"clock_drift", serverNow }
//
// Both directions use the same Change format. Daemon->phone read-only tables (agent_session,
// verification*, git_snapshot, ...) are written by the daemon into the same store via
// SyncNode.publishFields; the first exchange (or any exchange after an epoch change / history
// compaction) returns `snapshot:true` with the full state, later ones only increments.
// Pagination: while `more` is true call again with `since = cursor` and no changes.

import { compareHlc, parseHlc, type Hlc } from "../contract/hlc";
import { syncSpec } from "../contract/sync-spec";
import { applyChange } from "./merge";
import { SyncNode, type SyncNodeOptions } from "./node";
import { phonePolicy, type RejectReason, type SyncPolicy } from "./policy";
import { changeId, changeKey, type Change, type JsonValue } from "./types";

export const DEFAULT_PAGE_LIMIT = 500;

export interface ExchangeRequest {
  deviceId: string;
  /** Epoch the client last synced with (undefined on first contact). */
  epoch?: string;
  /** Cursor returned by the previous response (0 initially). */
  since: number;
  /** Client wall clock, for drift detection. */
  clientNow: number;
  changes: Change[];
  limit?: number;
}

export interface Rejection {
  change: Change;
  reason: RejectReason;
}

export interface ExchangeOk {
  ok: true;
  epoch: string;
  cursor: number;
  more: boolean;
  /** Replace local synced state with `changes` (first contact / epoch change / compaction). */
  snapshot: boolean;
  changes: Change[];
  rejected: Rejection[];
  serverNow: number;
}

export interface ExchangeError {
  ok: false;
  code: "clock_drift";
  serverNow: number;
}

export type ExchangeResponse = ExchangeOk | ExchangeError;

export interface ServeOptions {
  policy?: SyncPolicy;
  /** Server-side cap on page size. */
  limit?: number;
}

/**
 * Authoritative side of one exchange: admit (policy) and merge the phone's changes, repair
 * rejected ones with a newer authoritative write, and return everything since the cursor.
 * Idempotent: replaying the same request is harmless.
 */
export function serveExchange(
  node: SyncNode,
  req: ExchangeRequest,
  opts: ServeOptions = {},
): ExchangeResponse {
  const policy = opts.policy ?? phonePolicy;
  const store = node.store;
  const serverNow = node.clock.now();
  const maxDrift = node.clock.maxDriftMs;

  if (
    Math.abs(req.clientNow - serverNow) > maxDrift ||
    req.changes.some((c) => parseHlc(c.hlc).wall - serverNow > maxDrift)
  ) {
    return { ok: false, code: "clock_drift", serverNow };
  }

  const snapshot = req.epoch !== store.epoch || req.since < store.minCursor;
  const since = snapshot ? 0 : req.since;

  const rejected: Rejection[] = [];
  const echoes = new Set<string>();
  for (const c of req.changes) {
    node.clock.receive(c.hlc);
    // Redelivery of a change we already accepted (lost response, retry): not subject to the
    // policy again - the server state may have moved on since, but the write itself was valid.
    if (c.kind === "field" ? store.getField(c.table, c.rowId, c.column)?.hlc === c.hlc : store.getTombstone(c.table, c.rowId) === c.hlc) {
      continue;
    }
    const d = policy(c, store);
    if (d.ok) {
      if (applyChange(store, c) === "applied") echoes.add(changeId(c));
      continue;
    }
    rejected.push({ change: c, reason: d.reason });
    if (c.kind === "delete") {
      // Re-stamp the live row so the phone can undo its local delete.
      const fields = store.rowFields(c.table, c.rowId);
      const values = Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, f.value]));
      if (Object.keys(values).length) node.writeFields(c.table, c.rowId, values);
    } else {
      const cur = store.getField(c.table, c.rowId, c.column);
      const value = cur ? cur.value : d.fallback;
      const wouldHaveLost = cur && compareHlc(c.hlc, cur.hlc) <= 0;
      if (value !== undefined && !wouldHaveLost) {
        node.writeFields(c.table, c.rowId, { [c.column]: value });
      }
    }
  }

  const page = store.changesSince(since, Math.min(req.limit ?? DEFAULT_PAGE_LIMIT, opts.limit ?? DEFAULT_PAGE_LIMIT));
  return {
    ok: true,
    epoch: store.epoch,
    cursor: page.cursor,
    more: page.more,
    snapshot,
    changes: snapshot ? page.changes : page.changes.filter((c) => !echoes.has(changeId(c))),
    rejected,
    serverNow,
  };
}

export type ExchangeTransport = (req: ExchangeRequest) => Promise<ExchangeResponse>;

export interface ClientSyncOptions extends SyncNodeOptions {
  cursor?: number;
  epoch?: string;
  /** Restored unsent changes (persist `pending` after every write). */
  outbox?: Change[];
}

export interface SyncOutcome {
  rejected: Rejection[];
  cursor: number;
}

/** Phone-side engine: local writes -> outbox, exchange with the server, merge the answer. */
export class ClientSync {
  readonly node: SyncNode;
  cursor: number;
  epoch: string | undefined;
  private readonly outbox = new Map<string, Change>();
  private inflight: Promise<SyncOutcome> | null = null;

  constructor(opts: ClientSyncOptions) {
    this.node = new SyncNode(opts);
    this.cursor = opts.cursor ?? 0;
    this.epoch = opts.epoch;
    for (const c of opts.outbox ?? []) this.outbox.set(changeKey(c), c);
  }

  /** Unsent local changes (persist these together with cursor/epoch/clock.lastHlc). */
  get pending(): Change[] {
    return [...this.outbox.values()];
  }

  /** Offline-capable write of syncable (direction=both) fields. */
  write(table: string, rowId: string, values: Record<string, JsonValue>): void {
    const spec = syncSpec(table);
    if (!spec || spec.direction !== "both") throw new Error(`Table ${table} is not writable from a phone`);
    for (const col of Object.keys(values)) {
      if (!spec.fields.includes(col)) throw new Error(`Unknown field ${table}.${col}`);
    }
    for (const c of this.node.writeFields(table, rowId, values)) this.outbox.set(changeKey(c), c);
  }

  remove(table: string, rowId: string): void {
    const spec = syncSpec(table);
    if (!spec || spec.direction !== "both") throw new Error(`Table ${table} is not writable from a phone`);
    const c = this.node.deleteRow(table, rowId);
    for (const [k, p] of this.outbox) if (p.table === table && p.rowId === rowId) this.outbox.delete(k);
    this.outbox.set(changeKey(c), c);
  }

  buildRequest(limit?: number): ExchangeRequest {
    return {
      deviceId: this.node.deviceId,
      epoch: this.epoch,
      since: this.cursor,
      clientNow: this.node.clock.now(),
      changes: this.pending,
      limit,
    };
  }

  /** Merge a response. `retry` is set after a clock correction: build a fresh request and resend. */
  applyResponse(req: ExchangeRequest, resp: ExchangeResponse): { retry: boolean; rejected: Rejection[] } {
    const store = this.node.store;
    if (!resp.ok) {
      this.correctClock(resp.serverNow);
      return { retry: true, rejected: [] };
    }
    const sent = new Set(req.changes.map(changeId));
    if (resp.snapshot) {
      const inFlight = this.pending.filter((c) => !sent.has(changeId(c)));
      store.clear();
      this.outbox.clear();
      for (const c of inFlight) {
        applyChange(store, c);
        this.outbox.set(changeKey(c), c);
      }
    }
    for (const r of resp.rejected) {
      if (r.change.kind === "delete" && store.getTombstone(r.change.table, r.change.rowId) === r.change.hlc) {
        store.removeTombstone(r.change.table, r.change.rowId);
      }
    }
    this.node.applyRemote(resp.changes);
    for (const r of resp.rejected) {
      // Refused with no authoritative value to restore (e.g. sort_key of a locked card): drop ours.
      const c = r.change;
      if (c.kind === "field" && store.getField(c.table, c.rowId, c.column)?.hlc === c.hlc) {
        store.removeField(c.table, c.rowId, c.column);
      }
    }
    for (const c of req.changes) {
      if (this.outbox.get(changeKey(c))?.hlc === c.hlc) this.outbox.delete(changeKey(c));
    }
    this.cursor = resp.cursor;
    this.epoch = resp.epoch;
    return { retry: false, rejected: resp.rejected };
  }

  /** Run exchanges until the server has nothing more. Concurrent calls share one run. */
  sync(transport: ExchangeTransport, opts: { limit?: number } = {}): Promise<SyncOutcome> {
    this.inflight ??= this.run(transport, opts.limit).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async run(transport: ExchangeTransport, limit?: number): Promise<SyncOutcome> {
    const rejected: Rejection[] = [];
    let corrected = false;
    for (;;) {
      const req = this.buildRequest(limit);
      const resp = await transport(req);
      const out = this.applyResponse(req, resp);
      if (out.retry) {
        if (corrected) throw new Error("sync: clock drift persists after correction");
        corrected = true;
        continue;
      }
      rejected.push(...out.rejected);
      if (!(resp as { more: boolean }).more) return { rejected, cursor: this.cursor };
    }
  }

  /** The local wall clock is off by more than the drift limit: fix it and re-stamp unsent writes. */
  private correctClock(serverNow: number): void {
    const pending = this.pending.sort((a, b) => compareHlc(a.hlc, b.hlc));
    this.node.clock.correct(serverNow);
    this.outbox.clear();
    const store = this.node.store;
    for (const c of pending) {
      const hlc: Hlc = this.node.clock.tick();
      if (c.kind === "field") {
        if (store.getField(c.table, c.rowId, c.column)?.hlc !== c.hlc) continue; // already superseded
        const n = { ...c, hlc };
        store.putField(n);
        this.outbox.set(changeKey(n), n);
      } else {
        if (store.getTombstone(c.table, c.rowId) !== c.hlc) continue;
        const n = { ...c, hlc };
        store.putTombstone(n);
        this.outbox.set(changeKey(n), n);
      }
    }
  }
}
