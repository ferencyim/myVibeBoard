import { describe, expect, test } from "vitest";
import type { PromptLibraryEntry } from "@getpaseo/protocol/prompt-library";
import {
  normalizePromptLibraryTags,
  promptLibraryTagKey,
  removePromptLibraryTag,
  renamePromptLibraryTag,
} from "@getpaseo/protocol/prompt-library";
import { promptLibraryStorageKey } from "./cache";
import { PromptLibraryModel } from "./model";
import type { PromptLibraryRemote, PromptLibraryStorage, PromptLibraryTagResult } from "./types";

class MemoryStorage implements PromptLibraryStorage {
  readonly values = new Map<string, string>();
  async getItem(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }
  async setItem(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

class FakeRemote implements PromptLibraryRemote {
  readonly entries = new Map<string, PromptLibraryEntry>();
  readonly calls: string[] = [];
  stamp = "2026-10-26T12:00:00.000Z";
  failSync = false;
  /** Ids the host refuses with a business error, like the daemon's `prompt_library_invalid`. */
  readonly rejectedIds = new Set<string>();
  /** Stored entries the list call does not show, to simulate a write racing the push. */
  readonly hiddenFromList = new Set<string>();

  async listPromptLibrary(): Promise<{ entries: PromptLibraryEntry[] }> {
    this.calls.push("list");
    if (this.failSync) throw new Error("offline");
    return {
      entries: [...this.entries.values()].filter((entry) => !this.hiddenFromList.has(entry.id)),
    };
  }

  async upsertPromptLibrary(input: {
    entry: PromptLibraryEntry;
  }): Promise<{ entry: PromptLibraryEntry; applied: boolean }> {
    this.calls.push(`upsert:${input.entry.id}`);
    if (this.failSync) throw new Error("offline");
    if (this.rejectedIds.has(input.entry.id)) throw rejection();
    const existing = this.entries.get(input.entry.id);
    if (existing && Date.parse(input.entry.updatedAt) < Date.parse(existing.updatedAt)) {
      return { entry: existing, applied: false };
    }
    this.entries.set(input.entry.id, input.entry);
    return { entry: input.entry, applied: true };
  }

  async deletePromptLibrary(input: {
    id: string;
    updatedAt: string;
  }): Promise<{ entry: PromptLibraryEntry; applied: boolean }> {
    this.calls.push(`delete:${input.id}`);
    if (this.failSync) throw new Error("offline");
    const existing = this.entries.get(input.id);
    if (existing && Date.parse(input.updatedAt) < Date.parse(existing.updatedAt)) {
      return { entry: existing, applied: false };
    }
    const tombstone: PromptLibraryEntry = {
      id: input.id,
      title: "",
      body: "",
      tags: [],
      updatedAt: input.updatedAt,
      deleted: true,
    };
    this.entries.set(input.id, tombstone);
    return { entry: tombstone, applied: true };
  }

  async renamePromptLibraryTag(input: {
    from: string;
    to: string;
  }): Promise<PromptLibraryTagResult> {
    this.calls.push(`renameTag:${input.from}->${input.to}`);
    if (this.failSync) throw new Error("offline");
    const changed: PromptLibraryEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.deleted) continue;
      if (!entry.tags.some((tag) => promptLibraryTagKey(tag) === promptLibraryTagKey(input.from))) {
        continue;
      }
      const next = {
        ...entry,
        tags: renamePromptLibraryTag(entry.tags, input.from, input.to),
        updatedAt: this.stamp,
      };
      this.entries.set(entry.id, next);
      changed.push(next);
    }
    return { entries: changed, affectedCount: changed.length };
  }

  async deletePromptLibraryTag(input: { tag: string }): Promise<PromptLibraryTagResult> {
    this.calls.push(`deleteTag:${input.tag}`);
    if (this.failSync) throw new Error("offline");
    const changed: PromptLibraryEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.deleted) continue;
      if (!entry.tags.some((tag) => promptLibraryTagKey(tag) === promptLibraryTagKey(input.tag))) {
        continue;
      }
      const next = {
        ...entry,
        tags: removePromptLibraryTag(entry.tags, input.tag),
        updatedAt: this.stamp,
      };
      this.entries.set(entry.id, next);
      changed.push(next);
    }
    return { entries: changed, affectedCount: changed.length };
  }
}

function rejection(): Error {
  return Object.assign(new Error("Prompt title cannot be empty"), {
    name: "DaemonRpcError",
    code: "prompt_library_invalid",
  });
}

class FailingReadStorage extends MemoryStorage {
  failReads = true;
  writes = 0;
  override async getItem(key: string): Promise<string | null> {
    if (this.failReads) throw new Error("storage unavailable");
    return super.getItem(key);
  }
  override async setItem(key: string, value: string): Promise<void> {
    this.writes += 1;
    await super.setItem(key, value);
  }
}

function createModel(options: { storage?: MemoryStorage; start?: string } = {}) {
  const storage = options.storage ?? new MemoryStorage();
  let sequence = 0;
  const model = new PromptLibraryModel({
    storage,
    now: () => new Date(options.start ?? "2026-10-26T09:00:00.000Z"),
    createId: () => `local_${++sequence}`,
  });
  return { model, storage };
}

function remoteEntry(overrides: Partial<PromptLibraryEntry> = {}): PromptLibraryEntry {
  return {
    id: "remote_1",
    title: "Remote prompt",
    body: "From another device.",
    tags: ["remote"],
    updatedAt: "2026-10-26T08:00:00.000Z",
    deleted: false,
    ...overrides,
  };
}

describe("PromptLibraryModel", () => {
  test("keeps offline edits and the pending queue across a restart", async () => {
    const { model, storage } = createModel();
    await model.save("srv_1", { title: "Offline", body: "Still here.", tags: [" Code "] });
    expect(model.getSnapshot("srv_1")).toMatchObject({
      pendingCount: 1,
      status: "idle",
    });
    expect(model.getSnapshot("srv_1").entries[0]?.tags).toEqual(["Code"]);

    const restarted = new PromptLibraryModel({ storage, now: () => new Date() });
    await restarted.ensureHydrated("srv_1");
    const snapshot = restarted.getSnapshot("srv_1");
    expect(snapshot.entries.map((entry) => entry.title)).toEqual(["Offline"]);
    expect(snapshot.pendingCount).toBe(1);
  });

  test("syncs pending writes and remote entries on connect", async () => {
    const remote = new FakeRemote();
    remote.entries.set("remote_1", remoteEntry());
    const { model } = createModel();
    await model.save("srv_1", { title: "Local", body: "Queued.", tags: [] });

    await model.connect({ serverId: "srv_1", client: remote, supported: true });

    const snapshot = model.getSnapshot("srv_1");
    expect(snapshot.status).toBe("online");
    expect(snapshot.pendingCount).toBe(0);
    expect(snapshot.entries.map((entry) => entry.title).sort()).toEqual(["Local", "Remote prompt"]);
    expect(remote.entries.size).toBe(2);
  });

  test("a newer remote entry wins and drops the stale pending write", async () => {
    const remote = new FakeRemote();
    remote.entries.set(
      "local_1",
      remoteEntry({ id: "local_1", title: "Remote newer", updatedAt: "2026-10-26T11:00:00.000Z" }),
    );
    const { model } = createModel();
    await model.save("srv_1", { id: "local_1", title: "Local older", body: "x", tags: [] });

    await model.connect({ serverId: "srv_1", client: remote, supported: true });

    const snapshot = model.getSnapshot("srv_1");
    expect(snapshot.pendingCount).toBe(0);
    expect(snapshot.entries[0]?.title).toBe("Remote newer");
    expect(remote.entries.get("local_1")?.title).toBe("Remote newer");
    expect(snapshot.notice).toBe("overridden");

    model.dismissNotice("srv_1");
    expect(model.getSnapshot("srv_1").notice).toBeNull();
  });

  test("a push the host answers with applied:false tells the user the edit was overridden", async () => {
    const remote = new FakeRemote();
    remote.entries.set(
      "local_1",
      remoteEntry({ id: "local_1", title: "Won the race", updatedAt: "2026-10-26T11:00:00.000Z" }),
    );
    remote.hiddenFromList.add("local_1");
    const { model } = createModel();
    await model.save("srv_1", { id: "local_1", title: "Local older", body: "x", tags: [] });

    await model.connect({ serverId: "srv_1", client: remote, supported: true });

    const snapshot = model.getSnapshot("srv_1");
    expect(snapshot.notice).toBe("overridden");
    expect(snapshot.pendingCount).toBe(0);
    expect(snapshot.entries[0]?.title).toBe("Won the race");
  });

  test("the stored entry returned by the host, such as a clamped timestamp, replaces the local one", async () => {
    const remote = new FakeRemote();
    remote.upsertPromptLibrary = async ({ entry }) => ({
      entry: { ...entry, updatedAt: "2026-10-26T08:55:00.000Z" },
      applied: true,
    });
    const { model } = createModel({ start: "2030-01-01T00:00:00.000Z" });
    await model.save("srv_1", { id: "local_1", title: "Clock ahead", body: "x", tags: [] });

    await model.connect({ serverId: "srv_1", client: remote, supported: true });

    const snapshot = model.getSnapshot("srv_1");
    expect(snapshot.entries[0]?.updatedAt).toBe("2026-10-26T08:55:00.000Z");
    expect(snapshot.pendingCount).toBe(0);
    expect(snapshot.notice).toBeNull();
  });

  test("a write the host refuses is rolled back and does not block the rest of the queue", async () => {
    const remote = new FakeRemote();
    remote.entries.set("bad", remoteEntry({ id: "bad", title: "Host version" }));
    remote.rejectedIds.add("bad");
    const { model } = createModel();
    await model.save("srv_1", { id: "bad", title: "Edited", body: "x", tags: [] });
    await model.save("srv_1", { id: "good", title: "Good", body: "y", tags: [] });
    await model.save("srv_1", { id: "fresh", title: "Fresh", body: "z", tags: [] });
    remote.rejectedIds.add("fresh");

    await model.connect({ serverId: "srv_1", client: remote, supported: true });

    const snapshot = model.getSnapshot("srv_1");
    expect(remote.calls).toContain("upsert:good");
    expect(remote.entries.get("good")?.title).toBe("Good");
    expect(snapshot.pendingCount).toBe(0);
    expect(snapshot.status).toBe("online");
    expect(snapshot.notice).toBe("rejected");
    const titles = snapshot.entries.map((entry) => entry.title).sort();
    expect(titles).toEqual(["Good", "Host version"]);
  });

  test("a connection error mid-queue stops the round and keeps the remaining writes", async () => {
    const remote = new FakeRemote();
    const { model } = createModel();
    await model.save("srv_1", { id: "a", title: "A", body: "a", tags: [] });
    await model.save("srv_1", { id: "b", title: "B", body: "b", tags: [] });
    remote.upsertPromptLibrary = async () => {
      throw new Error("socket closed");
    };

    await model.connect({ serverId: "srv_1", client: remote, supported: true });

    const snapshot = model.getSnapshot("srv_1");
    expect(snapshot.status).toBe("offline");
    expect(snapshot.error).toBe("prompt_library_sync_failed");
    expect(snapshot.pendingCount).toBe(2);
    expect(snapshot.notice).toBeNull();
  });

  test("rejects a title or body over the protocol limit without queuing it", async () => {
    const remote = new FakeRemote();
    const { model } = createModel();
    await expect(
      model.save("srv_1", { title: "t".repeat(201), body: "ok", tags: [] }),
    ).rejects.toThrow("prompt_title_too_long");
    await expect(
      model.save("srv_1", { title: "ok", body: "b".repeat(100_001), tags: [] }),
    ).rejects.toThrow("prompt_body_too_long");
    expect(model.getSnapshot("srv_1").pendingCount).toBe(0);

    await model.save("srv_1", { title: "t".repeat(200), body: "b".repeat(100_000), tags: [] });
    await model.save("srv_1", { title: "Next", body: "ok", tags: [] });
    await model.connect({ serverId: "srv_1", client: remote, supported: true });
    expect(remote.entries.size).toBe(2);
    expect(model.getSnapshot("srv_1").pendingCount).toBe(0);
  });

  test("deleting clears the content from the local tombstone", async () => {
    const { model, storage } = createModel();
    const entry = await model.save("srv_1", { title: "Secret", body: "private", tags: ["x"] });
    await model.remove("srv_1", entry.id);

    const cached = JSON.parse(storage.values.get(promptLibraryStorageKey("srv_1")) as string) as {
      entries: PromptLibraryEntry[];
      pending: PromptLibraryEntry[];
    };
    expect(cached.entries[0]).toMatchObject({ title: "", body: "", tags: [], deleted: true });
    expect(cached.pending[0]).toMatchObject({ title: "", body: "", tags: [], deleted: true });
  });

  test("deletes send tombstones and clear the queue", async () => {
    const remote = new FakeRemote();
    const { model } = createModel();
    await model.connect({ serverId: "srv_1", client: remote, supported: true });
    const entry = await model.save("srv_1", { title: "Delete me", body: "x", tags: [] });
    await model.sync("srv_1");
    expect(remote.entries.get(entry.id)?.deleted).toBe(false);

    await model.remove("srv_1", entry.id);
    await model.sync("srv_1");

    expect(remote.entries.get(entry.id)?.deleted).toBe(true);
    expect(model.getSnapshot("srv_1").entries).toHaveLength(0);
    expect(model.getSnapshot("srv_1").pendingCount).toBe(0);
    expect(remote.calls).toContain(`delete:${entry.id}`);
  });

  test("offline tag rename expands into queued entry writes", async () => {
    const remote = new FakeRemote();
    const { model } = createModel();
    await model.save("srv_1", { title: "A", body: "a", tags: ["code", "review"] });
    await model.save("srv_1", { title: "B", body: "b", tags: ["code"] });
    await model.save("srv_1", { title: "C", body: "c", tags: ["other"] });

    await model.renameTag("srv_1", "code", "engineering");

    expect(model.getSnapshot("srv_1").tags).toEqual(["engineering", "other", "review"]);
    expect(model.getSnapshot("srv_1").pendingCount).toBe(3);

    await model.connect({ serverId: "srv_1", client: remote, supported: true });
    expect(
      [...remote.entries.values()].filter((entry) => entry.tags.includes("engineering")),
    ).toHaveLength(2);
  });

  test("online tag rename uses the batch RPC and applies the server result", async () => {
    const remote = new FakeRemote();
    remote.entries.set("remote_1", remoteEntry({ tags: ["code", "review"] }));
    const { model } = createModel();
    await model.connect({ serverId: "srv_1", client: remote, supported: true });
    await model.renameTag("srv_1", "code", "engineering");

    expect(remote.calls).toContain("renameTag:code->engineering");
    expect(remote.entries.get("remote_1")?.tags).toEqual(["engineering", "review"]);
    expect(model.getSnapshot("srv_1").entries[0]?.tags).toEqual(["engineering", "review"]);
  });

  test("offline tag delete queues entry writes", async () => {
    const remote = new FakeRemote();
    const { model } = createModel();
    await model.save("srv_1", { title: "A", body: "a", tags: ["code", "review"] });
    await model.deleteTag("srv_1", "code");
    expect(model.getSnapshot("srv_1").entries[0]?.tags).toEqual(["review"]);
    expect(model.getSnapshot("srv_1").pendingCount).toBe(1);

    await model.connect({ serverId: "srv_1", client: remote, supported: true });
    expect(remote.entries.size).toBe(1);
    expect([...remote.entries.values()][0]?.tags).toEqual(["review"]);
  });

  test("a stale sync from a disconnected connection cannot overwrite the replacement", async () => {
    const firstList = Promise.withResolvers<{ entries: PromptLibraryEntry[] }>();
    const staleRemote: PromptLibraryRemote = {
      listPromptLibrary: () => firstList.promise,
      upsertPromptLibrary: async ({ entry }) => ({ entry, applied: true }),
      deletePromptLibrary: async ({ id, updatedAt }) => ({
        entry: {
          id,
          title: "",
          body: "",
          tags: [],
          updatedAt,
          deleted: true,
        },
        applied: true,
      }),
      renamePromptLibraryTag: async () => ({ entries: [], affectedCount: 0 }),
      deletePromptLibraryTag: async () => ({ entries: [], affectedCount: 0 }),
    };
    const { model } = createModel();
    const firstConnect = model.connect({
      serverId: "srv_1",
      client: staleRemote,
      supported: true,
    });
    await Promise.resolve();
    model.disconnect("srv_1");

    const remote = new FakeRemote();
    await model.connect({ serverId: "srv_1", client: remote, supported: true });

    firstList.resolve({
      entries: [remoteEntry({ id: "stale", title: "Stale remote" })],
    });
    await firstConnect;

    const snapshot = model.getSnapshot("srv_1");
    expect(snapshot.entries.some((entry) => entry.id === "stale")).toBe(false);
    expect(snapshot.status).toBe("online");
  });

  test("a failed sync keeps the queue and reports offline", async () => {
    const remote = new FakeRemote();
    remote.failSync = true;
    const { model } = createModel();
    await model.save("srv_1", { title: "Offline", body: "x", tags: [] });

    await model.connect({ serverId: "srv_1", client: remote, supported: true });

    const snapshot = model.getSnapshot("srv_1");
    expect(snapshot.status).toBe("offline");
    expect(snapshot.error).toBe("prompt_library_sync_failed");
    expect(snapshot.pendingCount).toBe(1);
    expect(snapshot.entries).toHaveLength(1);
  });

  test("reports unsupported hosts and ignores corrupt caches", async () => {
    const remote = new FakeRemote();
    const { model, storage } = createModel();
    await model.connect({ serverId: "srv_1", client: remote, supported: false });
    expect(model.getSnapshot("srv_1").status).toBe("unsupported");

    storage.values.set(promptLibraryStorageKey("srv_2"), "{bad");
    const restarted = new PromptLibraryModel({ storage, now: () => new Date(1000) });
    await restarted.ensureHydrated("srv_2");
    expect(restarted.getSnapshot("srv_2").entries).toEqual([]);
    expect(restarted.getSnapshot("srv_2").pendingCount).toBe(0);
  });

  test("backs up an unparseable cache before rebuilding it", async () => {
    const storage = new MemoryStorage();
    const key = promptLibraryStorageKey("srv_1");
    storage.values.set(key, "{bad");
    const model = new PromptLibraryModel({ storage });
    await model.save("srv_1", { title: "Fresh", body: "x", tags: [] });

    const backups = [...storage.values.entries()].filter(([name]) =>
      name.startsWith(`${key}:corrupt-`),
    );
    expect(backups).toHaveLength(1);
    expect(backups[0]?.[1]).toBe("{bad");
    expect(model.getSnapshot("srv_1").entries.map((entry) => entry.title)).toEqual(["Fresh"]);
  });

  test("keeps the good cached entries and backs up the raw cache when some are invalid", async () => {
    const storage = new MemoryStorage();
    const key = promptLibraryStorageKey("srv_1");
    const good = remoteEntry({ id: "good" });
    const raw = JSON.stringify({
      entries: [good, { id: "broken", title: 5 }],
      pending: [remoteEntry({ id: "queued", title: "Queued" }), "nonsense"],
    });
    storage.values.set(key, raw);

    const model = new PromptLibraryModel({ storage });
    await model.ensureHydrated("srv_1");

    const snapshot = model.getSnapshot("srv_1");
    expect(snapshot.hydrated).toBe(true);
    expect(snapshot.pendingCount).toBe(1);
    expect(snapshot.entries.map((entry) => entry.id)).toEqual(["good"]);
    const backups = [...storage.values.entries()].filter(([name]) =>
      name.startsWith(`${key}:corrupt-`),
    );
    expect(backups.map(([, value]) => value)).toEqual([raw]);
  });

  test("a cache read failure never overwrites the stored queue and recovers on retry", async () => {
    const storage = new FailingReadStorage();
    const key = promptLibraryStorageKey("srv_1");
    const stored = JSON.stringify({
      entries: [remoteEntry({ id: "queued" })],
      pending: [remoteEntry({ id: "queued" })],
    });
    storage.values.set(key, stored);
    const remote = new FakeRemote();
    const model = new PromptLibraryModel({ storage });

    await model.ensureHydrated("srv_1");
    expect(model.getSnapshot("srv_1")).toMatchObject({
      hydrated: false,
      status: "error",
      error: "prompt_library_cache_failed",
    });
    await expect(model.save("srv_1", { title: "Blocked", body: "x", tags: [] })).rejects.toThrow(
      "prompt_library_cache_failed",
    );
    await model.connect({ serverId: "srv_1", client: remote, supported: true });
    await model.sync("srv_1");
    expect(storage.writes).toBe(0);
    expect(storage.values.get(key)).toBe(stored);

    storage.failReads = false;
    await model.sync("srv_1");
    const snapshot = model.getSnapshot("srv_1");
    expect(snapshot.hydrated).toBe(true);
    expect(snapshot.status).toBe("online");
    expect(remote.entries.has("queued")).toBe(true);
    expect(snapshot.pendingCount).toBe(0);
  });

  test("validates required fields and tags", async () => {
    const { model } = createModel();
    await expect(model.save("srv_1", { title: " ", body: "x", tags: [] })).rejects.toThrow(
      "prompt_title_required",
    );
    await expect(model.save("srv_1", { title: "x", body: "\n", tags: [] })).rejects.toThrow(
      "prompt_body_required",
    );
    await expect(model.renameTag("srv_1", " ", "x")).rejects.toThrow("prompt_tag_required");

    const entry = await model.save("srv_1", {
      title: "Tags",
      body: "x",
      tags: ["  Code ", "code", "review"],
    });
    expect(entry.tags).toEqual(["Code", "review"]);
  });

  test("normalizes tags used by the fake remote", () => {
    expect(normalizePromptLibraryTags([" a ", "A", "b"])).toEqual(["a", "b"]);
  });
});
