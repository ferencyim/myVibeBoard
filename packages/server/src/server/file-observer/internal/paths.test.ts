import { posix, win32 } from "node:path";
import { describe, expect, test } from "vitest";
import { createObserverPaths } from "./paths.js";

describe("precomputed ignore matcher", () => {
  test.each([
    {
      platform: "linux" as const,
      pathApi: posix,
      roots: ["/repo/ignored", "/other"],
      directories: ["/", "/repo", "/repo/ignored", "/repo/ignored-more"],
    },
    {
      platform: "win32" as const,
      pathApi: win32,
      roots: ["C:\\Repo\\Ignored", "\\\\server\\share\\blocked"],
      directories: [
        "C:\\",
        "c:\\REPO",
        "C:\\repo\\IGNORED",
        "C:\\repo\\ignored-more",
        "\\\\server\\share\\",
      ],
    },
  ])(
    "matches the original path comparison on $platform",
    ({ platform, pathApi, roots, directories }) => {
      const paths = createObserverPaths(platform);
      const matcher = paths.createIgnoreMatcher(roots);
      for (const directory of directories) {
        const children = matcher.children(directory);
        for (const name of ["ignored", "Ignored-more", "blocked", "file.txt", "ΣΟΣ"]) {
          const path = pathApi.join(directory, name);
          const expected = roots.some((root) => paths.isInside(root, path));
          expect(matcher.isIgnored(path)).toBe(expected);
          expect(children(name)).toBe(expected);
        }
      }
    },
  );
});

// m3 regression: plain lexicographic sort does not put a parent immediately
// before its descendants. A sibling whose name extends the parent's with a
// character that sorts below the separator (POSIX "/" = 0x2F, so "-" and "."
// qualify) lands between them, so the single backward look collapse()
// relies on misses the real parent and keeps a redundant descendant scope.
// This is this repo's own layout: packages/app, packages/app-web,
// packages/app/src.
describe("collapse", () => {
  test("drops a redundant descendant but keeps a sibling whose name extends the parent's", () => {
    const paths = createObserverPaths("linux");
    const parent = "/repo/packages/app";
    const sibling = "/repo/packages/app-web";
    const descendant = "/repo/packages/app/src";

    expect(paths.collapse([parent, sibling, descendant]).sort()).toEqual([parent, sibling].sort());
  });

  test("keeps unrelated roots and drops nested duplicates regardless of input order", () => {
    const paths = createObserverPaths("linux");
    const a = "/repo/a";
    const aChild = "/repo/a/child";
    const b = "/repo/b";

    expect(paths.collapse([aChild, b, a]).sort()).toEqual([a, b].sort());
  });

  // The selected path strategy supplies separators and case comparison, so
  // Windows paths can be checked on every CI host.
  test("collapses win32 paths case-insensitively even with mismatched casing", () => {
    const paths = createObserverPaths("win32");
    const sep = win32.sep;
    const parent = `C:${sep}repo${sep}packages${sep}app`;
    const sibling = `C:${sep}repo${sep}packages${sep}APP-web`;
    const descendant = `c:${sep}repo${sep}packages${sep}app${sep}src`;

    expect(paths.collapse([parent, sibling, descendant]).sort()).toEqual([parent, sibling].sort());
  });
});
