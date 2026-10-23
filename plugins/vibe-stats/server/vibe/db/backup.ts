// GENERATED FROM plugins/vibe-shared — DO NOT EDIT (run: node scripts/vibe/sync-shared.mjs)
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveVibeHome, type VibeDb } from "./sqlite";

export interface BackupOptions {
  /** Defaults to VIBE_HOME. An explicit database path may use its own isolated home. */
  vibeHome?: string;
  now?: () => Date;
}

/** Snapshot all committed SQLite state, including WAL data, then verify it read-only. */
export function backupVibeDb(db: VibeDb, options: BackupOptions = {}): string {
  const backups = join(options.vibeHome ?? resolveVibeHome(), "backups");
  mkdirSync(backups, { recursive: true });
  const timestamp = (options.now?.() ?? new Date()).toISOString().replaceAll(":", "-");
  const path = join(backups, `vibe-${timestamp}-${randomUUID()}.db`);
  // VACUUM INTO holds a consistent read snapshot and includes committed WAL pages. Binding
  // the path also handles quotes and Windows separators without constructing SQL literals.
  db.prepare("VACUUM INTO ?").run(path);
  const backup = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = backup.prepare("PRAGMA integrity_check").all();
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok")
      throw new Error(`数据库备份校验失败：${path}`);
  } finally {
    backup.close();
  }
  return path;
}
