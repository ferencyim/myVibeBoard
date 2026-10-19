// memory_entry consistency convention
// ----------------------------------
// * The Markdown files are authoritative; memory_entry is a derived index for queries/UI
//   (id, project, file, tag, tokens, created/touched, archived). Never edit it independently.
// * `file` is the LIVE file's path relative to .vibe/ (e.g. "DECISIONS.md",
//   "workers/claude/MEMORY.md"); archived entries keep that value with archived = 1.
// * After every file change the store emits a FileSnapshot; syncMemoryIndex replaces ALL rows of
//   (project, file) in one transaction, so a demotion flips archived without a second write.
// * The index can always be rebuilt from the files (rebuildMemoryIndex), e.g. on daemon start
//   or after a git pull changed the memory files. Rebuilding is idempotent.

import { entryTokens, type MemoryEntry } from "./entries";
import type { FileSnapshot, MemoryStore } from "./store";
import { estimateTokens, type TokenEstimator } from "./tokens";

/** Structurally satisfied by VibeDb from vibe-shared. */
export interface MemoryIndexDb {
  prepare(sql: string): { run(...params: (string | number)[]): unknown };
  immediate<T>(fn: () => T): T;
}

function insertRows(
  db: MemoryIndexDb,
  projectId: string,
  file: string,
  entries: MemoryEntry[],
  archived: 0 | 1,
  estimate: TokenEstimator,
): void {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO memory_entry (id, project_id, file, tag, tokens, created_at, touched_at, archived)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const e of entries) {
    stmt.run(e.id, projectId, file, e.tag, entryTokens(e, estimate), e.created, e.touched, archived);
  }
}

export function syncMemoryIndex(
  db: MemoryIndexDb,
  projectId: string,
  snapshot: FileSnapshot,
  estimate: TokenEstimator = estimateTokens,
): void {
  db.immediate(() => {
    db.prepare("DELETE FROM memory_entry WHERE project_id = ? AND file = ?").run(
      projectId,
      snapshot.file,
    );
    insertRows(db, projectId, snapshot.file, snapshot.live, 0, estimate);
    insertRows(db, projectId, snapshot.file, snapshot.archived, 1, estimate);
  });
}

/** `onChange` callback for createMemoryStore that keeps memory_entry in step with the files. */
export function createIndexSink(
  db: MemoryIndexDb,
  projectId: string,
  estimate: TokenEstimator = estimateTokens,
): (snapshot: FileSnapshot) => void {
  return (snapshot) => syncMemoryIndex(db, projectId, snapshot, estimate);
}

/** Rebuild the whole index of a project from the files on disk (drops rows of vanished files). */
export function rebuildMemoryIndex(
  db: MemoryIndexDb,
  projectId: string,
  store: MemoryStore,
  estimate: TokenEstimator = estimateTokens,
): void {
  db.immediate(() => {
    db.prepare("DELETE FROM memory_entry WHERE project_id = ?").run(projectId);
    for (const snap of store.snapshots()) {
      insertRows(db, projectId, snap.file, snap.live, 0, estimate);
      insertRows(db, projectId, snap.file, snap.archived, 1, estimate);
    }
  });
}
