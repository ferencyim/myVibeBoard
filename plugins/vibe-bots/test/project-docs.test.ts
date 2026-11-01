import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readProjectDocs } from "../server/project-docs";

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
