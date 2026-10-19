import { expect, it } from "vitest";
import { FileEditorModel, type FileEditorClock } from "@/file-pane/editor/model";
import { textDocument } from "./document";

class DocumentClock implements FileEditorClock {
  callback: (() => void) | null = null;
  setTimeout(callback: () => void): ReturnType<typeof setTimeout> {
    this.callback = callback;
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }
  clearTimeout() {
    this.callback = null;
  }
  fire() {
    const callback = this.callback;
    this.callback = null;
    callback?.();
  }
}

it("plugin text edits mark the host document dirty and autosave with its revision", async () => {
  const clock = new DocumentClock();
  const writes: Array<{ content: string; expectedModifiedAt: string; expectedRevision?: string }> =
    [];
  const model = new FileEditorModel({
    file: {
      content: "original",
      hasBom: false,
      version: {
        status: "ready",
        cwd: "/workspace",
        path: "notes.md",
        size: 8,
        modifiedAt: "2026-10-19T00:00:00Z",
        revision: "first",
      },
    },
    clock,
    session: {
      async write(input) {
        writes.push(input);
        return {
          status: "written",
          modifiedAt: "2026-10-19T00:00:01Z",
          size: input.content.length,
          revision: "second",
        };
      },
    },
  });
  const document = textDocument(model.getSnapshot().content, (next) => model.edit(next));
  expect(document.editable).toBe(true);
  document.setText("edited");
  expect(model.getSnapshot()).toMatchObject({ status: "dirty", modified: true, content: "edited" });
  expect(writes).toEqual([]);
  clock.fire();
  await Promise.resolve();
  expect(writes).toEqual([
    { content: "edited", expectedModifiedAt: "2026-10-19T00:00:00Z", expectedRevision: "first" },
  ]);
  expect(model.getSnapshot()).toMatchObject({
    status: "clean",
    modified: false,
    content: "edited",
  });
  model.dispose();
});

it("readonly text documents leave the host text unchanged", () => {
  const document = textDocument("readonly");
  document.setText("ignored");
  expect(document).toMatchObject({ kind: "text", text: "readonly", editable: false });
});
