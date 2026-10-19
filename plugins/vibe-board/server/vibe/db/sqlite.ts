// GENERATED FROM plugins/vibe-shared — DO NOT EDIT (run: node scripts/vibe/sync-shared.mjs)
// Thin wrapper over node:sqlite (Node >= 22) for the shared vibe.db.
// Every plugin process opens its own connection to the same file: WAL + busy_timeout for
// concurrent access, BEGIN IMMEDIATE for writes so lock contention surfaces at the start
// of a transaction (and is retried by busy_timeout) instead of as a failed upgrade mid-way.

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

export type SqlParam = SQLInputValue;
export type Row = Record<string, unknown>;

export interface Statement<R = Row> {
  get(...params: SqlParam[]): R | undefined;
  all(...params: SqlParam[]): R[];
  run(...params: SqlParam[]): { changes: number; lastInsertRowid: number | bigint };
}

export interface VibeDb {
  readonly path: string;
  exec(sql: string): void;
  prepare<R = Row>(sql: string): Statement<R>;
  /** Run `fn` in a write transaction (BEGIN IMMEDIATE). Nested calls become savepoints. */
  immediate<T>(fn: () => T): T;
  /** PRAGMA data_version: changes when another connection committed. */
  dataVersion(): number;
  close(): void;
}

/** `$VIBE_HOME`, default `~/.vibe`. Tests and dev daemons must set VIBE_HOME to a temp dir. */
export function resolveVibeHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.VIBE_HOME?.trim();
  return override ? override : join(homedir(), ".vibe");
}

export function defaultDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveVibeHome(env), "vibe.db");
}

export interface OpenOptions {
  /** Defaults to defaultDbPath(). Use ":memory:" for throwaway single-connection tests. */
  path?: string;
  busyTimeoutMs?: number;
}

export function openVibeDb(options: OpenOptions = {}): VibeDb {
  const path = options.path ?? defaultDbPath();
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path, { timeout: options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS });
  // busy_timeout first: switching to WAL itself needs a lock.
  raw.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS}`);
  if (path !== ":memory:") raw.exec("PRAGMA journal_mode = WAL");
  raw.exec("PRAGMA synchronous = NORMAL");
  raw.exec("PRAGMA foreign_keys = ON");

  let depth = 0;
  let savepointSeq = 0;

  return {
    path,
    exec: (sql) => raw.exec(sql),
    prepare<R = Row>(sql: string): Statement<R> {
      const stmt = raw.prepare(sql);
      return {
        get: (...params) => stmt.get(...params) as R | undefined,
        all: (...params) => stmt.all(...params) as R[],
        run: (...params) => {
          const r = stmt.run(...params);
          return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
        },
      };
    },
    immediate<T>(fn: () => T): T {
      if (depth > 0) {
        const name = `sp_${++savepointSeq}`;
        raw.exec(`SAVEPOINT ${name}`);
        depth++;
        try {
          const result = fn();
          raw.exec(`RELEASE ${name}`);
          return result;
        } catch (error) {
          raw.exec(`ROLLBACK TO ${name}`);
          raw.exec(`RELEASE ${name}`);
          throw error;
        } finally {
          depth--;
        }
      }
      raw.exec("BEGIN IMMEDIATE");
      depth++;
      try {
        const result = fn();
        raw.exec("COMMIT");
        return result;
      } catch (error) {
        if (raw.isTransaction) raw.exec("ROLLBACK");
        throw error;
      } finally {
        depth--;
      }
    },
    dataVersion: () =>
      (raw.prepare("PRAGMA data_version").get() as { data_version: number }).data_version,
    close: () => raw.close(),
  };
}
