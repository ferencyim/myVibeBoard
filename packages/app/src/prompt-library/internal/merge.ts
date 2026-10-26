import type { PromptLibraryEntry } from "@getpaseo/protocol/prompt-library";
import {
  comparePromptLibraryEntries,
  isNewerPromptLibraryEntry,
  promptLibraryTagKey,
} from "@getpaseo/protocol/prompt-library";

export interface MergeResult {
  changed: boolean;
  /** Pending local writes discarded because the remote entry sorted after them. */
  overridden: number;
}

/**
 * Last-write-wins merge of a remote snapshot into the local replica.
 *
 * A pending local write is the user's newest intent. It yields only to a remote entry that sorts
 * strictly after it (see `comparePromptLibraryEntries`); a full tie stays local so the queued
 * write can be retried. Tombstones travel through the same comparison as live entries.
 */
export function mergeRemoteEntries(input: {
  entries: Map<string, PromptLibraryEntry>;
  pending: Map<string, PromptLibraryEntry>;
  remote: readonly PromptLibraryEntry[];
}): MergeResult {
  let changed = false;
  let overridden = 0;
  for (const remoteEntry of input.remote) {
    const pendingEntry = input.pending.get(remoteEntry.id);
    if (pendingEntry) {
      if (comparePromptLibraryEntries(remoteEntry, pendingEntry) > 0) {
        input.pending.delete(remoteEntry.id);
        input.entries.set(remoteEntry.id, remoteEntry);
        overridden += 1;
        changed = true;
      }
      continue;
    }
    const localEntry = input.entries.get(remoteEntry.id);
    if (!localEntry || isNewerPromptLibraryEntry(remoteEntry, localEntry)) {
      input.entries.set(remoteEntry.id, remoteEntry);
      changed = true;
    }
  }
  return { changed, overridden };
}

export function sortVisibleEntries(entries: Iterable<PromptLibraryEntry>): PromptLibraryEntry[] {
  return [...entries]
    .filter((entry) => !entry.deleted)
    .sort((left, right) => {
      return comparePromptLibraryEntries(right, left);
    });
}

export function collectPromptTags(entries: Iterable<PromptLibraryEntry>): string[] {
  const tags = new Map<string, string>();
  for (const entry of entries) {
    if (entry.deleted) continue;
    for (const tag of entry.tags) {
      const key = promptLibraryTagKey(tag);
      if (!tags.has(key)) tags.set(key, tag);
    }
  }
  return [...tags.values()].sort((left, right) =>
    left.localeCompare(right, undefined, { sensitivity: "base" }),
  );
}

export function filterPromptEntries(input: {
  entries: readonly PromptLibraryEntry[];
  query: string;
  tag: string | null;
}): PromptLibraryEntry[] {
  const query = input.query.trim().toLowerCase();
  const tagKey = input.tag ? promptLibraryTagKey(input.tag) : null;
  return input.entries.filter((entry) => {
    if (tagKey && !entry.tags.some((candidate) => promptLibraryTagKey(candidate) === tagKey)) {
      return false;
    }
    if (!query) return true;
    return (
      entry.title.toLowerCase().includes(query) ||
      entry.body.toLowerCase().includes(query) ||
      entry.tags.some((tag) => tag.toLowerCase().includes(query))
    );
  });
}

export function hasPromptTag(entry: PromptLibraryEntry, tag: string): boolean {
  const key = promptLibraryTagKey(tag);
  return entry.tags.some((candidate) => promptLibraryTagKey(candidate) === key);
}
