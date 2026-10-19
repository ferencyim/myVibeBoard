// Server side of the phone sync (RPC `vibe.sync.exchange`). One exchange = one write transaction:
//
//   1. business -> log   (daemon edits with their original HLCs; daemon-owned tables as snapshots)
//   2. serveExchange     (vibe-shared/sync: admission policy, field-level LWW, cursor paging)
//   3. log -> business   (accepted phone writes go through the command layer, which publishes the
//                         vibe_event rows other plugins listen to)
//   4. if steps 3 changed the log (defaults filled in by a create, a refused update corrected), the
//      response is rebuilt so the phone learns the authoritative state in the same round trip
//
// The log lives in vibe.db (sync_field / sync_tomb); business tables remain the source of truth.

import { SyncNode, serveExchange, type ExchangeRequest, type ExchangeResponse } from "../vibe/sync";
import type { VibeDb, VibeStore } from "../vibe/db";
import { createBridge } from "./bridge";
import { createServerPolicy } from "./policy";
import { SqliteChangeStore } from "./sqlite-store";

export { createReplyService, ReplyError, type ReplyInput, type ReplyService } from "./replies";
export { SqliteChangeStore } from "./sqlite-store";

export interface SyncServiceOptions {
  db: VibeDb;
  store: VibeStore;
  /** Test hook: wall clock in ms. */
  now?: () => number;
  /** Server-side cap on the page size. */
  limit?: number;
  log?: (message: string, error?: unknown) => void;
}

export function createSyncService(options: SyncServiceOptions) {
  const { db, store: vibe } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((m, e) => console.error(`[vibe-board sync] ${m}`, e ?? ""));
  const changeStore = new SqliteChangeStore(db);
  const policy = createServerPolicy(db);

  const readHlc = () =>
    db.prepare<{ value: string }>("SELECT value FROM vibe_meta WHERE key = 'hlc'").get()?.value;

  // Same HLC stream as the command layer (vibe_meta 'hlc'): a phone write that is accepted here and
  // a later daemon edit are always ordered correctly.
  const node = new SyncNode({
    deviceId: vibe.deviceId(),
    store: changeStore,
    now,
    onAdvance: (hlc) => {
      const cur = readHlc();
      if (!cur || hlc > cur) {
        db.prepare(
          "INSERT INTO vibe_meta (key, value) VALUES ('hlc', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        ).run(hlc);
      }
    },
  });
  const clock = node.clock;
  const bridge = createBridge({ db, vibe, node, store: changeStore, log });
  // Nothing to reconcile while the database is untouched: every command ticks the HLC and most
  // publish an event; other plugin processes bump data_version.
  const fingerprint = () =>
    [
      db.dataVersion(),
      readHlc(),
      db.prepare<{ m: number | null }>("SELECT MAX(seq) AS m FROM vibe_event").get()?.m,
    ].join("|");
  let settled: string | undefined;

  function exchange(req: ExchangeRequest): ExchangeResponse {
    return db.immediate(() => {
      const dirty = fingerprint() !== settled;
      if (dirty || req.changes.length) {
        const prev = readHlc();
        try {
          if (prev) clock.receive(prev); // ticks below must order after the command layer's
        } catch {
          // a future-dated HLC from a mis-set clock: keep going with our own time
        }
      }
      if (dirty) {
        bridge.backfill();
        bridge.exportBusiness();
        bridge.publishDown();
      }
      const opts = { policy, limit: options.limit };
      const mark = changeStore.cursor;
      const first = serveExchange(node, req, opts);
      let result: ExchangeResponse = first;
      if (first.ok && changeStore.cursor !== mark) {
        const mark2 = changeStore.cursor;
        bridge.importBusiness();
        bridge.exportBusiness(); // values the commands filled in (defaults, normalised sort keys)
        if (changeStore.cursor !== mark2) {
          const again = serveExchange(node, { ...req, changes: [] }, opts);
          if (again.ok) result = { ...again, rejected: first.rejected };
        }
      }
      settled = fingerprint();
      return result;
    });
  }

  return {
    exchange,
    /** Epoch of the log (changes when the log is rebuilt; phones then take a snapshot). */
    get epoch() {
      return changeStore.epoch;
    },
    changeStore,
    node,
  };
}

export type SyncService = ReturnType<typeof createSyncService>;
