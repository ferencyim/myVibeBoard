import { describe, expect, it } from "vitest";
import { findOverlap, globsOverlap } from "../server/overlap";

describe("globsOverlap", () => {
  it.each([
    ["src/a.ts", "src/a.ts", true],
    ["src/a.ts", "src/b.ts", false],
    ["src/**", "src/deep/x.ts", true],
    ["src/**", "lib/**", false],
    ["src/app", "src/app/a.ts", true], // a directory contains its files
    ["src/app/*.ts", "src/app/a.ts", true],
    ["src/app/*.ts", "src/app/a.tsx", false],
    ["src/*.ts", "src/*.test.ts", true],
    ["src/*.ts", "src/*.css", false],
    ["**/*.md", "docs/readme.md", true],
    ["**/*.md", "docs/readme.txt", false],
    ["packages\\app\\**", "./packages/app/x.ts", true],
    ["**", "anything/at/all", true],
    ["src/**/util.ts", "src/a/b/util.ts", true],
    ["src/**/util.ts", "src/a/b/other.ts", false],
  ])("%s vs %s -> %s", (a, b, expected) => {
    expect(globsOverlap(a, b)).toBe(expected);
    expect(globsOverlap(b, a)).toBe(expected);
  });

  it("findOverlap returns the offending pair and ignores empty lists", () => {
    expect(findOverlap(["a/**", "b/x.ts"], ["c/**", "b/*.ts"])).toEqual(["b/x.ts", "b/*.ts"]);
    expect(findOverlap([], ["a"])).toBeNull();
    expect(findOverlap(undefined, ["a"])).toBeNull();
  });
});
