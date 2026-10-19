// GENERATED FROM plugins/vibe-shared — DO NOT EDIT (run: node scripts/vibe/sync-shared.mjs)
// Lexicographic "between" keys for card ordering (fractional-index style, base 36).
// Minimal version so the command layer can place cards; WP-13 owns the full algorithm,
// tie-breaking for concurrent identical keys, and fuzz tests. Keys never end in "0".

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const BASE = ALPHABET.length;

function digit(ch: string | undefined): number {
  const i = ALPHABET.indexOf(ch ?? "");
  if (i < 0) throw new Error(`Invalid sort key character: ${ch}`);
  return i;
}

function digitOr0(s: string, i: number): number {
  return i < s.length ? digit(s[i]) : 0;
}

/** A key strictly between `prev` (exclusive, null = start) and `next` (exclusive, null = end). */
export function sortKeyBetween(prev: string | null, next: string | null): string {
  const a = prev ?? "";
  if (next !== null && a >= next) throw new Error(`sortKeyBetween: ${a} must be < ${next}`);
  let out = "";
  let bounded = next !== null;
  for (let i = 0; ; i++) {
    const p = i < a.length ? digit(a[i]) : 0;
    const n = bounded ? digitOr0(next as string, i) : BASE;
    if (p === n) {
      out += ALPHABET[p];
      continue;
    }
    if (n - p > 1) return out + ALPHABET[Math.floor((p + n) / 2)];
    out += ALPHABET[p];
    bounded = false;
  }
}

export function sortKeyAfter(last: string | null): string {
  return sortKeyBetween(last, null);
}
