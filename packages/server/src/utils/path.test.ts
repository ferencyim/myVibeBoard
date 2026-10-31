import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  areEquivalentPaths,
  createPathEquivalenceMatcher,
  createAsyncRealpathContainmentMatcher,
  getRealpathAwareRelativePath,
  isPathInsideRoot,
} from "./path.js";

describe("path equivalence", () => {
  test.each([
    ["C:/Users/Administrator/GhostFactory", "C:\\Users\\Administrator\\GhostFactory"],
    ["d:\\Projects\\paseo", "D:\\Projects\\paseo"],
    ["C:\\Users\\Administrator\\GhostFactory\\", "C:\\Users\\Administrator\\GhostFactory"],
    [String.raw`\\?\C:\Users\Administrator\GhostFactory`, "C:\\Users\\Administrator\\GhostFactory"],
    [String.raw`\\?\UNC\server\share\GhostFactory`, String.raw`\\server\share\GhostFactory`],
  ])("matches Windows-equivalent cwd forms", (left, right) => {
    expect(areEquivalentPaths(left, right)).toBe(true);
    expect(createPathEquivalenceMatcher(left)(right)).toBe(true);
  });

  test("keeps POSIX path casing significant", () => {
    expect(
      areEquivalentPaths("/Users/Administrator/GhostFactory", "/users/administrator/ghostfactory"),
    ).toBe(false);
  });

  test("checks POSIX root containment without prefix false positives", () => {
    expect(isPathInsideRoot("/opt/paseo", "/opt/paseo/node_modules/@getpaseo/server")).toBe(true);
    expect(isPathInsideRoot("/opt/paseo", "/opt/paseo-other")).toBe(false);
  });

  test("checks Windows root containment case-insensitively", () => {
    expect(
      isPathInsideRoot("C:\\Paseo\\node_modules", "c:/paseo/node_modules/@getpaseo/server"),
    ).toBe(true);
    expect(isPathInsideRoot("C:\\Paseo\\node_modules", "C:\\Paseo\\node_modules-other")).toBe(
      false,
    );
  });

  test.each([
    { root: "/repo", candidate: "/repo/..notes.txt", inside: true },
    { root: "/repo", candidate: "/repo/..drafts/notes.md", inside: true },
    { root: "/repo", candidate: "/repo/...drafts/notes.md", inside: true },
    { root: "/repo", candidate: "/repo/docs/..notes.txt", inside: true },
    { root: "/repo", candidate: "/repo", inside: true },
    { root: "/repo", candidate: "/repo/../sibling/notes.md", inside: false },
    { root: "/repo", candidate: "/repo/..drafts/../../outside.txt", inside: false },
    { root: "/repo", candidate: "/repo-other/notes.md", inside: false },
    { root: "C:\\Repo", candidate: "c:/repo/..notes.txt", inside: true },
    { root: "C:\\Repo", candidate: "C:\\Repo\\..drafts\\notes.md", inside: true },
    { root: "C:\\Repo", candidate: "C:\\Repo\\...drafts\\notes.md", inside: true },
    { root: "C:\\Repo", candidate: "C:\\Repo\\..\\sibling\\notes.md", inside: false },
    { root: "C:\\Repo", candidate: "C:\\Repo-other\\notes.md", inside: false },
    { root: "C:\\Repo", candidate: "D:\\Repo\\..notes.txt", inside: false },
    {
      root: String.raw`\\server\share\repo`,
      candidate: String.raw`\\server\share\repo\..drafts\notes.md`,
      inside: true,
    },
    {
      root: String.raw`\\?\C:\Repo`,
      candidate: "C:\\Repo\\..notes.txt",
      inside: true,
    },
  ])("checks named path containment for $candidate", ({ root, candidate, inside }) => {
    expect(isPathInsideRoot(root, candidate)).toBe(inside);
  });

  test("preserves the casing of Windows relative suffixes", () => {
    expect(getRealpathAwareRelativePath("C:\\Repo\\.git", "c:\\repo\\.git\\HEAD")).toBe("HEAD");
    expect(
      getRealpathAwareRelativePath("C:\\Repo\\.git", "c:\\repo\\.git\\refs\\heads\\FeatureCase"),
    ).toBe("refs\\heads\\FeatureCase");
  });

  test.skipIf(process.platform === "win32")(
    "derives the contained suffix from a realpath-equivalent root",
    () => {
      const tempDir = mkdtempSync(join(tmpdir(), "paseo-path-"));
      try {
        const realRoot = join(tempDir, "real-root");
        const nestedPath = join(realRoot, "packages", "app");
        const aliasRoot = join(tempDir, "root-alias");
        mkdirSync(nestedPath, { recursive: true });
        symlinkSync(realRoot, aliasRoot, "dir");

        expect(getRealpathAwareRelativePath(aliasRoot, nestedPath)).toBe(join("packages", "app"));
        expect(getRealpathAwareRelativePath(aliasRoot, tempDir)).toBeNull();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );
});

describe("async watcher containment", () => {
  test("matches lexical Windows paths with case, separators and directory boundaries", async () => {
    const matcher = await createAsyncRealpathContainmentMatcher("C:\\Repo\\.git");
    expect(await matcher.relative("c:/repo/.git/refs/heads/Feature")).toBe("refs\\heads\\Feature");
    expect(await matcher.relative("C:\\Repo\\.git-other\\HEAD")).toBeNull();
  });

  test("matches root aliases and candidate junctions and invalidates retargeted directories", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "paseo-async-path-"));
    try {
      const root = join(tempDir, "root");
      const other = join(tempDir, "other");
      const alias = join(tempDir, "alias");
      mkdirSync(root);
      mkdirSync(other);
      symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");
      const matcher = await createAsyncRealpathContainmentMatcher(root);
      expect(await matcher.relative(join(alias, "deleted-file"))).toBe("deleted-file");
      expect(await matcher.relative(alias)).toBe("");
      rmSync(alias, { recursive: process.platform === "win32" });
      symlinkSync(other, alias, process.platform === "win32" ? "junction" : "dir");
      matcher.invalidate(alias);
      expect(await matcher.relative(join(alias, "deleted-file"))).toBeNull();
      expect(await matcher.relative(alias)).toBeNull();
      const aliasedRoot = await createAsyncRealpathContainmentMatcher(alias);
      expect(await aliasedRoot.relative(join(other, "file"))).toBe("file");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
