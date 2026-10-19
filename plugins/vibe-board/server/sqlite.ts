import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export interface PreparedStatement<Params = unknown, Row = unknown> {
  get(...params: Params extends unknown[] ? Params : [Params?]): Row | undefined;
  all(...params: Params extends unknown[] ? Params : [Params?]): Row[];
  run(...params: Params extends unknown[] ? Params : [Params?]): {
    changes: number;
    lastInsertRowid: number | bigint;
  };
}

export interface PluginDatabase {
  readonly filePath: string;
  pragma(statement: string): unknown;
  exec(sql: string): void;
  prepare<Params = unknown[], Row = unknown>(
    sql: string,
  ): PreparedStatement<Params, Row>;
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
  close(): void;
}

export function tasksDataDir(): string {
  const override = process.env.PASEO_TASKS_DATA_DIR?.trim();
  if (override) return override;
  const paseoHome = process.env.PASEO_HOME?.trim() || join(homedir(), ".paseo");
  return join(paseoHome, "plugin-data", "tasks");
}

export function defaultTasksDbPath(): string {
  return join(tasksDataDir(), "tasks.db");
}

function normalizeSqlArgs(args: unknown[]): SQLInputValue[] {
  if (
    args.length === 1 &&
    typeof args[0] === "object" &&
    args[0] !== null &&
    !Array.isArray(args[0]) &&
    !(args[0] instanceof Uint8Array)
  ) {
    return [args[0] as SQLInputValue];
  }
  return args as SQLInputValue[];
}

function toPlainRow<Row>(row: unknown): Row {
  if (row && typeof row === "object") {
    return { ...(row as Record<string, unknown>) } as Row;
  }
  return row as Row;
}

export function openTasksDatabase(filePath = defaultTasksDbPath()): PluginDatabase {
  if (filePath !== ":memory:") {
    mkdirSync(dirname(filePath), { recursive: true });
  }
  const raw = new DatabaseSync(filePath);
  if (filePath !== ":memory:") {
    raw.exec("PRAGMA journal_mode = WAL;");
    raw.exec("PRAGMA busy_timeout = 5000;");
  }
  raw.exec("PRAGMA foreign_keys = ON;");

  let txDepth = 0;

  return {
    filePath,
    pragma(statement: string): unknown {
      raw.exec(`PRAGMA ${statement}`);
      return undefined;
    },
    exec(sql: string): void {
      raw.exec(sql);
    },
    prepare<Params = unknown[], Row = unknown>(
      sql: string,
    ): PreparedStatement<Params, Row> {
      const stmt = raw.prepare(sql);
      stmt.setAllowBareNamedParameters(true);
      return {
        get(...params: unknown[]): Row | undefined {
          const res = stmt.get(...normalizeSqlArgs(params));
          return res === undefined ? undefined : toPlainRow<Row>(res);
        },
        all(...params: unknown[]): Row[] {
          const rows = stmt.all(...normalizeSqlArgs(params));
          return rows.map((row) => toPlainRow<Row>(row));
        },
        run(...params: unknown[]) {
          const res = stmt.run(...normalizeSqlArgs(params));
          return {
            changes: Number(res.changes),
            lastInsertRowid: res.lastInsertRowid,
          };
        },
      };
    },
    transaction<T extends (...args: never[]) => unknown>(fn: T): T {
      const wrapped = ((...args: Parameters<T>): ReturnType<T> => {
        const savepoint = `sp_${++txDepth}`;
        const isRoot = txDepth === 1;
        raw.exec(isRoot ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
        try {
          const result = fn(...args) as ReturnType<T>;
          raw.exec(isRoot ? "COMMIT" : `RELEASE SAVEPOINT ${savepoint}`);
          txDepth -= 1;
          return result;
        } catch (error) {
          try {
            raw.exec(
              isRoot
                ? "ROLLBACK"
                : `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`,
            );
          } catch {}
          txDepth -= 1;
          throw error;
        }
      }) as T;
      return wrapped;
    },
    close(): void {
      raw.close();
    },
  };
}
