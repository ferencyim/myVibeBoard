import { openDatabaseSync } from "expo-sqlite";
import { createTransactionRunner, type SqlValue, type VibeSqlDb } from "./sql";

/** Android / iOS: one SQLite file per host next to the replica row store. */
export function openVibeDb(serverId: string): VibeSqlDb {
  const database = openDatabaseSync(`vibe-local-${serverId.replace(/[^A-Za-z0-9_-]/g, "_")}.db`);
  database.execSync("PRAGMA journal_mode = WAL;");
  const bind = (params: readonly SqlValue[] = []) => [...params];
  return {
    exec: (sql) => database.execSync(sql),
    run: (sql, params) => void database.runSync(sql, bind(params)),
    all: <T>(sql: string, params?: readonly SqlValue[]) =>
      database.getAllSync<T>(sql, bind(params)),
    transaction: createTransactionRunner((sql) => database.execSync(sql)),
  };
}
