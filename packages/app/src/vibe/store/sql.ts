// Minimal synchronous SQLite surface used by the local board replica. The App binds it to
// expo-sqlite's sync API (open-db.native.ts); tests bind it to node:sqlite.

export type SqlValue = string | number | null;

export interface VibeSqlDb {
  exec(sql: string): void;
  run(sql: string, params?: readonly SqlValue[]): void;
  all<T>(sql: string, params?: readonly SqlValue[]): T[];
  /** Runs `fn` in one transaction (nested calls join the outer one). */
  transaction<T>(fn: () => T): T;
}

/** Wraps begin/commit/rollback around `fn` with nesting support; shared by both bindings. */
export function createTransactionRunner(exec: (sql: string) => void) {
  let depth = 0;
  return function transaction<T>(fn: () => T): T {
    if (depth > 0) return fn();
    exec("BEGIN IMMEDIATE");
    depth = 1;
    try {
      const result = fn();
      exec("COMMIT");
      return result;
    } catch (error) {
      exec("ROLLBACK");
      throw error;
    } finally {
      depth = 0;
    }
  };
}
