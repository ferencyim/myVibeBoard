import { mkdirSync, mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskConversationMember, TaskConversationSnapshot } from "@getpaseo/protocol/messages";
import { TaskConversationStore, type StoredTaskConversation } from "./store.js";

const testHome = tmpdir();
const stores = new Set<TaskConversationStore>();
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (filePath: string) => { exec(sql: string): void; close(): void };
};

function filePath(): string {
  mkdirSync(testHome, { recursive: true });
  // Test evidence is deliberately retained: this task forbids recursive cleanup.
  return path.join(mkdtempSync(path.join(testHome, "wp111-store-")), "conversations.db");
}

function open(databasePath = filePath()): TaskConversationStore {
  const store = new TaskConversationStore({ filePath: databasePath });
  stores.add(store);
  return store;
}

function close(store: TaskConversationStore): void {
  store.close();
  stores.delete(store);
}

function member(memberId = "planner", backendAgentId = "agent-planner"): TaskConversationMember {
  return {
    memberId,
    backendAgentId,
    role: memberId,
    config: { provider: "claude", cwd: testHome, model: "test-model" },
    seenConversationSeq: 0,
    lastRequestAt: null,
    status: "idle",
  };
}

function snapshot(
  conversationId = "conversation",
  workspaceId = "workspace",
): TaskConversationSnapshot {
  return {
    conversationId,
    workspaceId,
    anchorAgentId: "agent-planner",
    ownerPluginId: "test-plugin",
    status: "active",
    epoch: `epoch-${conversationId}`,
    lastSeq: 0,
    members: [member()],
    createdAt: "2026-10-23T12:00:00.000Z",
    updatedAt: "2026-10-23T12:00:00.000Z",
  };
}

function create(store: TaskConversationStore): void {
  store.create(snapshot(), { idempotencyKey: "creation-key", fingerprint: "input-fingerprint" });
}

afterEach(() => {
  for (const store of stores) close(store);
});

describe("TaskConversationStore", () => {
  it("reopens authoritative history, members, configuration, and unresolved deliveries without providers", () => {
    const databasePath = filePath();
    const store = open(databasePath);
    create(store);
    store.update("conversation", (record) => {
      const planner = record.snapshot.members[0]!;
      planner.seenConversationSeq = 1;
      planner.lastRequestAt = "2026-10-23T12:01:00.000Z";
      record.memberConfigs.planner = {
        config: planner.config,
        fingerprint: "frozen-config",
        env: { TASK_TEST_VALUE: "frozen" },
      };
      record.deliveries.message = {
        deliveryId: "delivery",
        conversationId: "conversation",
        clientMessageId: "message",
        status: "unknown",
        memberId: "planner",
        backendAgentId: "agent-planner",
        throughSeq: 0,
        error: "Receipt is unresolved",
        requestFingerprint: "frozen-request",
        prompt: "公开上下文",
      };
      store.append(record, {
        sourceKey: "human:message",
        kind: "user",
        text: "任务正文",
        clientMessageId: "message",
      });
    });
    const before = store.get("conversation");
    close(store);
    const restarted = open(databasePath);
    expect(restarted.get("conversation")).toEqual(before);
    expect(restarted.findByMember("agent-planner")?.snapshot.conversationId).toBe("conversation");
    expect(restarted.find({ idempotencyKey: "creation-key" })?.snapshot.workspaceId).toBe(
      "workspace",
    );
    expect(restarted.fetch("conversation").rows.map((row) => row.text)).toEqual(["任务正文"]);
    expect(restarted.get("conversation")?.deliveries.message?.status).toBe("unknown");
  });

  it("retains every page and permanent source idempotency beyond the tail window and restart", () => {
    const databasePath = filePath();
    const store = open(databasePath);
    create(store);
    store.update("conversation", (record) => {
      for (let index = 1; index <= 551; index++) {
        store.append(record, {
          sourceKey: `source:${index}`,
          kind: "artifact",
          text: `正文${index}`,
        });
      }
    });
    close(store);
    const restarted = open(databasePath);
    const tail = restarted.fetch("conversation", { limit: 50 });
    expect(tail.rows).toHaveLength(50);
    expect(tail.endCursor?.seq).toBe(551);
    const ids = new Set(tail.rows.map((row) => row.id));
    let page = tail;
    while (page.hasOlder) {
      page = restarted.fetch("conversation", {
        direction: "before",
        cursor: page.startCursor!,
        limit: 50,
      });
      for (const row of page.rows) ids.add(row.id);
    }
    expect(ids.size).toBe(551);
    const duplicate = restarted.update("conversation", (record) =>
      restarted.append(record, { sourceKey: "source:1", kind: "system", text: "不得覆写旧发言" }),
    );
    expect(duplicate.text).toBe("正文1");
    expect(restarted.get("conversation")?.nextSeq).toBe(552);
    expect(restarted.querySource("conversation", { sourceKey: "source:1" })?.text).toBe("正文1");
  });

  it("rolls back human rows, delivery status, member index, and sequence allocation together", () => {
    const store = open();
    create(store);
    const fail = (record: StoredTaskConversation) => {
      store.append(record, { sourceKey: "failed-human", kind: "user", text: "不可提交" });
      record.snapshot.members.push(member("worker", "agent-worker"));
      record.snapshot.status = "paused";
      throw new Error("Preparation failed");
    };
    expect(() => store.update("conversation", fail)).toThrow("Preparation failed");
    expect(store.get("conversation")?.snapshot.status).toBe("active");
    expect(store.findByMember("agent-worker")).toBeNull();
    expect(store.querySource("conversation", { sourceKey: "failed-human" })).toBeNull();
    const row = store.update("conversation", (record) =>
      store.append(record, { sourceKey: "committed", kind: "user", text: "可提交" }),
    );
    expect(row.seq).toBe(1);
  });

  it("never returns accepted when SQLite refuses the durable commit", () => {
    const databasePath = filePath();
    const store = open(databasePath);
    create(store);
    const independent = new DatabaseSync(databasePath);
    independent.exec(`
      CREATE TRIGGER reject_test_write BEFORE UPDATE ON task_conversations
      BEGIN SELECT RAISE(ABORT, 'injected disk write failure'); END;
    `);
    independent.close();
    let published = false;
    const writeAccepted = (record: StoredTaskConversation) => {
      store.append(record, { sourceKey: "not-durable", kind: "user", text: "发送" });
      record.deliveries.message = {
        deliveryId: "delivery",
        conversationId: "conversation",
        clientMessageId: "message",
        status: "accepted",
        memberId: "planner",
        backendAgentId: "agent-planner",
        throughSeq: 0,
        error: null,
        requestFingerprint: "request",
      };
      return record.deliveries.message;
    };
    expect(() => {
      store.update("conversation", writeAccepted);
      published = true;
    }).toThrow("injected disk write failure");
    expect(published).toBe(false);
    expect(store.get("conversation")?.deliveries.message).toBeUndefined();
    expect(store.get("conversation")?.rows).toEqual([]);
    close(store);
    expect(open(databasePath).get("conversation")?.rows).toEqual([]);
  });

  it("keeps parallel assistant positions and catches up updates to an earlier row", () => {
    const store = open();
    create(store);
    const planner = store.update("conversation", (record) =>
      store.append(record, {
        sourceKey: "planner:start",
        kind: "assistant",
        text: "规划开头",
        speaker: {
          role: "planner",
          provider: "claude",
          model: "test-model",
          memberId: "planner",
          backendAgentId: "agent-planner",
        },
        source: { backendAgentId: "agent-planner", memberId: "planner", sourceTurnId: "turn-1" },
      }),
    );
    const scout = store.update("conversation", (record) =>
      store.append(record, { sourceKey: "scout:start", kind: "assistant", text: "探路开头" }),
    );
    const checkpoint = store.fetch("conversation").endCursor!;
    store.update("conversation", (record) => {
      store.replaceRow(record, scout.id, {
        text: "探路完成",
        completed: true,
        sourceKey: "scout:end",
      });
      store.replaceRow(record, planner.id, {
        text: "规划完整正文",
        completed: true,
        sourceKey: "planner:end",
      });
    });
    const catchup = store.fetch("conversation", {
      direction: "after",
      cursor: checkpoint,
      limit: 1,
    });
    expect(catchup.rows.map((row) => row.id)).toEqual([scout.id]);
    expect(catchup.hasNewer).toBe(true);
    const next = store.fetch("conversation", {
      direction: "after",
      cursor: catchup.endCursor!,
      limit: 1,
    });
    expect(next.rows[0]).toMatchObject({
      id: planner.id,
      seq: 1,
      updatedSeq: 4,
      text: "规划完整正文",
    });
    expect(next.hasNewer).toBe(false);
    expect(store.fetch("conversation").rows.map((row) => row.id)).toEqual([planner.id, scout.id]);
    expect(
      store.querySource("conversation", { role: "planner", completed: true, memberId: "planner" }),
    ).toMatchObject({ id: planner.id, source: { sourceTurnId: "turn-1" } });
    store.update("conversation", (record) => {
      store.replaceRow(record, planner.id, { text: "旧事件不得覆盖", sourceKey: "planner:end" });
    });
    expect(store.get("conversation")?.nextSeq).toBe(5);
    expect(store.querySource("conversation", { sourceKey: "planner:end" })?.text).toBe(
      "规划完整正文",
    );
  });

  it("enforces creation idempotency and unique backend ownership atomically", () => {
    const store = open();
    create(store);
    expect(
      store.create(snapshot(), {
        idempotencyKey: "creation-key",
        fingerprint: "input-fingerprint",
      }),
    ).toEqual(store.get("conversation"));
    expect(() =>
      store.create(snapshot(), { idempotencyKey: "creation-key", fingerprint: "changed" }),
    ).toThrow("different input");
    const second = snapshot("second", "second-workspace");
    second.members = [];
    second.anchorAgentId = null;
    store.create(second, { idempotencyKey: "second-key", fingerprint: "second" });
    const conflictingMember = (record: StoredTaskConversation) => {
      store.append(record, { sourceKey: "rolled-back", kind: "system", text: "不可提交" });
      record.snapshot.members.push(member());
    };
    expect(() => store.update("second", conflictingMember)).toThrow();
    expect(store.get("second")?.rows).toEqual([]);
    expect(store.findByMember("agent-planner")?.snapshot.conversationId).toBe("conversation");
  });

  it("does not leak detached mutations, accepts hostile source keys, and rejects stale cursor epochs", () => {
    const store = open();
    create(store);
    const detached = store.get("conversation")!;
    detached.snapshot.status = "archived";
    expect(store.get("conversation")?.snapshot.status).toBe("active");
    store.update("conversation", (record) => {
      store.append(record, { sourceKey: "__proto__", kind: "artifact", text: "可持久查阅" });
    });
    expect(store.querySource("conversation", { sourceKey: "__proto__" })?.text).toBe("可持久查阅");
    expect(() =>
      store.fetch("conversation", { direction: "after", cursor: { epoch: "obsolete", seq: 0 } }),
    ).toThrow("another epoch");
    expect(store.querySource("conversation", { cursor: { epoch: "obsolete", seq: 1 } })).toBeNull();
  });

  it("preserves distinct actual and prepared configurations across restart", () => {
    const databasePath = filePath();
    const store = open(databasePath);
    create(store);
    const preparedConfig = member().config;
    const actualConfig = { ...preparedConfig, systemPrompt: "普通创建钩子附加的系统规则" };
    store.update("conversation", (record) => {
      record.memberConfigs.planner = {
        config: actualConfig,
        preparedConfig,
        fingerprint: "stable-requested-recipient",
      };
      record.snapshot.members[0]!.config = actualConfig;
    });
    close(store);
    const restarted = open(databasePath);
    const stored = restarted.get("conversation")!.memberConfigs.planner!;
    expect(stored.preparedConfig).toEqual(preparedConfig);
    expect(stored.config).toEqual(actualConfig);
    expect(stored.config.systemPrompt).toBe("普通创建钩子附加的系统规则");
    expect(stored.preparedConfig).not.toHaveProperty("systemPrompt");
    expect(stored.preparedConfig).not.toHaveProperty("internal");
    expect(stored.fingerprint).toBe("stable-requested-recipient");
    expect(restarted.get("conversation")!.snapshot.members[0]!.config).toEqual(actualConfig);
  });

  it.each([
    ["invalid JSON", "{"],
    ["invalid or incompatible", JSON.stringify({ snapshot: { conversationId: "conversation" } })],
  ])("rejects %s at the durable record boundary", (message, corrupted) => {
    const databasePath = filePath();
    const store = open(databasePath);
    create(store);
    const independent = new DatabaseSync(databasePath);
    // These fixed fixtures contain no SQL quote characters.
    independent.exec(`UPDATE task_conversations SET record = '${corrupted}'`);
    independent.close();
    expect(() => store.get("conversation")).toThrow(message);
    expect(() => store.fetch("conversation")).toThrow(message);
  });
});
