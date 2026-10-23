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

import {
  replaceContextMemoryFile,
  replaceContextMemoryProject,
  type ContextMemoryIndexDb,
  type ContextMemoryIndexRow,
} from "../vibe/db/context-state";
import { entryTokens } from "./entries";
import type { FileSnapshot, MemoryStore } from "./store";
import { estimateTokens, type TokenEstimator } from "./tokens";
export type MemoryIndexDb = ContextMemoryIndexDb;
function rowsOf(snapshot: FileSnapshot, estimate: TokenEstimator): ContextMemoryIndexRow[] {
  return [
    ...snapshot.live.map((entry) => ({ entry, archived: 0 as const })),
    ...snapshot.archived.map((entry) => ({ entry, archived: 1 as const })),
  ].map(({ entry, archived }) => ({
    id: entry.id,
    file: snapshot.file,
    tag: entry.tag,
    tokens: entryTokens(entry, estimate),
    createdAt: entry.created,
    touchedAt: entry.touched,
    archived,
  }));
}
export function syncMemoryIndex(
  db: MemoryIndexDb,
  projectId: string,
  snapshot: FileSnapshot,
  estimate: TokenEstimator = estimateTokens,
): void {
  replaceContextMemoryFile(db, projectId, snapshot.file, rowsOf(snapshot, estimate));
}
/** Derive the index after an authoritative Markdown file changes. */
export function createIndexSink(
  db: MemoryIndexDb,
  projectId: string,
  estimate: TokenEstimator = estimateTokens,
): (snapshot: FileSnapshot) => void {
  return (snapshot) => syncMemoryIndex(db, projectId, snapshot, estimate);
}
export function rebuildMemoryIndex(
  db: MemoryIndexDb,
  projectId: string,
  store: MemoryStore,
  estimate: TokenEstimator = estimateTokens,
): void {
  replaceContextMemoryProject(
    db,
    projectId,
    store.snapshots().flatMap((snapshot) => rowsOf(snapshot, estimate)),
  );
}
