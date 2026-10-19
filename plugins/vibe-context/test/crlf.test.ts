import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMemoryStore, mergeAgentsMd, mergeGitignore, parseMemoryFile } from "../server/memory";

const crlf = (text: string) => text.replace(/\r?\n/g, "\r\n");

describe("CRLF checkouts", () => {
  it("reads memory, instructions and user directives without carriage returns", () => {
    const root = mkdtempSync(join(tmpdir(), "vibe-crlf-"));
    const vibe = join(root, ".vibe");
    mkdirSync(join(vibe, "instructions"), { recursive: true });
    mkdirSync(join(root, "home", "user"), { recursive: true });
    const entry = [
      "# Lessons",
      "",
      "<!-- vibe:entry id=a1 created=2026-01-01T00:00:00.000Z touched=2026-01-01T00:00:00.000Z -->",
      "Prefer small commits.",
      "Second line.",
      "",
    ].join("\n");
    writeFileSync(join(vibe, "LESSONS.md"), crlf(entry));
    writeFileSync(join(vibe, "instructions", "prd.md"), crlf("# PRD\nLine two\n"));
    writeFileSync(join(root, "home", "user", "user_directives.md"), crlf("Be brief.\nAnswer in Chinese.\n"));

    const store = createMemoryStore({ projectRoot: root, userHome: join(root, "home"), contextWindowTokens: 100_000 });
    const lessons = store.read("LESSONS.md");
    expect(lessons.entries).toHaveLength(1);
    expect(lessons.entries[0]!.body).toBe("Prefer small commits.\nSecond line.");
    expect(store.readInstructions()[0]!.text).not.toContain("\r");
    expect(store.readUserDirectives()).toBe("Be brief.\nAnswer in Chinese.\n");
    expect(parseMemoryFile(crlf(entry)).entries[0]!.id).toBe("a1");
  });

  it("recognises existing .gitignore and AGENTS.md content written with CRLF", () => {
    const ignore = crlf("node_modules/\n.vibe/sessions/\n.vibe/workers/\n");
    expect(mergeGitignore(ignore)).toBe(ignore);
    expect(mergeGitignore(crlf("dist/\n"))).toContain("\r\n.vibe/sessions/\r\n");
    const once = mergeAgentsMd(crlf("# Rules\n\nBe nice.\n"));
    expect(mergeAgentsMd(once)).toBe(once);
  });
});
