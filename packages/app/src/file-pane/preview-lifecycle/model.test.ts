import type { FileReadResult } from "@getpaseo/client/internal/daemon-client";
import type { LiveFileSnapshot } from "../live-file/model";
import { describe, expect, it } from "vitest";
import {
  createFilePanePreview,
  FilePreviewLifecycleModel,
  type FilePanePreview,
  type FilePreviewLifecycleSnapshot,
} from "./model";

function previewFile(content: string) {
  return {
    kind: "text" as const,
    path: "file.ts",
    size: 7,
    encoding: "utf-8" as const,
    hasBom: false,
    modifiedAt: "2026-08-20T00:00:00.000Z",
    content,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function file(revision = "revision-1", path = "file.ts"): FileReadResult {
  return {
    bytes: new TextEncoder().encode("preview"),
    mime: "text/plain",
    size: 7,
    path,
    kind: "text",
    modifiedAt: "2026-08-20T00:00:00.000Z",
    revision,
  };
}

function pending(): LiveFileSnapshot {
  return { observation: null, read: { status: "pending", requested: false } };
}

function completed(rawFile: FileReadResult): LiveFileSnapshot {
  return {
    observation: {
      status: "ready",
      file: rawFile,
      version: {
        status: "ready",
        cwd: "/workspace",
        path: rawFile.path,
        size: rawFile.size,
        modifiedAt: rawFile.modifiedAt,
        revision: rawFile.revision,
      },
    },
    read: { status: "idle" },
  };
}

function source(
  targetKey: string,
  snapshot: LiveFileSnapshot,
): {
  targetKey: string;
  liveFileSnapshot: LiveFileSnapshot;
  panel: null;
} {
  return { targetKey, liveFileSnapshot: snapshot, panel: null };
}

describe("FilePreviewLifecycleModel", () => {
  it("represents pending raw reads, preparation, ready previews, unsupported files, and conversion failures", async () => {
    const first = deferred<FilePanePreview | null>();
    const second = deferred<FilePanePreview | null>();
    const third = deferred<FilePanePreview | null>();
    const preparations = [first, second, third];
    const model = new FilePreviewLifecycleModel(() => preparations.shift()!.promise);
    const preview: FilePanePreview = {
      file: previewFile("preview"),
      panel: null,
      bytesPreview: null,
    };

    model.setSource(source("/workspace:file.ts", pending()));
    expect(model.getSnapshot()).toEqual({ status: "read_pending" });

    model.setSource(source("/workspace:file.ts", completed(file("one"))));
    expect(model.getSnapshot()).toEqual({ status: "preparing" });
    first.resolve(preview);
    await expectSnapshot(model, { status: "ready", preview });

    model.setSource(source("/workspace:file.ts", pending()));
    expect(model.getSnapshot()).toEqual({ status: "read_pending", preview });

    model.setSource(
      source("/workspace:file.ts", {
        observation: {
          status: "error",
          cwd: "/workspace",
          path: "file.ts",
          error: "Requested path is not a file",
        },
        read: { status: "pending", requested: true },
      }),
    );
    expect(model.getSnapshot()).toEqual({ status: "read_pending", preview });

    model.setSource(source("/workspace:file.ts", completed(file("two"))));
    expect(model.getSnapshot()).toEqual({ status: "preparing", preview });
    second.resolve(null);
    await expectSnapshot(model, { status: "unsupported" });

    model.setSource(source("/workspace:file.ts", completed(file("three"))));
    expect(model.getSnapshot()).toEqual({ status: "preparing" });
    third.reject(new Error("attachment failed"));
    await expectSnapshot(model, { status: "error", message: "attachment failed" });
  });

  it("does not publish a stale conversion after retargeting", async () => {
    const first = deferred<FilePanePreview | null>();
    const second = deferred<FilePanePreview | null>();
    const model = new FilePreviewLifecycleModel((rawFile) =>
      rawFile.revision === "one" ? first.promise : second.promise,
    );
    const nextPreview: FilePanePreview = {
      file: previewFile("two"),
      panel: null,
      bytesPreview: null,
    };

    model.setSource(source("/workspace:file.ts", completed(file("one"))));
    model.setSource(source("/workspace:second.ts", completed(file("two", "second.ts"))));
    first.resolve({ file: previewFile("one"), panel: null, bytesPreview: null });
    await Promise.resolve();
    expect(model.getSnapshot()).toEqual({ status: "preparing" });

    second.resolve(nextPreview);
    await expectSnapshot(model, { status: "ready", preview: nextPreview });
  });
});

async function expectSnapshot(
  model: FilePreviewLifecycleModel,
  expected: FilePreviewLifecycleSnapshot,
): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  expect(model.getSnapshot()).toEqual(expected);
}

it("does not persist attachments when a text file has no selected panel", async () => {
  let writes = 0;
  await createFilePanePreview(file(), null, async () => {
    writes++;
    return {
      id: "attachment",
      mimeType: "text/plain",
      storageType: "web-indexeddb",
      storageKey: "attachment",
      createdAt: 0,
    };
  });
  expect(writes).toBe(0);
});

it("reprepares the same file when its selected panel changes", async () => {
  const preparations: Array<string | null> = [];
  const model = new FilePreviewLifecycleModel(async (raw, panel) => {
    preparations.push(panel?.id ?? null);
    return { file: previewFile("preview"), panel, bytesPreview: null };
  });
  const initial = source("/workspace:file.ts", completed(file()));
  model.setSource(initial);
  await Promise.resolve();
  const textPanel = {
    id: "builtin:markdown",
    files: { extensions: ["md", "markdown"] },
    document: "text",
    maxBytes: Infinity,
  } as const;
  model.setSource({ ...initial, panel: textPanel });
  await Promise.resolve();
  model.setSource({ ...initial, panel: textPanel });
  expect(preparations).toEqual([null, "builtin:markdown"]);
  expect(model.getSnapshot()).toMatchObject({ status: "ready", preview: { panel: textPanel } });
});
