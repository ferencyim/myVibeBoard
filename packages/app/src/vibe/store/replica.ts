// The phone replica: persistent change store + ClientSync + the state that must survive restarts
// (cursor, epoch, unsent changes, last HLC, device id, pending replies). Every mutation and every
// merged server response runs in one SQLite transaction together with the state write, so a crash
// can never leave the outbox out of step with the data.

import { newId } from "../generated/contract";
import {
  ClientSync,
  PendingReplyQueue,
  type Change,
  type ExchangeRequest,
  type ExchangeResponse,
  type PendingReply,
} from "../generated/sync";
import { LOCAL_SCHEMA, SqliteChangeStore } from "./change-store";
import type { VibeSqlDb } from "./sql";

export function readState(db: VibeSqlDb, key: string): string | undefined {
  return db.all<{ value: string }>("SELECT value FROM vibe_state WHERE key = ?", [key])[0]?.value;
}

export function writeState(db: VibeSqlDb, key: string, value: string): void {
  db.run(
    "INSERT INTO vibe_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
}

function readJson<T>(db: VibeSqlDb, key: string, fallback: T): T {
  const raw = readState(db, key);
  if (raw === undefined) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

class PersistentClientSync extends ClientSync {
  constructor(
    private readonly replica: LocalReplica,
    opts: ConstructorParameters<typeof ClientSync>[0],
  ) {
    super(opts);
  }

  override applyResponse(req: ExchangeRequest, resp: ExchangeResponse) {
    return this.replica.db.transaction(() => {
      const out = super.applyResponse(req, resp);
      this.replica.persist();
      return out;
    });
  }
}

export class LocalReplica {
  readonly store: SqliteChangeStore;
  readonly sync: ClientSync;
  readonly replies: PendingReplyQueue;

  private constructor(
    readonly db: VibeSqlDb,
    options: { now?: () => number },
  ) {
    db.exec(LOCAL_SCHEMA);
    let deviceId = readState(db, "deviceId");
    if (!deviceId) {
      deviceId = `phone-${newId().slice(-8).toLowerCase()}`;
      writeState(db, "deviceId", deviceId);
    }
    this.store = new SqliteChangeStore(db, readState(db, "epoch") ?? "");
    this.sync = new PersistentClientSync(this, {
      deviceId,
      store: this.store,
      now: options.now,
      cursor: Number(readState(db, "cursor") ?? 0),
      epoch: readState(db, "epoch"),
      outbox: readJson<Change[]>(db, "outbox", []),
      last: readState(db, "hlc") ?? null,
      onAdvance: (hlc) => writeState(db, "hlc", hlc),
    });
    this.replies = new PendingReplyQueue(readJson<PendingReply[]>(db, "replies", []));
  }

  static open(db: VibeSqlDb, options: { now?: () => number } = {}): LocalReplica {
    return new LocalReplica(db, options);
  }

  get hasPending(): boolean {
    return this.sync.pending.length > 0;
  }

  /** Cursor, epoch and the outbox; called inside the transaction that changed them. */
  persist(): void {
    const { db, sync } = this;
    writeState(db, "cursor", String(sync.cursor));
    if (sync.epoch !== undefined) {
      writeState(db, "epoch", sync.epoch);
      this.store.epoch = sync.epoch;
    }
    writeState(db, "outbox", JSON.stringify(sync.pending));
  }

  /** Local write(s): applied to the store and queued for the next exchange, atomically. */
  mutate<T>(fn: (sync: ClientSync) => T): T {
    return this.db.transaction(() => {
      const result = fn(this.sync);
      this.persist();
      return result;
    });
  }

  persistReplies(): void {
    writeState(this.db, "replies", JSON.stringify(this.replies.toJSON()));
  }
}
