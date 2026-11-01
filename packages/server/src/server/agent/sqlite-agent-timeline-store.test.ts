import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { SqliteAgentTimelineStore } from "./sqlite-agent-timeline-store.js";

it("distinguishes a missing subagent snapshot from an empty one and deletes it", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "subagent-snapshot-"));
  const store = new SqliteAgentTimelineStore(path.join(directory, "timeline.sqlite"));
  try {
    expect(await store.getSubagentSnapshot("agent")).toBeNull();
    await store.setSubagentSnapshot("agent", []);
    expect(await store.getSubagentSnapshot("agent")).toEqual([]);
    await store.deleteAgent("agent");
    expect(await store.getSubagentSnapshot("agent")).toBeNull();
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("persists projected pages, epochs, updates and deletion", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "timeline-store-"));
  const file = path.join(dir, "timeline.sqlite");
  let store = new SqliteAgentTimelineStore(file);
  try {
    await store.bulkInsert(
      "agent",
      [1, 2, 3].map((seq) => ({
        seq,
        timestamp: `2026-01-01T00:00:0${seq}.000Z`,
        item: { type: "assistant_message" as const, text: `${seq}`, messageId: `${seq}` },
      })),
      "epoch",
    );
    expect(await store.isClean("agent")).toBe(false);
    await store.markClean("agent");
    expect(await store.isClean("agent")).toBe(true);
    const tail = await store.fetchCommitted("agent", { limit: 2 });
    expect(tail.epoch).toBe("epoch");
    expect(tail.rows.map((row) => row.seq)).toEqual([2, 3]);
    expect(tail.hasOlder).toBe(true);
    const before = await store.fetchCommitted("agent", {
      direction: "before",
      cursor: { epoch: "epoch", seq: 2 },
      limit: 1,
    });
    expect(before.rows.map((row) => row.seq)).toEqual([1]);
    const after = await store.fetchCommitted("agent", {
      direction: "after",
      cursor: { epoch: "epoch", seq: 1 },
      limit: 1,
    });
    expect(after.rows.map((row) => row.seq)).toEqual([2]);
    expect(
      (
        await store.fetchCommitted("agent", {
          direction: "after",
          cursor: { epoch: "old", seq: 1 },
        })
      ).reset,
    ).toBe(true);
    await store.close();
    store = new SqliteAgentTimelineStore(file);
    expect(await store.getLatestCommittedSeq("agent")).toBe(3);
    expect((await store.fetchCommitted("agent")).epoch).toBe("epoch");
    expect(await store.getLastAssistantMessage("agent")).toBe("3");
    await store.updateCommittedRow("agent", {
      seq: 3,
      timestamp: "2026-01-01T00:00:03.000Z",
      item: { type: "assistant_message", text: "updated", messageId: "3" },
    });
    expect(await store.getLastAssistantMessage("agent")).toBe("updated");
    expect(await store.isClean("agent")).toBe(false);
    await store.replaceAgent(
      "agent",
      [
        {
          seq: 1,
          timestamp: "2026-01-01T00:00:01.000Z",
          item: { type: "assistant_message", text: "rebuilt", messageId: "rebuilt" },
        },
      ],
      "rebuilt-epoch",
    );
    expect((await store.fetchCommitted("agent")).epoch).toBe("rebuilt-epoch");
    expect(await store.isClean("agent")).toBe(false);
    expect(await store.getLatestCommittedSeq("agent")).toBe(1);
    expect(await store.getLastAssistantMessage("agent")).toBe("rebuilt");
    await store.replaceAgent("empty", [], "empty-epoch");
    expect((await store.fetchCommitted("empty")).epoch).toBe("empty-epoch");
    expect(await store.isClean("empty")).toBe(false);
    await store.markClean("empty");
    expect(await store.isClean("empty")).toBe(true);
    expect(await store.getCommittedRows("empty")).toEqual([]);
    await store.deleteAgent("empty");
    expect((await store.fetchCommitted("empty")).epoch).toBe("");
    await store.deleteAgent("agent");
    expect(await store.getCommittedRows("agent")).toEqual([]);
    await store.appendCommitted("agent", {
      type: "assistant_message",
      text: "new",
      messageId: "new",
    });
    expect((await store.fetchCommitted("agent")).epoch).not.toBe("epoch");
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
