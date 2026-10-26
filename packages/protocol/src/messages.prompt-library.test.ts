import { describe, expect, it } from "vitest";
import {
  PromptLibraryDeleteRequestSchema,
  PromptLibraryDeleteResponseSchema,
  PromptLibraryEntrySchema,
  PromptLibraryListResponseSchema,
  PromptLibraryTagDeleteRequestSchema,
  PromptLibraryTagRenameRequestSchema,
  PromptLibraryTagRenameResponseSchema,
  PromptLibraryUpsertRequestSchema,
  PromptLibraryUpsertResponseSchema,
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages";
import {
  comparePromptLibraryEntries,
  comparePromptLibraryUpdatedAt,
  isNewerPromptLibraryEntry,
  normalizePromptLibraryTags,
  promptLibraryTitleFromBody,
  removePromptLibraryTag,
  renamePromptLibraryTag,
} from "./prompt-library";

const entry = {
  id: "prompt_1",
  title: "代码审查",
  body: "请审查这段代码。",
  tags: ["code", "review"],
  updatedAt: "2026-10-26T08:00:00.000Z",
  deleted: false,
};

describe("prompt library protocol", () => {
  it("parses the full request/response family", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "prompt.library.list.request",
        requestId: "r1",
      }),
    ).toMatchObject({ type: "prompt.library.list.request", requestId: "r1" });
    expect(
      PromptLibraryUpsertRequestSchema.parse({
        type: "prompt.library.upsert.request",
        requestId: "r2",
        entry,
      }).entry,
    ).toEqual(entry);
    expect(
      PromptLibraryDeleteRequestSchema.parse({
        type: "prompt.library.delete.request",
        requestId: "r3",
        id: "prompt_1",
        updatedAt: "2026-10-26T08:01:00.000Z",
      }).id,
    ).toBe("prompt_1");
    expect(
      PromptLibraryTagRenameRequestSchema.parse({
        type: "prompt.library.tag.rename.request",
        requestId: "r4",
        from: "code",
        to: "engineering",
      }).to,
    ).toBe("engineering");
    expect(
      PromptLibraryTagDeleteRequestSchema.parse({
        type: "prompt.library.tag.delete.request",
        requestId: "r5",
        tag: "review",
      }).tag,
    ).toBe("review");

    expect(
      PromptLibraryListResponseSchema.parse({
        type: "prompt.library.list.response",
        payload: { requestId: "r1", entries: [entry] },
      }).payload.entries,
    ).toHaveLength(1);
    expect(
      PromptLibraryUpsertResponseSchema.parse({
        type: "prompt.library.upsert.response",
        payload: { requestId: "r2", entry, applied: true },
      }).payload.applied,
    ).toBe(true);
    expect(
      PromptLibraryDeleteResponseSchema.parse({
        type: "prompt.library.delete.response",
        payload: { requestId: "r3", entry: { ...entry, deleted: true }, applied: true },
      }).payload.entry.deleted,
    ).toBe(true);
    expect(
      PromptLibraryTagRenameResponseSchema.parse({
        type: "prompt.library.tag.rename.response",
        payload: { requestId: "r4", entries: [entry], affectedCount: 1 },
      }).payload.affectedCount,
    ).toBe(1);
    expect(
      SessionOutboundMessageSchema.parse({
        type: "prompt.library.tag.delete.response",
        payload: { requestId: "r5", entries: [], affectedCount: 0 },
      }).type,
    ).toBe("prompt.library.tag.delete.response");
  });

  it("rejects malformed entries", () => {
    expect(PromptLibraryEntrySchema.safeParse({ ...entry, updatedAt: "yesterday" }).success).toBe(
      false,
    );
    expect(PromptLibraryEntrySchema.safeParse({ ...entry, tags: [1] }).success).toBe(false);
  });

  it("advertises the promptLibrary feature flag as optional", () => {
    const base = {
      status: "server_info" as const,
      serverId: "srv_test",
    };
    expect(
      ServerInfoStatusPayloadSchema.parse({ ...base, features: { promptLibrary: true } }).features
        ?.promptLibrary,
    ).toBe(true);
    expect(
      ServerInfoStatusPayloadSchema.parse({ ...base, features: { workspaceLabels: true } }).features
        ?.promptLibrary,
    ).toBeUndefined();
  });
});

describe("prompt library helpers", () => {
  it("normalizes tags without losing the first spelling", () => {
    expect(
      normalizePromptLibraryTags(["  Code ", "code", "", "review  flow", "Review Flow"]),
    ).toEqual(["Code", "review flow"]);
  });

  it("renames and removes tags case-insensitively and merges duplicates", () => {
    expect(renamePromptLibraryTag(["Code", "review"], "code", "Review")).toEqual(["Review"]);
    expect(removePromptLibraryTag(["Code", "review"], " CODE ")).toEqual(["review"]);
  });

  it("compares timestamps for last-write-wins, including invalid values", () => {
    expect(
      comparePromptLibraryUpdatedAt("2026-10-26T08:00:00.000Z", "2026-10-26T07:00:00.000Z"),
    ).toBeGreaterThan(0);
    expect(comparePromptLibraryUpdatedAt("nope", "2026-10-26T07:00:00.000Z")).toBeLessThan(0);
    expect(
      isNewerPromptLibraryEntry(
        { id: "a", deleted: false, updatedAt: "2026-10-26T08:00:00.000Z" },
        { id: "a", deleted: false, updatedAt: "2026-10-26T08:00:00.000Z" },
      ),
    ).toBe(true);
  });

  it("breaks timestamp ties deterministically: tombstone first, then id", () => {
    const at = "2026-10-26T08:00:00.000Z";
    expect(
      comparePromptLibraryEntries(
        { id: "a", deleted: true, updatedAt: at },
        { id: "a", deleted: false, updatedAt: at },
      ),
    ).toBeGreaterThan(0);
    expect(
      comparePromptLibraryEntries(
        { id: "a", deleted: false, updatedAt: at },
        { id: "b", deleted: false, updatedAt: at },
      ),
    ).toBeLessThan(0);
    expect(
      comparePromptLibraryEntries(
        { id: "z", deleted: false, updatedAt: at },
        { id: "a", deleted: true, updatedAt: at },
      ),
    ).toBeLessThan(0);
    expect(
      isNewerPromptLibraryEntry(
        { id: "a", deleted: false, updatedAt: at },
        { id: "a", deleted: true, updatedAt: at },
      ),
    ).toBe(false);
  });

  it("derives a title from the first non-empty body line", () => {
    expect(promptLibraryTitleFromBody("\n  审查这次改动，关注边界条件  \nmore")).toBe(
      "审查这次改动，关注边界条件",
    );
  });
});
