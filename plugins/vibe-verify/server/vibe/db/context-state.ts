// GENERATED FROM plugins/vibe-shared — DO NOT EDIT (run: node scripts/vibe/sync-shared.mjs)
import type { VibeDb } from "./sqlite";

/** The context namespace stays behind shared commands, preserving existing persisted values. */
export function setContextMeta(
  db: Pick<VibeDb, "prepare">,
  key: string,
  value: string | null,
): void {
  if (!key.startsWith("context:")) throw new Error("上下文命令只允许写入 context 命名空间");
  if (value === null) db.prepare("DELETE FROM vibe_meta WHERE key = ?").run(key);
  else
    db.prepare(
      "INSERT INTO vibe_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(key, value);
}
export interface ContextMemoryIndexDb {
  prepare(sql: string): { run(...params: (string | number)[]): unknown };
  immediate<T>(fn: () => T): T;
}
export interface ContextMemoryIndexRow {
  id: string;
  file: string;
  tag: string;
  tokens: number;
  createdAt: string;
  touchedAt: string;
  archived: 0 | 1;
}
function insertMemoryRows(
  db: ContextMemoryIndexDb,
  projectId: string,
  rows: readonly ContextMemoryIndexRow[],
) {
  const statement = db.prepare(
    "INSERT OR REPLACE INTO memory_entry (id, project_id, file, tag, tokens, created_at, touched_at, archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const row of rows)
    statement.run(
      row.id,
      projectId,
      row.file,
      row.tag,
      row.tokens,
      row.createdAt,
      row.touchedAt,
      row.archived,
    );
}
/** Files remain authoritative: replace only this file's derived index in one transaction. */
export function replaceContextMemoryFile(
  db: ContextMemoryIndexDb,
  projectId: string,
  file: string,
  rows: readonly ContextMemoryIndexRow[],
): void {
  if (rows.some((row) => row.file !== file)) throw new Error("记忆索引行必须属于同一文件");
  db.immediate(() => {
    db.prepare("DELETE FROM memory_entry WHERE project_id = ? AND file = ?").run(projectId, file);
    insertMemoryRows(db, projectId, rows);
  });
}
export function replaceContextMemoryProject(
  db: ContextMemoryIndexDb,
  projectId: string,
  rows: readonly ContextMemoryIndexRow[],
): void {
  db.immediate(() => {
    db.prepare("DELETE FROM memory_entry WHERE project_id = ?").run(projectId);
    insertMemoryRows(db, projectId, rows);
  });
}
