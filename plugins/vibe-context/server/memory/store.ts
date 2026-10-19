// File-backed memory store. The Markdown files under <repo>/.vibe/ are the source of truth;
// the memory_entry table is a derived index (see index-sync.ts). All content writes go through
// the methods taking an Actor, which are permission-checked (master is the only writer of
// project memory). Budget enforcement and dedupe run inside every write, deterministically.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { budgetFor, demoteToBudget, truncateBody } from "./budget";
import {
  dedupeEntries,
  newEntryId,
  parseMemoryFile,
  sanitizeTag,
  serializeMemoryFile,
  totalTokens,
  type MemoryEntry,
  type ParsedMemoryFile,
} from "./entries";
import {
  archiveFileOf,
  assertCanWrite,
  createLayout,
  FILE_POLICY,
  isMemoryFileRef,
  MemoryPermissionError,
  PROJECT_MEMORY_FILES,
  workerFile,
  type Actor,
  type Layout,
  type MemoryFileRef,
} from "./layout";
import { estimateTokens, type TokenEstimator } from "./tokens";

export interface FileSnapshot {
  file: MemoryFileRef;
  live: MemoryEntry[];
  archived: MemoryEntry[];
}

export interface WriteResult {
  file: MemoryFileRef;
  /** The entry as stored (after dedupe it may carry an older id). Null if it was demoted at once. */
  entry: MemoryEntry | null;
  /** Entries moved to the archive file by this write (budget overflow or supersede). */
  demoted: MemoryEntry[];
  /** Ids removed by dedupe. */
  dedupedIds: string[];
  tokens: number;
  budget: number;
}

export interface MemoryStoreOptions {
  projectRoot: string;
  /** Directory holding user/user_directives.md. Defaults to ~/.vibe. */
  userHome?: string;
  /** Current model context window; read on every write so a model switch re-budgets. */
  contextWindowTokens: number | (() => number);
  estimate?: TokenEstimator;
  now?: () => Date;
  /** Called after every file change with the new live + archived entries (feeds memory_entry). */
  onChange?: (snapshot: FileSnapshot) => void;
}

export interface InstructionFile {
  name: string;
  text: string;
}

const INSTRUCTION_ORDER = ["project_goals.md", "user_directives.md", "prd.md"];

function readText(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

const titleOf = (file: string) => file.replace(/\.md$/, "").split("/").slice(-2).join(" / ");

export function createMemoryStore(options: MemoryStoreOptions) {
  const layout: Layout = createLayout(options.projectRoot, options.userHome);
  const estimate = options.estimate ?? estimateTokens;
  const now = options.now ?? (() => new Date());
  const iso = () => now().toISOString();
  const windowTokens = () =>
    typeof options.contextWindowTokens === "function"
      ? options.contextWindowTokens()
      : options.contextWindowTokens;

  function load(path: string, title: string): ParsedMemoryFile {
    const text = readText(path);
    if (text === null) return { preamble: `# ${title}`, entries: [] };
    return parseMemoryFile(text);
  }
  const loadLive = (file: MemoryFileRef) => load(layout.fileOf(file), titleOf(file));
  const loadArchive = (file: MemoryFileRef) =>
    load(layout.fileOf(archiveFileOf(file)), `${titleOf(file)} archive (demoted entries, read on demand)`);

  /** Apply `change` to the live entries, then dedupe, enforce the budget, persist and notify. */
  function mutate(
    file: MemoryFileRef,
    change: (live: MemoryEntry[]) => { live: MemoryEntry[]; archive?: MemoryEntry[] },
    track?: MemoryEntry,
  ): WriteResult {
    const liveFile = loadLive(file);
    const archive = loadArchive(file);
    const changed = change(liveFile.entries);
    const deduped = dedupeEntries(changed.live);
    const budget = budgetFor(file, windowTokens());
    const draft: ParsedMemoryFile = { preamble: liveFile.preamble, entries: deduped.entries };
    const { kept, demoted } = demoteToBudget(draft, budget, estimate);
    const toArchive = [...(changed.archive ?? []), ...demoted];
    const finalLive = { preamble: liveFile.preamble, entries: kept };

    if (toArchive.length) {
      archive.entries = dedupeEntries([...archive.entries, ...toArchive]).entries;
      atomicWrite(layout.fileOf(archiveFileOf(file)), serializeMemoryFile(archive));
    }
    atomicWrite(layout.fileOf(file), serializeMemoryFile(finalLive));
    options.onChange?.({ file, live: kept, archived: archive.entries });

    const stored = track
      ? (kept.find((e) => e.id === track.id) ??
        kept.find((e) => !deduped.removedIds.includes(e.id) && e.body === track.body) ??
        null)
      : null;
    return {
      file,
      entry: stored,
      demoted: toArchive,
      dedupedIds: deduped.removedIds,
      tokens: totalTokens(finalLive, estimate),
      budget,
    };
  }

  function newEntry(body: string, tag?: string): MemoryEntry {
    const t = iso();
    return { id: newEntryId(), created: t, touched: t, tag: sanitizeTag(tag), body: body.trim() };
  }

  return {
    layout,

    // ---- read side (anyone) ----

    readUserDirectives: (): string | null => readText(layout.userDirectives),

    /** Project instructions (user-owned, never written by the API): goals, prompt, PRD, then others. */
    readInstructions(): InstructionFile[] {
      if (!existsSync(layout.instructionsDir)) return [];
      const names = readdirSync(layout.instructionsDir).filter((n) => n.endsWith(".md"));
      const rank = (n: string) => {
        const i = INSTRUCTION_ORDER.indexOf(n);
        return i < 0 ? INSTRUCTION_ORDER.length : i;
      };
      names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
      return names.map((name) => ({
        name,
        text: readFileSync(join(layout.instructionsDir, name), "utf8"),
      }));
    },

    read(file: MemoryFileRef): ParsedMemoryFile & { tokens: number; budget: number } {
      const f = loadLive(file);
      return { ...f, tokens: totalTokens(f, estimate), budget: budgetFor(file, windowTokens()) };
    },

    readArchive: (file: MemoryFileRef): ParsedMemoryFile => loadArchive(file),

    listWorkers(): string[] {
      const dir = join(layout.vibeDir, "workers");
      if (!existsSync(dir)) return [];
      return readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "MEMORY.md")))
        .map((d) => d.name)
        .sort();
    },

    /** Every live file that exists, with archive, for a full memory_entry rebuild. */
    snapshots(): FileSnapshot[] {
      const files: MemoryFileRef[] = [
        ...PROJECT_MEMORY_FILES,
        ...this.listWorkers().map((a) => workerFile(a)),
      ];
      return files
        .filter((f) => existsSync(layout.fileOf(f)) || existsSync(layout.fileOf(archiveFileOf(f))))
        .map((file) => ({
          file,
          live: loadLive(file).entries,
          archived: loadArchive(file).entries,
        }));
    },

    /**
     * Mark entries as used (recency bookkeeping done by the daemon when it injects them). Not a
     * content write, so it needs no actor. Unknown ids are ignored.
     */
    touch(file: MemoryFileRef, ids: string[]): void {
      const wanted = new Set(ids);
      if (!wanted.size || !existsSync(layout.fileOf(file))) return;
      const f = loadLive(file);
      const t = iso();
      let hit = false;
      for (const e of f.entries) {
        if (wanted.has(e.id)) {
          e.touched = t;
          hit = true;
        }
      }
      if (!hit) return;
      atomicWrite(layout.fileOf(file), serializeMemoryFile(f));
      options.onChange?.({ file, live: f.entries, archived: loadArchive(file).entries });
    },

    // ---- write side (permission-checked) ----

    /** PROJECT_STATE.md: overwrite. If the text exceeds the budget, the full text is archived and a truncated head stays live. */
    writeProjectState(actor: Actor, body: string): WriteResult {
      assertCanWrite(actor, "PROJECT_STATE.md");
      const budget = budgetFor("PROJECT_STATE.md", windowTokens());
      let text = body.trim();
      let overflow: MemoryEntry | undefined;
      const probe = newEntry(text);
      if (totalTokens({ preamble: "# PROJECT STATE", entries: [probe] }, estimate) > budget) {
        overflow = { ...probe, tag: "overflow" };
        text = truncateBody(text, Math.max(1, budget - estimate("# PROJECT STATE") - 40), estimate);
      }
      const entry = newEntry(text, "state");
      return mutate(
        "PROJECT_STATE.md",
        (live) => {
          const prev = live[0];
          if (prev) {
            entry.id = prev.id;
            entry.created = prev.created;
          }
          return { live: [entry], archive: overflow ? [overflow] : [] };
        },
        entry,
      );
    },

    /** Append an entry to a project memory file (not PROJECT_STATE) or to a worker MEMORY.md. */
    addEntry(actor: Actor, file: MemoryFileRef, input: { body: string; tag?: string }): WriteResult {
      assertCanWrite(actor, file);
      if (file in FILE_POLICY && FILE_POLICY[file as keyof typeof FILE_POLICY] === "overwrite") {
        throw new MemoryPermissionError(`${file} is overwrite-only; use writeProjectState`);
      }
      const entry = newEntry(input.body, input.tag);
      return mutate(file, (live) => ({ live: [...live, entry] }), entry);
    },

    /**
     * DECISIONS.md: a new decision supersedes the listed ids and every live decision with the same
     * non-empty tag (the topic). Superseded entries move to DECISIONS_ARCHIVE.md, annotated.
     */
    recordDecision(
      actor: Actor,
      input: { body: string; tag?: string; supersedes?: string[] },
    ): WriteResult {
      assertCanWrite(actor, "DECISIONS.md");
      const entry = newEntry(input.body, input.tag);
      const explicit = new Set(input.supersedes ?? []);
      return mutate(
        "DECISIONS.md",
        (live) => {
          const keep: MemoryEntry[] = [];
          const gone: MemoryEntry[] = [];
          for (const e of live) {
            const replaced = explicit.has(e.id) || (entry.tag !== "" && e.tag === entry.tag);
            if (replaced) gone.push({ ...e, body: `${e.body}\n\n_(superseded by ${entry.id})_` });
            else keep.push(e);
          }
          return { live: [...keep, entry], archive: gone };
        },
        entry,
      );
    },

    /** Master fixing contradictions: drop an entry to the archive (never deleted outright). */
    archiveEntry(actor: Actor, file: MemoryFileRef, id: string): WriteResult {
      assertCanWrite(actor, file);
      return mutate(file, (live) => ({
        live: live.filter((e) => e.id !== id),
        archive: live.filter((e) => e.id === id),
      }));
    },

    /** Re-run dedupe + budget on a file, e.g. after switching to a smaller-window model. */
    enforce(actor: Actor, file: MemoryFileRef): WriteResult {
      assertCanWrite(actor, file);
      return mutate(file, (live) => ({ live }));
    },

    isMemoryFileRef,
  };
}

export type MemoryStore = ReturnType<typeof createMemoryStore>;
