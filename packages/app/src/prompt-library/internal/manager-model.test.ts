import { describe, expect, test } from "vitest";
import type { PromptLibraryEntry } from "@getpaseo/protocol/prompt-library";
import { PromptLibraryManagerModel } from "./manager-model";

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

function createModel() {
  const calls: string[] = [];
  const model = new PromptLibraryManagerModel({
    save: async (serverId, input) => {
      calls.push(`save:${serverId}:${input.id ?? "new"}`);
      return entry({ id: input.id ?? "new", ...input });
    },
    remove: async (serverId, id) => {
      calls.push(`remove:${serverId}:${id}`);
    },
    renameTag: async (serverId, from, to) => {
      calls.push(`rename:${serverId}:${from}->${to}`);
    },
    deleteTag: async (serverId, tag) => {
      calls.push(`deleteTag:${serverId}:${tag}`);
    },
  });
  model.open("srv_1");
  return { model, calls };
}

describe("PromptLibraryManagerModel", () => {
  test("only allows saving a non-empty, dirty prompt", async () => {
    const { model } = createModel();
    model.startCreate();
    expect(model.getSnapshot().canSubmit).toBe(false);
    model.setTitle("Title");
    expect(model.getSnapshot().canSubmit).toBe(false);
    model.setBody("Body");
    expect(model.getSnapshot()).toMatchObject({ canSubmit: true, dirty: true });

    await model.save();
    expect(model.getSnapshot()).toMatchObject({ view: "list", draft: null });
  });

  test("edit mode becomes dirty only after a change", () => {
    const { model } = createModel();
    model.startEdit(entry());
    expect(model.getSnapshot()).toMatchObject({ canSubmit: false, dirty: false });
    model.setTitle("Review updated");
    expect(model.getSnapshot()).toMatchObject({ canSubmit: true, dirty: true });
    model.setTitle("Review");
    expect(model.getSnapshot()).toMatchObject({ canSubmit: false, dirty: false });
  });

  test("normalizes and de-duplicates tags", () => {
    const { model } = createModel();
    model.startCreate();
    model.addTag("  Code ");
    model.addTag("code");
    model.addTag("review");
    expect(model.getSnapshot().draft?.tags).toEqual(["Code", "review"]);
    model.removeTag("CODE");
    expect(model.getSnapshot().draft?.tags).toEqual(["review"]);
  });

  test("delegates save, delete, and tag commands with the open host", async () => {
    const { model, calls } = createModel();
    model.startCreate();
    model.setTitle("Title");
    model.setBody("Body");
    await model.save();
    expect(calls).toContain("save:srv_1:new");

    model.startEdit(entry());
    await model.remove();
    expect(calls).toContain("remove:srv_1:p1");
    expect(model.getSnapshot().view).toBe("list");

    model.openTags();
    model.startTagRename("code");
    model.setTagDraft("engineering");
    await model.saveTagRename();
    expect(calls).toContain("rename:srv_1:code->engineering");
    expect(model.getSnapshot()).toMatchObject({ renamingTag: null, tagDraft: "" });

    await model.deleteTag("engineering");
    expect(calls).toContain("deleteTag:srv_1:engineering");
  });

  test("reports dependency errors without losing the draft", async () => {
    const model = new PromptLibraryManagerModel({
      save: async () => {
        throw new Error("prompt_title_required");
      },
      remove: async () => undefined,
      renameTag: async () => undefined,
      deleteTag: async () => undefined,
    });
    model.open("srv_1");
    model.startCreate();
    model.setTitle("Title");
    model.setBody("Body");
    await model.save();
    expect(model.getSnapshot()).toMatchObject({
      view: "edit",
      pending: false,
      error: "prompt_title_required",
    });
    expect(model.getSnapshot().draft?.title).toBe("Title");
  });
});
