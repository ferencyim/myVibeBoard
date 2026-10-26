import { describe, expect, test } from "vitest";
import type { PromptLibraryEntry } from "@getpaseo/protocol/prompt-library";
import {
  collectPromptTags,
  filterPromptEntries,
  mergeRemoteEntries,
  sortVisibleEntries,
} from "./merge";

function entry(overrides: Partial<PromptLibraryEntry> = {}): PromptLibraryEntry {
  return {
    id: "p1",
    title: "Review",
    body: "Review this change.",
    tags: ["code"],
    updatedAt: "2026-10-26T08:00:00.000Z",
    deleted: false,
    ...overrides,
  };
}

describe("prompt library merge", () => {
  test("remote newer wins, remote older loses, and tombstones participate", () => {
    const local = entry({ title: "Local", updatedAt: "2026-10-26T09:00:00.000Z" });
    const entries = new Map([[local.id, local]]);
    const pending = new Map<string, PromptLibraryEntry>();
    const result = mergeRemoteEntries({
      entries,
      pending,
      remote: [
        entry({ id: "p1", title: "Older remote", updatedAt: "2026-10-26T08:59:00.000Z" }),
        entry({ id: "p2", title: "New", updatedAt: "2026-10-26T10:00:00.000Z" }),
        entry({
          id: "p3",
          title: "Deleted",
          deleted: true,
          updatedAt: "2026-10-26T10:01:00.000Z",
        }),
      ],
    });
    expect(result.changed).toBe(true);
    expect(entries.get("p1")?.title).toBe("Local");
    expect(entries.get("p2")?.title).toBe("New");
    expect(entries.get("p3")?.deleted).toBe(true);
  });

  test("a pending local write yields only to a strictly newer remote entry", () => {
    const pendingEntry = entry({ title: "Pending", updatedAt: "2026-10-26T09:00:00.000Z" });
    const entries = new Map([[pendingEntry.id, pendingEntry]]);
    const pending = new Map([[pendingEntry.id, pendingEntry]]);

    mergeRemoteEntries({
      entries,
      pending,
      remote: [entry({ title: "Tie", updatedAt: "2026-10-26T09:00:00.000Z" })],
    });
    expect(pending.has("p1")).toBe(true);
    expect(entries.get("p1")?.title).toBe("Pending");

    mergeRemoteEntries({
      entries,
      pending,
      remote: [entry({ title: "Newer remote", updatedAt: "2026-10-26T09:00:01.000Z" })],
    });
    expect(pending.has("p1")).toBe(false);
    expect(entries.get("p1")?.title).toBe("Newer remote");
  });

  test("timestamp ties resolve the same everywhere: tombstone first, then id", () => {
    const at = "2026-10-26T09:00:00.000Z";
    const live = entry({ id: "p1", updatedAt: at });
    const entries = new Map([[live.id, live]]);
    const pending = new Map([[live.id, live]]);
    const result = mergeRemoteEntries({
      entries,
      pending,
      remote: [entry({ id: "p1", deleted: true, title: "", body: "", tags: [], updatedAt: at })],
    });
    expect(result.overridden).toBe(1);
    expect(pending.has("p1")).toBe(false);
    expect(entries.get("p1")?.deleted).toBe(true);

    const visible = sortVisibleEntries([
      entry({ id: "b", title: "Alpha", updatedAt: at }),
      entry({ id: "a", title: "Zulu", updatedAt: at }),
    ]);
    expect(visible.map((candidate) => candidate.id)).toEqual(["b", "a"]);
  });

  test("sorts visible entries, hides tombstones, collects tags, filters by query and tag", () => {
    const entries = [
      entry({
        id: "a",
        title: "Alpha",
        tags: ["Code", "review"],
        updatedAt: "2026-10-26T08:00:00.000Z",
      }),
      entry({
        id: "b",
        title: "Beta",
        body: "deploy steps",
        tags: ["ops"],
        updatedAt: "2026-10-26T09:00:00.000Z",
      }),
      entry({ id: "c", title: "Gone", deleted: true, updatedAt: "2026-10-26T10:00:00.000Z" }),
    ];
    const visible = sortVisibleEntries(entries);
    expect(visible.map((candidate) => candidate.id)).toEqual(["b", "a"]);
    expect(collectPromptTags(visible)).toEqual(["Code", "ops", "review"]);

    expect(
      filterPromptEntries({ entries: visible, query: "deploy", tag: null }).map((e) => e.id),
    ).toEqual(["b"]);
    expect(
      filterPromptEntries({ entries: visible, query: "code", tag: null }).map((e) => e.id),
    ).toEqual(["a"]);
    expect(
      filterPromptEntries({ entries: visible, query: "", tag: "code" }).map((e) => e.id),
    ).toEqual(["a"]);
    expect(filterPromptEntries({ entries: visible, query: "", tag: "ops" })).toHaveLength(1);
    expect(filterPromptEntries({ entries: visible, query: "", tag: "missing" })).toHaveLength(0);
  });
});
