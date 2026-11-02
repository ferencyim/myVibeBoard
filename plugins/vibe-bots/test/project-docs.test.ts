import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAllProjectDocs, readProjectDocs } from "../server/project-docs";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("readProjectDocs", () => {
  it("lists root briefs first, then docs/ markdown, and caps large files", async () => {
    const root = mkdtempSync(join(tmpdir(), "docs-"));
    dirs.push(root);
    mkdirSync(join(root, "docs", "sub"), { recursive: true });
    mkdirSync(join(root, "node_modules"), { recursive: true });
    writeFileSync(join(root, "CLAUDE.md"), "brief");
    writeFileSync(join(root, "docs", "b.md"), "b");
    writeFileSync(join(root, "docs", "a.md"), "a".repeat(70 * 1024));
    writeFileSync(join(root, "docs", "sub", "c.md"), "c");
    writeFileSync(join(root, "docs", "notes.txt"), "skip");
    writeFileSync(join(root, "node_modules", "x.md"), "skip");
    const docs = await readProjectDocs(root);
    expect(docs.map((doc) => doc.path)).toEqual(["CLAUDE.md", "docs/a.md", "docs/b.md", "docs/sub/c.md"]);
    expect(docs[1]).toMatchObject({ truncated: true, totalBytes: 70 * 1024 });
    expect(docs[1].content).toHaveLength(64 * 1024);
  });
});

describe("readAllProjectDocs", () => {
  it("prefixes paths with the project folder and skips unreadable roots", async () => {
    const base = mkdtempSync(join(tmpdir(), "docs-all-"));
    dirs.push(base);
    mkdirSync(join(base, "one", "docs"), { recursive: true });
    mkdirSync(join(base, "two"), { recursive: true });
    writeFileSync(join(base, "one", "docs", "a.md"), "a");
    writeFileSync(join(base, "two", "README.md"), "r");
    const docs = await readAllProjectDocs([join(base, "one"), join(base, "missing"), join(base, "two")]);
    expect(docs.map((doc) => doc.path)).toEqual(["one/docs/a.md", "two/README.md"]);
  });
});
