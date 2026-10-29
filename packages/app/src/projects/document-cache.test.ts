import { describe, it, expect } from "vitest";
import { ProjectDocumentCache, type DocumentSnapshot } from "./document-cache";
describe("project document offline cache", () => {
  it("recovers from persistence failure without publishing an unsaved edit", async () => {
    let fail = true;
    const storage = {
      getItem: async () => null,
      setItem: async () => {
        if (fail) throw new Error("disk full");
      },
    };
    const cache = new ProjectDocumentCache(storage, "host", "project");
    const change = {
      id: "edit",
      documents: [{ path: "AGENTS.md" as const, content: "text", baseRevision: "rev" }],
      createdAt: "now",
    };
    await expect(cache.queue(change)).rejects.toThrow("disk full");
    expect(cache.snapshot().outbox).toEqual([]);
    fail = false;
    await cache.queue(change);
    expect(cache.snapshot().outbox).toHaveLength(1);
  });
  it("restores documents and pending offline edits after a cold start, isolates hosts and keeps queue until acknowledged", async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: async (k: string) => values.get(k) ?? null,
      setItem: async (k: string, v: string) => {
        values.set(k, v);
      },
    };
    const first = new ProjectDocumentCache(storage, "host", "project");
    await first.load();
    const snapshot: DocumentSnapshot = {
      documents: [
        {
          path: "AGENTS.md",
          content: "# Project",
          totalBytes: 9,
          truncated: false,
          revision: "rev",
          syncedAt: "2026-10-28T00:00:00Z",
        },
      ],
      pending: [],
    };
    await first.received(snapshot);
    await first.queue({
      id: "offline",
      documents: [{ path: "AGENTS.md", content: "edited", baseRevision: "rev" }],
      createdAt: "2026-10-28T00:01:00Z",
    });
    const cold = new ProjectDocumentCache(storage, "host", "project");
    await cold.load();
    expect(cold.snapshot().documents[0].content).toBe("# Project");
    expect(cold.snapshot().outbox[0].documents[0].content).toBe("edited");
    const other = new ProjectDocumentCache(storage, "other", "project");
    await other.load();
    expect(other.snapshot().documents).toEqual([]);
    await cold.received(snapshot);
    expect(cold.snapshot().outbox).toHaveLength(1);
    await cold.acknowledge("offline", {
      ...snapshot,
      pending: [{ ...cold.snapshot().outbox[0], deliveredAt: null }],
    });
    expect(cold.snapshot().outbox).toEqual([]);
    expect(cold.snapshot().pending).toHaveLength(1);
  });
});
