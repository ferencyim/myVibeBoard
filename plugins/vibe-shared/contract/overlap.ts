// Do two file-glob lists touch a common file? Pure and conservative: when unsure it says "yes", so
// the scheduler errs on the side of not running two cards on the same files at once, and the board
// never runs two sub-agents of a card on the same files (WP-106).
//
// Rules: separators are "/" (backslashes are converted), "**" matches any number of segments, "*"/"?"
// match inside one segment, and a path that ends before the other pattern does counts as a directory
// containing it ("src/app" overlaps "src/app/**" and "src/app/a.ts").

const norm = (p: string): string[] =>
  p
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .split("/")
    .filter((s) => s !== "" && s !== ".");

const hasWild = (s: string) => /[*?[]/.test(s);

function segRegex(seg: string): RegExp {
  const body = seg.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${body}$`, "i");
}

function segmentsOverlap(a: string, b: string): boolean {
  const wa = hasWild(a);
  const wb = hasWild(b);
  if (!wa && !wb) return a.toLowerCase() === b.toLowerCase();
  if (wa && !wb) return segRegex(a).test(b);
  if (wb && !wa) return segRegex(b).test(a);
  // Two wildcard segments: compare the literal text before the first and after the last wildcard.
  const edge = (s: string) => [s.slice(0, s.search(/[*?[]/)), s.slice(s.search(/[*?[][^*?[]*$/) + 1)] as const;
  const [pa, sa] = edge(a.toLowerCase());
  const [pb, sb] = edge(b.toLowerCase());
  return (pa.startsWith(pb) || pb.startsWith(pa)) && (sa.endsWith(sb) || sb.endsWith(sa));
}

// A plain last segment without wildcard or extension ("app", "Makefile") may be a directory.
const dirLike = (seg: string | undefined) => seg !== undefined && !hasWild(seg) && !seg.includes(".");

function overlapSegs(a: readonly string[], b: readonly string[], lastA: string | undefined, lastB: string | undefined): boolean {
  if (a.length === 0 || b.length === 0) {
    const [ended, rest, last] = a.length === 0 ? [a, b, lastA] : [b, a, lastB];
    return rest.every((s) => s === "**") || ended.length === rest.length || dirLike(last);
  }
  if (a[0] === "**") return overlapSegs(a.slice(1), b, lastA, lastB) || overlapSegs(a, b.slice(1), lastA, lastB);
  if (b[0] === "**") return overlapSegs(a, b.slice(1), lastA, lastB) || overlapSegs(a.slice(1), b, lastA, lastB);
  return segmentsOverlap(a[0]!, b[0]!) && overlapSegs(a.slice(1), b.slice(1), lastA, lastB);
}

export function globsOverlap(a: string, b: string): boolean {
  const sa = norm(a);
  const sb = norm(b);
  return overlapSegs(sa, sb, sa[sa.length - 1], sb[sb.length - 1]);
}

/** First pair of patterns (one from each list) that overlap, or null. Empty lists never overlap. */
export function findOverlap(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): [string, string] | null {
  for (const x of a ?? []) {
    if (!norm(x).length) continue;
    for (const y of b ?? []) if (norm(y).length && globsOverlap(x, y)) return [x, y];
  }
  return null;
}
