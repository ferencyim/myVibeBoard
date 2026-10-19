// node:sqlite binding of VibeSqlDb for unit tests (the App binds expo-sqlite, open-db.native.ts).

import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createTransactionRunner, type SqlValue, type VibeSqlDb } from "./sql";

export function createTestDb(path = ":memory:"): VibeSqlDb {
  const database = new DatabaseSync(path);
  return {
    exec: (sql) => database.exec(sql),
    run: (sql, params = []) => void database.prepare(sql).run(...(params as SQLInputValue[])),
    all: <T>(sql: string, params: readonly SqlValue[] = []) =>
      database.prepare(sql).all(...(params as SQLInputValue[])) as T[],
    transaction: createTransactionRunner((sql) => database.exec(sql)),
  };
}
