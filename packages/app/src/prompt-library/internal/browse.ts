import type { PromptLibraryEntry } from "@getpaseo/protocol/prompt-library";
import { promptLibraryTagKey } from "@getpaseo/protocol/prompt-library";
import { filterPromptEntries } from "./merge";

export type PromptSort = "updated" | "title";

/** Filter id for the "untagged" bucket; cannot collide with a normalized tag. */
export const UNTAGGED_FILTER = "\u0000untagged";

export interface PromptFilter {
  query: string;
  /** Selected tags; an entry must carry every one of them. */
  tags: readonly string[];
  untagged?: boolean;
}

export function filterPrompts(
  entries: readonly PromptLibraryEntry[],
  filter: PromptFilter,
): PromptLibraryEntry[] {
  const keys = filter.tags.map(promptLibraryTagKey);
  return filterPromptEntries({ entries, query: filter.query, tag: null }).filter((entry) => {
    if (filter.untagged) return entry.tags.length === 0;
    if (keys.length === 0) return true;
    const own = new Set(entry.tags.map(promptLibraryTagKey));
    return keys.every((key) => own.has(key));
  });
}

/** `updated` keeps the incoming order (the library already sorts newest first). */
export function sortPrompts(
  entries: readonly PromptLibraryEntry[],
  sort: PromptSort,
): PromptLibraryEntry[] {
  if (sort === "updated") return [...entries];
  return [...entries].sort((left, right) =>
    left.title.localeCompare(right.title, undefined, { sensitivity: "base" }),
  );
}

export function countPromptTags(entries: readonly PromptLibraryEntry[]): {
  byTag: Map<string, number>;
  untagged: number;
} {
  const byTag = new Map<string, number>();
  let untagged = 0;
  for (const entry of entries) {
    if (entry.tags.length === 0) untagged += 1;
    for (const tag of entry.tags) {
      const key = promptLibraryTagKey(tag);
      byTag.set(key, (byTag.get(key) ?? 0) + 1);
    }
  }
  return { byTag, untagged };
}

export function toggleTagSelection(selected: readonly string[], tag: string): string[] {
  const key = promptLibraryTagKey(tag);
  return selected.some((candidate) => promptLibraryTagKey(candidate) === key)
    ? selected.filter((candidate) => promptLibraryTagKey(candidate) !== key)
    : [...selected, tag];
}

/** Drops selected tags that no longer exist (renamed or deleted elsewhere). */
export function pruneTagSelection(selected: readonly string[], tags: readonly string[]): string[] {
  const known = new Set(tags.map(promptLibraryTagKey));
  return selected.filter((tag) => known.has(promptLibraryTagKey(tag)));
}

export function suggestPromptTags(input: {
  allTags: readonly string[];
  selected: readonly string[];
  text: string;
  limit?: number;
}): string[] {
  const text = input.text.trim().toLowerCase();
  const taken = new Set(input.selected.map(promptLibraryTagKey));
  return input.allTags
    .filter((tag) => !taken.has(promptLibraryTagKey(tag)))
    .filter((tag) => text.length === 0 || tag.toLowerCase().includes(text))
    .slice(0, input.limit ?? 6);
}
