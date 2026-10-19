// MemoryPort: how the master's card_done reply reaches the project memory files.
//
// Plugins cannot import each other, and the budgeted store lives in vibe-context (WP-30), so this
// is a deliberately small writer for the same on-disk format (`<!-- vibe:entry id= created=
// touched= tag= -->` markers under `<repo>/.vibe/`): vibe-context reads these files as they are
// ("files win"). Budget enforcement and archive demotion stay with vibe-context's `enforce`; the
// master only adds, supersedes and archives entries. The master is the only caller, which keeps the
// "master is the only writer of project memory" rule.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MemoryUpdate } from "../assess/schema";

export const PROJECT_FILES = ["PROJECT_STATE.md", "DECISIONS.md", "LESSONS.md", "INDEX.md"] as const;
export type ProjectFile = (typeof PROJECT_FILES)[number];

export interface MemoryEntryView {
  id: string;
  tag: string;
  body: string;
  touched: string;
}

export interface ApplyResult {
  stateWritten: boolean;
  added: number;
  superseded: number;
  archived: number;
  duplicates: number;
}

export interface MemoryPort {
  /** Live entries of the four project memory files. */
  snapshot(repoPath: string): Record<ProjectFile, MemoryEntryView[]>;
  apply(repoPath: string, update: MemoryUpdate): ApplyResult;
}

interface Entry {
  id: string;
  created: string;
  touched: string;
  tag: string;
  body: string;
}
interface Parsed {
  preamble: string;
  entries: Entry[];
}

const MARKER = /^<!-- vibe:entry\b(.*?)-->\s*$/;
const attrs = (text: string) => {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/(\w+)=(\S+)/g)) out[m[1]!] = m[2]!;
  return out;
};
const newId = () => `m_${randomBytes(5).toString("hex")}`;
const sanitizeTag = (tag: string) => tag.trim().replace(/[\s"<>]+/g, "-");
const normalize = (body: string) => body.toLowerCase().replace(/\s+/g, " ").trim();

export function parseMemory(text: string): Parsed {
  const preamble: string[] = [];
  const entries: Entry[] = [];
  let current: { entry: Entry; body: string[] } | null = null;
  const flush = () => {
    if (current) entries.push({ ...current.entry, body: current.body.join("\n").trim() });
    current = null;
  };
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const m = MARKER.exec(line);
    if (m) {
      flush();
      const a = attrs(m[1]!);
      const epoch = new Date(0).toISOString();
      current = {
        entry: {
          id: a.id ?? newId(),
          created: a.created ?? epoch,
          touched: a.touched ?? a.created ?? epoch,
          tag: a.tag ?? "",
          body: "",
        },
        body: [],
      };
    } else if (current) current.body.push(line);
    else preamble.push(line);
  }
  flush();
  return { preamble: preamble.join("\n").trimEnd(), entries };
}

function serializeEntry(e: Entry): string {
  if (e.body.split("\n").some((l) => l.startsWith("<!-- vibe:entry"))) {
    throw new Error("A memory entry body must not contain a vibe:entry marker line");
  }
  const tag = e.tag ? ` tag=${e.tag}` : "";
  return `<!-- vibe:entry id=${e.id} created=${e.created} touched=${e.touched}${tag} -->\n${e.body.trim()}`;
}

export function serializeMemory(file: Parsed): string {
  const parts = [file.preamble.trimEnd(), ...file.entries.map(serializeEntry)].filter(Boolean);
  return parts.length ? `${parts.join("\n\n")}\n` : "";
}

export function createFileMemoryPort(now: () => Date = () => new Date()): MemoryPort {
  const iso = () => now().toISOString();
  const pathOf = (repo: string, file: string) => join(repo, ".vibe", file);
  const archiveOf = (file: string) => file.replace(/\.md$/, "_ARCHIVE.md");
  const titleOf = (file: string) => file.replace(/\.md$/, "").replaceAll("_", " ");

  function load(repo: string, file: string, title = titleOf(file)): Parsed {
    const path = pathOf(repo, file);
    return existsSync(path)
      ? parseMemory(readFileSync(path, "utf8"))
      : { preamble: `# ${title}`, entries: [] };
  }
  function save(repo: string, file: string, parsed: Parsed): void {
    const path = pathOf(repo, file);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, serializeMemory(parsed), "utf8");
    renameSync(tmp, path);
  }
  const loadArchive = (repo: string, file: string) =>
    load(repo, archiveOf(file), `${titleOf(file)} archive (demoted entries, read on demand)`);

  const entry = (body: string, tag: string): Entry => ({
    id: newId(),
    created: iso(),
    touched: iso(),
    tag: sanitizeTag(tag),
    body: body.trim(),
  });

  return {
    snapshot(repo) {
      const out = {} as Record<ProjectFile, MemoryEntryView[]>;
      for (const file of PROJECT_FILES) {
        out[file] = load(repo, file).entries.map(({ id, tag, body, touched }) => ({
          id,
          tag,
          body,
          touched,
        }));
      }
      return out;
    },

    apply(repo, update) {
      const result: ApplyResult = { stateWritten: false, added: 0, superseded: 0, archived: 0, duplicates: 0 };
      const archiveAdds = new Map<string, Entry[]>();
      const toArchive = (file: string, e: Entry, note?: string) => {
        const list = archiveAdds.get(file) ?? [];
        list.push(note ? { ...e, body: `${e.body}\n\n${note}` } : e);
        archiveAdds.set(file, list);
      };

      if (update.state?.trim()) {
        const state = load(repo, "PROJECT_STATE.md");
        const prev = state.entries[0];
        save(repo, "PROJECT_STATE.md", {
          preamble: state.preamble,
          entries: [
            {
              ...entry(update.state, "state"),
              ...(prev ? { id: prev.id, created: prev.created } : {}),
            },
          ],
        });
        result.stateWritten = true;
      }

      // Decisions: a new decision replaces listed ids and same-tag decisions.
      let decisions = load(repo, "DECISIONS.md");
      for (const d of update.decisions) {
        const fresh = entry(d.body, d.tag);
        if (decisions.entries.some((e) => normalize(e.body) === normalize(fresh.body))) {
          result.duplicates++;
          continue;
        }
        const keep: Entry[] = [];
        for (const e of decisions.entries) {
          const replaced = d.supersedes.includes(e.id) || (fresh.tag !== "" && e.tag === fresh.tag);
          if (replaced) {
            toArchive("DECISIONS.md", e, `_(superseded by ${fresh.id})_`);
            result.superseded++;
          } else keep.push(e);
        }
        decisions = { preamble: decisions.preamble, entries: [...keep, fresh] };
        result.added++;
      }
      const touched: Record<string, Parsed> = { "DECISIONS.md": decisions };

      for (const [file, items] of [
        ["LESSONS.md", update.lessons],
        ["INDEX.md", update.index],
      ] as const) {
        let parsed = load(repo, file);
        for (const item of items) {
          const fresh = entry(item.body, item.tag);
          const same = parsed.entries.find((e) => normalize(e.body) === normalize(fresh.body));
          if (same) {
            same.touched = iso();
            result.duplicates++;
          } else {
            parsed = { preamble: parsed.preamble, entries: [...parsed.entries, fresh] };
            result.added++;
          }
        }
        touched[file] = parsed;
      }

      for (const { file, id } of update.archive) {
        const parsed = touched[file] ?? load(repo, file);
        const hit = parsed.entries.find((e) => e.id === id);
        if (!hit) continue;
        touched[file] = { preamble: parsed.preamble, entries: parsed.entries.filter((e) => e.id !== id) };
        toArchive(file, hit);
        result.archived++;
      }

      for (const [file, parsed] of Object.entries(touched)) {
        const changed = parsed.entries.length > 0 || existsSync(pathOf(repo, file));
        if (changed) save(repo, file, parsed);
      }
      for (const [file, entries] of archiveAdds) {
        const archive = loadArchive(repo, file);
        const known = new Set(archive.entries.map((e) => e.id));
        save(repo, archiveOf(file), {
          preamble: archive.preamble,
          entries: [...archive.entries, ...entries.filter((e) => !known.has(e.id))],
        });
      }
      return result;
    },
  };
}
