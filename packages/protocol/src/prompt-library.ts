export const PROMPT_LIBRARY_TITLE_MAX_LENGTH = 200;
export const PROMPT_LIBRARY_BODY_MAX_LENGTH = 100_000;
export const PROMPT_LIBRARY_TAG_MAX_LENGTH = 48;
export const PROMPT_LIBRARY_MAX_TAGS = 20;
/** The daemon clamps a client `updatedAt` to at most this far ahead of its own clock. */
export const PROMPT_LIBRARY_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface PromptLibraryEntry {
  id: string;
  title: string;
  body: string;
  tags: string[];
  updatedAt: string;
  deleted: boolean;
}

export function normalizePromptLibraryTag(tag: string): string {
  return tag.replace(/\s+/g, " ").trim();
}

export function promptLibraryTagKey(tag: string): string {
  return normalizePromptLibraryTag(tag).toLowerCase();
}

export function normalizePromptLibraryTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of tags) {
    const tag = normalizePromptLibraryTag(raw);
    if (tag.length === 0) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(tag.slice(0, PROMPT_LIBRARY_TAG_MAX_LENGTH));
    if (normalized.length >= PROMPT_LIBRARY_MAX_TAGS) break;
  }
  return normalized;
}

export function renamePromptLibraryTag(
  tags: readonly string[],
  from: string,
  to: string,
): string[] {
  const fromKey = promptLibraryTagKey(from);
  const toTag = normalizePromptLibraryTag(to);
  return normalizePromptLibraryTags(
    tags.map((tag) => (promptLibraryTagKey(tag) === fromKey ? toTag : tag)),
  );
}

export function removePromptLibraryTag(tags: readonly string[], tag: string): string[] {
  const key = promptLibraryTagKey(tag);
  return tags.filter((candidate) => promptLibraryTagKey(candidate) !== key);
}

/**
 * LWW ordering for the library. Invalid timestamps sort oldest so a malformed record can never
 * win over a real edit.
 */
export function comparePromptLibraryUpdatedAt(left: string, right: string): number {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  const leftValue = Number.isNaN(leftMs) ? Number.NEGATIVE_INFINITY : leftMs;
  const rightValue = Number.isNaN(rightMs) ? Number.NEGATIVE_INFINITY : rightMs;
  if (leftValue === rightValue) return 0;
  return leftValue < rightValue ? -1 : 1;
}

type PromptLibraryOrderKey = Pick<PromptLibraryEntry, "id" | "updatedAt" | "deleted">;

/**
 * Total order for LWW: `updatedAt`, then a tombstone beats a live entry, then `id`. Every replica
 * resolves a timestamp tie the same way.
 */
export function comparePromptLibraryEntries(
  left: PromptLibraryOrderKey,
  right: PromptLibraryOrderKey,
): number {
  const byTime = comparePromptLibraryUpdatedAt(left.updatedAt, right.updatedAt);
  if (byTime !== 0) return byTime;
  if (left.deleted !== right.deleted) return left.deleted ? 1 : -1;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

/** True when `candidate` should replace `current`; an identical write (full tie) is accepted. */
export function isNewerPromptLibraryEntry(
  candidate: PromptLibraryOrderKey,
  current: PromptLibraryOrderKey | undefined,
): boolean {
  if (!current) return true;
  return comparePromptLibraryEntries(candidate, current) >= 0;
}

/** A tombstone keeps only what LWW needs; the content is dropped. */
export function promptLibraryTombstone(input: {
  id: string;
  updatedAt: string;
}): PromptLibraryEntry {
  return { id: input.id, title: "", body: "", tags: [], updatedAt: input.updatedAt, deleted: true };
}

export function promptLibraryTitleFromBody(body: string): string {
  const firstLine =
    body
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  return firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine;
}
