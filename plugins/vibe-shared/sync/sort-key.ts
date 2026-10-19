// Fractional-index helpers on top of contract/sort-key.ts.
//
// Concurrent moves never conflict: a move is a single-field LWW write of `sort_key`, and the
// display order is (sort_key, id) - total and identical on every replica. To keep two devices that
// insert between the same neighbours from producing the same key, new keys get a random suffix
// (jitter). Key length stays bounded: when a key gets too long the column is rebalanced.

import { sortKeyBetween } from "../contract/sort-key";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const BASE = ALPHABET.length;

export const DEFAULT_MAX_SORT_KEY_LENGTH = 24;

export interface SortKeyOptions {
  /** Random source in [0,1); default Math.random. */
  random?: () => number;
  /** Random suffix length (0 disables jitter). Default 2. */
  jitter?: number;
}

/**
 * A key strictly between `prev` and `next` (null = open end), with a random suffix so concurrent
 * identical inserts almost never collide. Keys never end in "0". If prev >= next the key goes
 * right after `prev`.
 */
export function generateSortKey(
  prev: string | null,
  next: string | null,
  opts: SortKeyOptions = {},
): string {
  const random = opts.random ?? Math.random;
  const jitter = opts.jitter ?? 2;
  // Duplicate / inverted neighbours (a rare jitter collision, or a concurrent edit not yet merged)
  // have no key strictly between them: place the card after `prev` instead of throwing.
  let key = sortKeyBetween(prev, prev !== null && next !== null && prev >= next ? null : next);
  // Appending to the midpoint keeps it strictly inside (prev, next): the midpoint already
  // differs from `next` at an earlier digit.
  for (let i = 0; i < jitter; i++) key += ALPHABET[1 + Math.floor(random() * (BASE - 1))];
  return key;
}

export function needsRebalance(key: string, maxLength = DEFAULT_MAX_SORT_KEY_LENGTH): boolean {
  return key.length > maxLength;
}

/** `count` evenly spaced, equal-length, ordered keys (none ends in "0"). */
export function evenSortKeys(count: number): string[] {
  if (count <= 0) return [];
  let width = 1;
  while (BASE ** width < (count + 1) * 4) width++;
  const space = BigInt(BASE) ** BigInt(width);
  const out: string[] = [];
  for (let i = 1; i <= count; i++) {
    let v = (space * BigInt(i)) / BigInt(count + 1);
    if (v % BigInt(BASE) === 0n) v += 1n;
    out.push(v.toString(BASE).padStart(width, "0"));
  }
  return out;
}

/** Fresh keys for an already ordered list of ids (the list order is kept). */
export function rebalanceSortKeys(orderedIds: readonly string[]): Map<string, string> {
  const keys = evenSortKeys(orderedIds.length);
  return new Map(orderedIds.map((id, i) => [id, keys[i] as string]));
}

/** Display order: sort_key, then id as the deterministic tiebreak. */
export function compareByOrder(
  a: { sortKey: string; id: string },
  b: { sortKey: string; id: string },
): number {
  if (a.sortKey !== b.sortKey) return a.sortKey < b.sortKey ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
