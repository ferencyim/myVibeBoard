import { describe, expect, test } from "vitest";
import type { PromptLibraryEntry } from "@getpaseo/protocol/prompt-library";
import {
  countPromptTags,
  filterPrompts,
  pruneTagSelection,
  sortPrompts,
  suggestPromptTags,
  toggleTagSelection,
} from "./browse";

function entry(id: string, title: string, tags: string[], body = "body"): PromptLibraryEntry {
  return { id, title, body, tags, updatedAt: "2026-10-26T08:00:00.000Z", deleted: false };
}

const entries = [
  entry("1", "Review", ["code", "Team"]),
  entry("2", "Zebra plan", ["code"]),
  entry("3", "alpha notes", [], "mentions review"),
];

describe("prompt browsing", () => {
  test("multiple tags intersect, case-insensitively", () => {
    expect(filterPrompts(entries, { query: "", tags: ["code"] }).map((e) => e.id)).toEqual([
      "1",
      "2",
    ]);
    expect(filterPrompts(entries, { query: "", tags: ["CODE", "team"] }).map((e) => e.id)).toEqual([
      "1",
    ]);
    expect(filterPrompts(entries, { query: "", tags: ["team", "missing"] })).toEqual([]);
  });

  test("untagged and search combine with tag filters", () => {
    expect(
      filterPrompts(entries, { query: "", tags: [], untagged: true }).map((e) => e.id),
    ).toEqual(["3"]);
    expect(filterPrompts(entries, { query: "review", tags: [] }).map((e) => e.id)).toEqual([
      "1",
      "3",
    ]);
    expect(filterPrompts(entries, { query: "review", tags: ["code"] }).map((e) => e.id)).toEqual([
      "1",
    ]);
  });

  test("sorts by title or keeps recency order", () => {
    expect(sortPrompts(entries, "title").map((e) => e.id)).toEqual(["3", "1", "2"]);
    expect(sortPrompts(entries, "updated").map((e) => e.id)).toEqual(["1", "2", "3"]);
  });

  test("counts tags and untagged entries", () => {
    const { byTag, untagged } = countPromptTags(entries);
    expect(byTag.get("code")).toBe(2);
    expect(byTag.get("team")).toBe(1);
    expect(untagged).toBe(1);
  });

  test("toggles and prunes the selection", () => {
    expect(toggleTagSelection(["code"], "Team")).toEqual(["code", "Team"]);
    expect(toggleTagSelection(["code", "Team"], "TEAM")).toEqual(["code"]);
    expect(pruneTagSelection(["code", "gone"], ["Code"])).toEqual(["code"]);
  });

  test("suggests existing tags that are not yet applied", () => {
    expect(
      suggestPromptTags({ allTags: ["code", "Team", "tools"], selected: ["Code"], text: "t" }),
    ).toEqual(["Team", "tools"]);
    expect(
      suggestPromptTags({ allTags: ["a", "b", "c"], selected: [], text: "", limit: 2 }),
    ).toEqual(["a", "b"]);
  });
});
