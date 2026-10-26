import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { PromptLibraryEntry } from "@getpaseo/protocol/prompt-library";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { DaemonClient } from "./test-utils/daemon-client.js";

const roots: string[] = [];

function tempHomeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "paseo-prompt-library-rpc-"));
  roots.push(root);
  return root;
}

function entry(overrides: Partial<PromptLibraryEntry> = {}): PromptLibraryEntry {
  return {
    id: "prompt_1",
    title: "Code review",
    body: "Review this change for edge cases.",
    tags: ["code", "review"],
    updatedAt: "2026-10-26T08:00:00.000Z",
    deleted: false,
    ...overrides,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("prompt library RPC", () => {
  test("advertises the feature, persists writes, and survives a daemon restart", async () => {
    const homeRoot = tempHomeRoot();
    let daemon: TestPaseoDaemon | null = null;
    let client: DaemonClient | null = null;
    try {
      daemon = await createTestPaseoDaemon({ paseoHomeRoot: homeRoot, cleanup: false });
      client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
      await client.connect();
      await client.fetchAgents({ subscribe: {} });

      expect(client.getLastServerInfoMessage()?.features?.promptLibrary).toBe(true);

      const first = entry();
      await expect(client.upsertPromptLibrary({ entry: first })).resolves.toMatchObject({
        applied: true,
        entry: first,
      });
      await expect(
        client.upsertPromptLibrary({
          entry: entry({ id: "prompt_2", tags: ["docs"], updatedAt: "2026-10-26T08:00:01.000Z" }),
        }),
      ).resolves.toMatchObject({ applied: true });

      const listed = await client.listPromptLibrary();
      expect(listed.entries).toHaveLength(2);

      const renamed = await client.renamePromptLibraryTag({ from: "review", to: "QA" });
      expect(renamed.affectedCount).toBe(1);
      expect(renamed.entries[0]?.tags).toEqual(["code", "QA"]);

      await client.close();
      client = null;
      await daemon.close();
      daemon = null;

      daemon = await createTestPaseoDaemon({ paseoHomeRoot: homeRoot, cleanup: false });
      client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
      await client.connect();
      await client.fetchAgents({ subscribe: {} });

      const afterRestart = await client.listPromptLibrary();
      expect(afterRestart.entries.find((candidate) => candidate.id === "prompt_1")?.tags).toEqual([
        "code",
        "QA",
      ]);

      const deleted = await client.deletePromptLibrary({
        id: "prompt_1",
        updatedAt: new Date(Date.now() + 60_000).toISOString(),
      });
      expect(deleted).toMatchObject({ applied: true, entry: { deleted: true } });

      const staleWrite = await client.upsertPromptLibrary({
        entry: entry({ title: "Stale", updatedAt: new Date(Date.now() + 30_000).toISOString() }),
      });
      expect(staleWrite).toMatchObject({ applied: false, entry: { deleted: true } });

      const tagDeleted = await client.deletePromptLibraryTag({ tag: "docs" });
      expect(tagDeleted.affectedCount).toBe(1);
      expect(tagDeleted.entries[0]?.tags).toEqual([]);
    } finally {
      await client?.close().catch(() => undefined);
      await daemon?.close().catch(() => undefined);
    }
  });
});
