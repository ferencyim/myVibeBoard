import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryUpdateSchema } from "../server/assess/schema";
import { createFileMemoryPort, parseMemory } from "../server/memory/files";
import { setupBoard } from "./helpers";

const read = (repo: string, file: string) => readFileSync(join(repo, ".vibe", file), "utf8");
const update = (over: Record<string, unknown>) =>
  MemoryUpdateSchema.parse({ summary: "s", ...over });

describe("file memory port", () => {
  it("writes entries in the vibe-context format and dedupes", () => {
    const board = setupBoard();
    const port = createFileMemoryPort(() => new Date("2026-10-19T10:00:00Z"));
    const first = port.apply(
      board.repoPath,
      update({
        state: "Dark mode shipped. Next: contrast audit.",
        decisions: [{ tag: "theme", body: "Use CSS variables for theming." }],
        lessons: [{ tag: "ui", body: "Never hard-code colors." }],
        index: [{ tag: "src/theme.ts", body: "Theme tokens." }],
      }),
    );
    expect(first).toMatchObject({ stateWritten: true, added: 3, duplicates: 0 });

    const decisions = parseMemory(read(board.repoPath, "DECISIONS.md"));
    expect(decisions.entries).toHaveLength(1);
    expect(decisions.entries[0]).toMatchObject({
      tag: "theme",
      body: "Use CSS variables for theming.",
    });
    expect(read(board.repoPath, "DECISIONS.md")).toMatch(
      /<!-- vibe:entry id=m_[0-9a-f]+ created=\S+ touched=\S+ tag=theme -->/,
    );

    // same lesson again: not duplicated; state is overwritten in place, keeping its id
    const stateId = parseMemory(read(board.repoPath, "PROJECT_STATE.md")).entries[0]!.id;
    const second = port.apply(
      board.repoPath,
      update({
        state: "Contrast audit done.",
        lessons: [{ tag: "ui", body: "never  hard-code colors." }],
      }),
    );
    expect(second).toMatchObject({ stateWritten: true, added: 0, duplicates: 1 });
    const state = parseMemory(read(board.repoPath, "PROJECT_STATE.md"));
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]).toMatchObject({ id: stateId, body: "Contrast audit done." });
    expect(parseMemory(read(board.repoPath, "LESSONS.md")).entries).toHaveLength(1);
  });

  it("supersedes decisions (by id or topic) and archives contradicted entries without deleting them", () => {
    const board = setupBoard();
    const port = createFileMemoryPort();
    port.apply(
      board.repoPath,
      update({
        decisions: [
          { tag: "db", body: "Use SQLite." },
          { tag: "auth", body: "Sessions in cookies." },
        ],
        lessons: [{ tag: "x", body: "Old wrong lesson." }],
      }),
    );
    const snap = port.snapshot(board.repoPath);
    const authId = snap["DECISIONS.md"].find((e) => e.tag === "auth")!.id;
    const lessonId = snap["LESSONS.md"][0]!.id;

    const result = port.apply(
      board.repoPath,
      update({
        decisions: [
          { tag: "db", body: "Use SQLite with WAL." }, // same topic replaces
          { tag: "auth2", body: "Tokens in headers.", supersedes: [authId] }, // explicit id
        ],
        archive: [{ file: "LESSONS.md", id: lessonId }],
      }),
    );
    expect(result).toMatchObject({ superseded: 2, archived: 1 });

    const live = parseMemory(read(board.repoPath, "DECISIONS.md")).entries.map((e) => e.body);
    expect(live).toEqual(["Use SQLite with WAL.", "Tokens in headers."]);
    const archived = parseMemory(read(board.repoPath, "DECISIONS_ARCHIVE.md")).entries.map(
      (e) => e.body,
    );
    expect(archived.join("\n")).toContain("Use SQLite.");
    expect(archived.join("\n")).toContain("superseded by");
    expect(parseMemory(read(board.repoPath, "LESSONS.md")).entries).toHaveLength(0);
    expect(read(board.repoPath, "LESSONS_ARCHIVE.md")).toContain("Old wrong lesson.");
  });

  it("does not create files for an empty update", () => {
    const board = setupBoard();
    const port = createFileMemoryPort();
    expect(port.apply(board.repoPath, update({}))).toMatchObject({ added: 0, stateWritten: false });
    expect(existsSync(join(board.repoPath, ".vibe", "DECISIONS.md"))).toBe(false);
  });
});
