import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { PromptLibraryEntry } from "@getpaseo/protocol/prompt-library";
import { PromptLibraryError, PromptLibraryStore } from "./store.js";

const directories: string[] = [];

function tempStore(nowIso = "2026-10-26T09:00:00.000Z") {
  const dir = mkdtempSync(path.join(tmpdir(), "paseo-prompt-library-"));
  directories.push(dir);
  const filePath = path.join(dir, "prompt-library.json");
  return {
    filePath,
    store: new PromptLibraryStore(filePath, () => new Date(nowIso)),
  };
}

function entry(overrides: Partial<PromptLibraryEntry> = {}): PromptLibraryEntry {
  return {
    id: "prompt_1",
    title: "Code review",
    body: "Review this change.",
    tags: ["code"],
    updatedAt: "2026-10-26T08:00:00.000Z",
    deleted: false,
    ...overrides,
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("PromptLibraryStore", () => {
  test("starts empty when the file does not exist and persists atomic writes", async () => {
    const { store, filePath } = tempStore();
    await expect(store.list()).resolves.toEqual([]);

    const result = await store.upsert(entry());
    expect(result.applied).toBe(true);
    expect(result.entry).toEqual(entry());
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual({ entries: [entry()] });

    const reloaded = new PromptLibraryStore(filePath);
    await reloaded.initialize();
    await expect(reloaded.list()).resolves.toEqual([entry()]);
  });

  test("keeps the newest write and rejects an older one", async () => {
    const { store } = tempStore();
    await store.upsert(entry({ title: "Newer", updatedAt: "2026-10-26T08:10:00.000Z" }));

    const stale = await store.upsert(
      entry({ title: "Stale", updatedAt: "2026-10-26T08:05:00.000Z" }),
    );
    expect(stale).toEqual({
      entry: entry({ title: "Newer", updatedAt: "2026-10-26T08:10:00.000Z" }),
      applied: false,
    });

    const equal = await store.upsert(
      entry({ title: "Tie wins", updatedAt: "2026-10-26T08:10:00.000Z" }),
    );
    expect(equal.applied).toBe(true);
    await expect(store.list()).resolves.toEqual([
      entry({ title: "Tie wins", updatedAt: "2026-10-26T08:10:00.000Z" }),
    ]);
  });

  test("tombstones participate in last-write-wins", async () => {
    const { store } = tempStore();
    await store.upsert(entry({ updatedAt: "2026-10-26T08:10:00.000Z" }));

    const deleted = await store.delete({
      id: "prompt_1",
      updatedAt: "2026-10-26T08:20:00.000Z",
    });
    expect(deleted.entry.deleted).toBe(true);
    expect(deleted.applied).toBe(true);

    const staleResurrect = await store.upsert(entry({ updatedAt: "2026-10-26T08:15:00.000Z" }));
    expect(staleResurrect.applied).toBe(false);
    expect(staleResurrect.entry.deleted).toBe(true);

    const restored = await store.upsert(entry({ updatedAt: "2026-10-26T08:30:00.000Z" }));
    expect(restored.applied).toBe(true);
    expect(restored.entry.deleted).toBe(false);
  });

  test("deleting an unknown id leaves a tombstone so stale creates cannot resurrect it", async () => {
    const { store } = tempStore();
    await store.delete({ id: "ghost", updatedAt: "2026-10-26T08:20:00.000Z" });
    const stale = await store.upsert(entry({ id: "ghost", updatedAt: "2026-10-26T08:19:59.000Z" }));
    expect(stale.applied).toBe(false);
    expect(stale.entry).toMatchObject({ id: "ghost", deleted: true });
  });

  test("tombstones drop the title, body and tags", async () => {
    const { store, filePath } = tempStore();
    await store.upsert(entry({ id: "a", updatedAt: "2026-10-26T08:00:00.000Z" }));
    const deleted = await store.delete({ id: "a", updatedAt: "2026-10-26T08:20:00.000Z" });
    const tombstone = {
      id: "a",
      title: "",
      body: "",
      tags: [],
      updatedAt: "2026-10-26T08:20:00.000Z",
      deleted: true,
    };
    expect(deleted.entry).toEqual(tombstone);
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual({ entries: [tombstone] });

    const incomingDelete = await store.upsert(
      entry({ id: "b", updatedAt: "2026-10-26T08:30:00.000Z", deleted: true }),
    );
    expect(incomingDelete.entry).toMatchObject({ title: "", body: "", tags: [], deleted: true });
  });

  test("clamps a future updatedAt to the daemon clock plus five minutes", async () => {
    const { store } = tempStore("2026-10-26T09:00:00.000Z");
    const upserted = await store.upsert(entry({ updatedAt: "2030-01-01T00:00:00.000Z" }));
    expect(upserted).toMatchObject({
      applied: true,
      entry: { updatedAt: "2026-10-26T09:05:00.000Z" },
    });

    const deleted = await store.delete({ id: "prompt_1", updatedAt: "2031-01-01T00:00:00.000Z" });
    expect(deleted.entry.updatedAt).toBe("2026-10-26T09:05:00.000Z");
    expect(deleted.entry.deleted).toBe(true);
  });

  test("breaks equal timestamps deterministically: tombstone wins over a live write", async () => {
    const { store } = tempStore();
    const at = "2026-10-26T08:00:00.000Z";
    await store.delete({ id: "prompt_1", updatedAt: at });
    const live = await store.upsert(entry({ updatedAt: at }));
    expect(live).toMatchObject({ applied: false, entry: { deleted: true } });

    const other = tempStore();
    await other.store.upsert(entry({ updatedAt: at }));
    const tombstone = await other.store.delete({ id: "prompt_1", updatedAt: at });
    expect(tombstone.applied).toBe(true);
  });

  test("renames tags across entries and merges duplicates", async () => {
    const { store } = tempStore();
    await store.upsert(
      entry({
        id: "a",
        tags: ["code", "review"],
        updatedAt: "2026-10-26T08:00:00.000Z",
      }),
    );
    await store.upsert(
      entry({
        id: "b",
        tags: ["Review", "docs"],
        updatedAt: "2026-10-26T08:01:00.000Z",
      }),
    );
    await store.delete({ id: "c", updatedAt: "2026-10-26T08:02:00.000Z" });

    const result = await store.renameTag({ from: "CODE", to: "review" });
    expect(result.affectedCount).toBe(1);
    expect(result.entries).toEqual([
      entry({
        id: "a",
        tags: ["review"],
        updatedAt: "2026-10-26T09:00:00.000Z",
      }),
    ]);

    const all = await store.list();
    expect(all.find((candidate) => candidate.id === "b")?.tags).toEqual(["Review", "docs"]);
    expect(all.find((candidate) => candidate.id === "c")?.tags).toEqual([]);
  });

  test("deletes a tag across entries and leaves tombstones alone", async () => {
    const { store } = tempStore();
    await store.upsert(entry({ id: "a", tags: ["code", "review"] }));
    await store.upsert(entry({ id: "b", tags: ["docs"] }));

    const result = await store.deleteTag({ tag: "code" });
    expect(result.affectedCount).toBe(1);
    expect(result.entries[0]?.tags).toEqual(["review"]);
  });

  test("rejects empty or malformed prompts", async () => {
    const { store } = tempStore();
    await expect(store.upsert(entry({ title: "  " }))).rejects.toBeInstanceOf(PromptLibraryError);
    await expect(store.upsert(entry({ body: "\n" }))).rejects.toBeInstanceOf(PromptLibraryError);
    await expect(store.upsert(entry({ tags: ["  ", "  "] }))).resolves.toMatchObject({
      entry: { tags: [] },
    });
    await expect(store.renameTag({ from: " ", to: "x" })).rejects.toBeInstanceOf(
      PromptLibraryError,
    );
  });

  test("moves an unparseable file aside and starts empty", async () => {
    const { filePath, store } = tempStore();
    writeFileSync(filePath, "{", "utf8");
    await expect(store.list()).resolves.toEqual([]);

    const backups = readdirSync(path.dirname(filePath)).filter((name) =>
      name.startsWith("prompt-library.json.corrupt-"),
    );
    expect(backups).toHaveLength(1);
    expect(readFileSync(path.join(path.dirname(filePath), backups[0] as string), "utf8")).toBe("{");

    await expect(store.upsert(entry())).resolves.toMatchObject({ applied: true });
  });

  test("a file without an entries array is treated as corrupt", async () => {
    const { filePath, store } = tempStore();
    writeFileSync(filePath, JSON.stringify({ items: [] }), "utf8");
    await expect(store.list()).resolves.toEqual([]);
    expect(readdirSync(path.dirname(filePath)).some((name) => name.includes(".corrupt-"))).toBe(
      true,
    );
  });

  test("skips invalid entries and keeps the good ones", async () => {
    const { filePath, store } = tempStore();
    const good = entry({ id: "good" });
    writeFileSync(
      filePath,
      JSON.stringify({
        entries: [
          good,
          { id: "bad_shape", title: 1 },
          entry({ id: "empty_title", title: "  " }),
          entry({ id: "too_long", body: "x".repeat(100_001) }),
        ],
      }),
      "utf8",
    );
    await expect(store.list()).resolves.toEqual([good]);
    expect(readdirSync(path.dirname(filePath)).some((name) => name.includes(".corrupt-"))).toBe(
      false,
    );
  });
});
