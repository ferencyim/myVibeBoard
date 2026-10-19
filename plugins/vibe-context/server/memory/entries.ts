// Memory files are Markdown. Everything before the first entry marker is the preamble (title,
// notes) and is preserved verbatim. Each entry starts with a one-line HTML-comment marker and
// runs to the next marker or end of file:
//   <!-- vibe:entry id=m_ab12 created=2026-01-01T00:00:00.000Z touched=... tag=ui -->
//   body...

import { randomBytes } from "node:crypto";
import { estimateTokens, type TokenEstimator } from "./tokens";

export interface MemoryEntry {
  id: string;
  created: string;
  touched: string;
  /** No whitespace, may be empty. For DECISIONS the tag doubles as the topic key. */
  tag: string;
  body: string;
}

export interface ParsedMemoryFile {
  preamble: string;
  entries: MemoryEntry[];
}

const MARKER_PREFIX = "<!-- vibe:entry";
const MARKER_RE = /^<!-- vibe:entry\b(.*?)-->\s*$/;

export class MemoryFormatError extends Error {}

export function newEntryId(): string {
  return `m_${randomBytes(5).toString("hex")}`;
}

export function sanitizeTag(tag: string | undefined): string {
  return (tag ?? "").trim().replace(/[\s"<>]+/g, "-");
}

function attrs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/(\w+)=(\S+)/g)) out[m[1]] = m[2];
  return out;
}

export function parseMemoryFile(text: string): ParsedMemoryFile {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const preamble: string[] = [];
  const entries: MemoryEntry[] = [];
  let current: { entry: MemoryEntry; body: string[] } | null = null;
  const flush = () => {
    if (current) entries.push({ ...current.entry, body: current.body.join("\n").trim() });
    current = null;
  };
  for (const line of lines) {
    const m = MARKER_RE.exec(line);
    if (m) {
      flush();
      const a = attrs(m[1]);
      const epoch = new Date(0).toISOString();
      current = {
        entry: {
          id: a.id ?? newEntryId(),
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

export function serializeEntry(e: MemoryEntry): string {
  if (e.body.split("\n").some((l) => l.startsWith(MARKER_PREFIX))) {
    throw new MemoryFormatError("Entry body must not contain a vibe:entry marker line");
  }
  const tag = e.tag ? ` tag=${e.tag}` : "";
  return `${MARKER_PREFIX} id=${e.id} created=${e.created} touched=${e.touched}${tag} -->\n${e.body.trim()}`;
}

export function serializeMemoryFile(file: ParsedMemoryFile): string {
  const parts = [file.preamble.trimEnd(), ...file.entries.map(serializeEntry)].filter(Boolean);
  return parts.length ? `${parts.join("\n\n")}\n` : "";
}

export function entryTokens(e: MemoryEntry, estimate: TokenEstimator = estimateTokens): number {
  return estimate(serializeEntry(e));
}

export function totalTokens(
  file: ParsedMemoryFile,
  estimate: TokenEstimator = estimateTokens,
): number {
  return estimate(file.preamble) + file.entries.reduce((n, e) => n + entryTokens(e, estimate), 0);
}

const normalize = (body: string) => body.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Collapse entries with identical normalized body. The survivor keeps the oldest id (stable for
 * memory_entry), the oldest `created`, the newest `touched` and the tag of the most recently
 * touched copy. Order of first appearance is preserved.
 */
export function dedupeEntries(entries: MemoryEntry[]): {
  entries: MemoryEntry[];
  removedIds: string[];
} {
  const byBody = new Map<string, MemoryEntry>();
  const removedIds: string[] = [];
  for (const e of entries) {
    const key = normalize(e.body);
    const prev = byBody.get(key);
    if (!prev) {
      byBody.set(key, { ...e });
      continue;
    }
    const [older, newer] = prev.created <= e.created ? [prev, e] : [e, prev];
    const freshest = prev.touched >= e.touched ? prev : e;
    byBody.set(key, {
      id: older.id,
      created: older.created,
      touched: freshest.touched,
      tag: freshest.tag || newer.tag || older.tag,
      body: freshest.body,
    });
    removedIds.push(newer.id);
  }
  return { entries: [...byBody.values()], removedIds };
}
