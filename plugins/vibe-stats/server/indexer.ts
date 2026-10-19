// Incremental usage indexer: walks the CLI log directories, reads each file from its saved byte
// offset (usage_cursor), parses new complete lines and upserts usage_event rows. Re-reading a line
// is harmless: dedupe_key is UNIQUE.

import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { UsageProvider } from "../shared/rpc";
import type { VibeDb } from "./vibe/db";
import type { LogRoot } from "./paths";
import { PARSERS, type FileState, type UsageRecord } from "./parsers";
import { estimateCost, type PriceOverrides } from "./pricing";

const CHUNK_BYTES = 4 * 1024 * 1024;

export interface ScanResult {
  files: number;
  lines: number;
  events: number;
}

export interface IndexerOptions {
  db: VibeDb;
  roots: () => LogRoot[];
  prices?: () => PriceOverrides;
  now?: () => Date;
}

interface Cursor {
  byte_offset: number;
  size_bytes: number;
}

export async function listLogFiles(root: LogRoot): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // missing directory: CLI not installed
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && root.match.test(p)) out.push(p);
    }
  };
  await walk(root.dir);
  return out;
}

export function createIndexer(options: IndexerOptions) {
  const { db } = options;
  const now = options.now ?? (() => new Date());
  const states = new Map<string, FileState>();
  let running: Promise<ScanResult> | null = null;

  const getCursor = db.prepare<Cursor>(
    "SELECT byte_offset, size_bytes FROM usage_cursor WHERE file_path = ?",
  );
  const putCursor = db.prepare(
    `INSERT INTO usage_cursor (file_path, byte_offset, size_bytes, mtime_ms, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(file_path) DO UPDATE SET byte_offset = excluded.byte_offset,
       size_bytes = excluded.size_bytes, mtime_ms = excluded.mtime_ms,
       updated_at = excluded.updated_at`,
  );
  // On a duplicate (same message logged once per content block) only the duration may grow; a missing
  // cost is filled in when a re-scan can price it (e.g. after a price file was added).
  const putEvent = db.prepare(
    `INSERT INTO usage_event (ts, provider, model, session_id, tokens_in, tokens_out,
       tokens_cache_read, tokens_cache_write, duration_ms, cost, card_id, dedupe_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
     ON CONFLICT(dedupe_key) DO UPDATE SET
       duration_ms = CASE WHEN excluded.duration_ms IS NOT NULL
         AND excluded.duration_ms > COALESCE(usage_event.duration_ms, 0)
         THEN excluded.duration_ms ELSE usage_event.duration_ms END,
       cost = COALESCE(usage_event.cost, excluded.cost)`,
  );

  function store(rec: UsageRecord, prices: PriceOverrides): void {
    const cost = rec.cost ?? estimateCost(rec.model, rec, prices);
    putEvent.run(
      rec.ts,
      rec.provider,
      rec.model,
      rec.sessionId,
      rec.tokensIn,
      rec.tokensOut,
      rec.tokensCacheRead,
      rec.tokensCacheWrite,
      rec.durationMs,
      cost,
      rec.dedupeKey,
    );
  }

  async function readRange(
    file: string,
    from: number,
    to: number,
    onLines: (lines: string[], baseOffset: number) => void,
  ): Promise<number> {
    const handle = await open(file, "r");
    try {
      let pos = from;
      let carry: Buffer = Buffer.alloc(0);
      let consumed = from;
      while (pos < to) {
        const len = Math.min(CHUNK_BYTES, to - pos);
        const buf = Buffer.alloc(len);
        const { bytesRead } = await handle.read(buf, 0, len, pos);
        if (bytesRead === 0) break;
        pos += bytesRead;
        const data = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
        const last = data.lastIndexOf(0x0a);
        if (last < 0) {
          carry = Buffer.from(data);
          continue;
        }
        const complete = data.subarray(0, last + 1);
        onLines(complete.toString("utf8").split("\n"), consumed);
        consumed += complete.length;
        carry = Buffer.from(data.subarray(last + 1));
        await new Promise((r) => setImmediate(r)); // let the plugin host breathe on big files
      }
      return consumed;
    } finally {
      await handle.close();
    }
  }

  async function scanFile(
    provider: UsageProvider,
    file: string,
  ): Promise<{ lines: number; events: number }> {
    const st = await stat(file);
    const cursor = getCursor.get(file);
    let offset = cursor?.byte_offset ?? 0;
    if (st.size < offset) {
      offset = 0; // truncated or rotated: start over, dedupe keys protect against double counts
      states.delete(file);
    }
    if (st.size === offset) return { lines: 0, events: 0 };

    const parser = PARSERS[provider];
    let state = states.get(file);
    if (!state) {
      state = {};
      states.set(file, state);
      // Restore parser memory (session id, model, previous timestamp) by replaying the prefix.
      if (offset > 0) {
        const st0 = state;
        await readRange(file, 0, offset, (lines, base) => {
          let at = base;
          for (const l of lines) {
            parser.parseLine(l, st0, { file, offset: at });
            at += Buffer.byteLength(l) + 1;
          }
        });
      }
    }
    const fileState = state;
    const prices = options.prices?.() ?? {};
    let lines = 0;
    let events = 0;
    const end = await readRange(file, offset, st.size, (chunk, base) => {
      db.immediate(() => {
        let at = base;
        for (const l of chunk) {
          const len = Buffer.byteLength(l) + 1;
          if (l.trim()) {
            lines++;
            const rec = parser.parseLine(l, fileState, { file, offset: at });
            if (rec) {
              store(rec, prices);
              events++;
            }
          }
          at += len;
        }
      });
    });
    putCursor.run(file, end, st.size, Math.round(st.mtimeMs), now().toISOString());
    return { lines, events };
  }

  async function scanOnce(): Promise<ScanResult> {
    const result: ScanResult = { files: 0, lines: 0, events: 0 };
    const seen = new Set<string>();
    for (const root of options.roots()) {
      for (const file of await listLogFiles(root)) {
        if (seen.has(file)) continue;
        seen.add(file);
        try {
          const r = await scanFile(root.provider, file);
          result.files++;
          result.lines += r.lines;
          result.events += r.events;
        } catch {
          // A file that vanished or is locked is retried on the next scan.
        }
      }
    }
    return result;
  }

  return {
    /** Concurrent callers share one scan. */
    scan(): Promise<ScanResult> {
      running ??= scanOnce().finally(() => {
        running = null;
      });
      return running;
    },
    /** Forget all cursors so the next scan re-reads every file (events stay, dedupe keys hold). */
    resetCursors(): void {
      db.exec("DELETE FROM usage_cursor");
      states.clear();
    },
    /** Attach card ids to events of sessions that are now known (provider session id -> card id). */
    relink(sessionToCard: ReadonlyMap<string, string>): number {
      let changed = 0;
      const stmt = db.prepare(
        "UPDATE usage_event SET card_id = ? WHERE session_id = ? AND (card_id IS NULL OR card_id <> ?)",
      );
      db.immediate(() => {
        for (const [sessionId, cardId] of sessionToCard) {
          changed += stmt.run(cardId, sessionId, cardId).changes;
        }
      });
      return changed;
    },
  };
}

export type Indexer = ReturnType<typeof createIndexer>;
