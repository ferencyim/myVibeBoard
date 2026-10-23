import { mkdirSync, mkdtempSync, readFileSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskConversationMember, TaskConversationSnapshot } from "@getpaseo/protocol/messages";
import { TaskConversationStore, type StoredTaskConversation } from "./store.js";
import { TaskConversationService } from "./service.js";

const testHome = tmpdir();
const stores = new Set<TaskConversationStore>();
interface TestDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...parameters: (string | number | null)[]): unknown;
    get(...parameters: (string | number | null)[]): Record<string, unknown> | undefined;
    all(...parameters: (string | number | null)[]): Record<string, unknown>[];
  };
  close(): void;
}
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (filePath: string) => TestDatabase;
};

function filePath(): string {
  mkdirSync(testHome, { recursive: true });
  // Test evidence is deliberately retained: this task forbids recursive cleanup.
  return path.join(mkdtempSync(path.join(testHome, "wp111-store-")), "conversations.db");
}

function open(
  databasePath = filePath(),
  onCorruptRecord?: (error: unknown, conversationId: string) => void,
): TaskConversationStore {
  const store = new TaskConversationStore({ filePath: databasePath, onCorruptRecord });
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
  it("uses NORMAL for recoverable projections and FULL for durable delivery commits", () => {
    const store = open();
    create(store);
    const db = (store as unknown as { db: TestDatabase }).db;
    const synchronous = () => db.prepare("PRAGMA synchronous").get()!.synchronous;
    expect(synchronous()).toBe(1);
    store.update(
      "conversation",
      (record) => {
        expect(synchronous()).toBe(1);
        store.append(record, { sourceKey: "recoverable", kind: "assistant", text: "流式内容" });
      },
      { durability: "normal" },
    );
    store.update("conversation", () => expect(synchronous()).toBe(2));
    expect(synchronous()).toBe(1);
    const fail = (record: StoredTaskConversation) => {
      expect(synchronous()).toBe(2);
      store.append(record, { sourceKey: "rollback", kind: "user", text: "未提交" });
      throw new Error("提交失败");
    };
    expect(() => store.update("conversation", fail)).toThrow("提交失败");
    expect(synchronous()).toBe(1);
    expect(store.fetch("conversation").rows.map((row) => row.text)).toEqual(["流式内容"]);
  });

  it("queries unseen boundaries, unfinished member rows and rejected messages without full history", () => {
    const store = open();
    create(store);
    store.update("conversation", (record) => {
      store.append(record, { sourceKey: "old", kind: "artifact", text: "旧上下文" });
      const unfinished = store.append(record, {
        sourceKey: "unfinished",
        kind: "assistant",
        text: "未收口",
        source: { backendAgentId: "agent-planner", memberId: "planner" },
      });
      store.append(record, {
        sourceKey: "done",
        kind: "assistant",
        text: "已完成",
        completed: true,
        source: { backendAgentId: "agent-planner", memberId: "planner" },
      });
      store.append(record, {
        sourceKey: "human:rejected",
        kind: "user",
        text: "未投递消息",
        clientMessageId: "rejected",
      });
      store.replaceRow(record, unfinished, { text: "窗口内新内容" });
    });
    const record = store.get("conversation")!;
    Object.defineProperty(record, "rows", {
      get: () => {
        throw new Error("不允许加载全部历史");
      },
    });
    expect(store.queryRows(record, { afterSeq: 3, throughSeq: 5 }).map((row) => row.text)).toEqual([
      "窗口内新内容",
      "未投递消息",
    ]);
    expect(
      store
        .queryRows(record, {
          kind: "assistant",
          completed: false,
          backendAgentIds: ["agent-planner"],
        })
        .map((row) => row.text),
    ).toEqual(["窗口内新内容"]);
    expect(store.queryRows(record, { clientMessageId: "rejected" })[0]!.text).toBe("未投递消息");
    expect(store.queryRows(record, { backendAgentIds: [] })).toEqual([]);
    expect(store.querySource(record, { sourceKey: "unfinished", completed: false })?.text).toBe(
      "窗口内新内容",
    );
  });

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

  it("stores rows independently by sequence and only rewrites the changed row", () => {
    const databasePath = filePath();
    const store = open(databasePath);
    create(store);
    const rows = store.update("conversation", (record) => {
      record.deliveries.message = {
        deliveryId: "delivery",
        conversationId: "conversation",
        clientMessageId: "message",
        status: "accepted",
        memberId: "planner",
        backendAgentId: "agent-planner",
        throughSeq: 2,
        error: null,
        requestFingerprint: "request",
        prompt: "完整上下文不可重复写入投递记录".repeat(100),
      };
      const appended = [];
      for (let index = 1; index <= 3; index++) {
        appended.push(
          store.append(record, {
            sourceKey: `separate:${index}`,
            kind: "assistant",
            text: `独立正文${index}`,
          }),
        );
      }
      return appended;
    });
    const db = new DatabaseSync(databasePath);
    try {
      const metadata = JSON.parse(
        String(db.prepare("SELECT record FROM task_conversations").get()!.record),
      );
      expect(metadata).not.toHaveProperty("rows");
      expect(metadata).not.toHaveProperty("sources");
      expect(metadata).not.toHaveProperty("rowSourceSeqRanges");
      expect(metadata.deliveries.message).not.toHaveProperty("prompt");
      expect(metadata.deliveries.message.throughSeq).toBe(2);
      expect(JSON.stringify(metadata)).not.toContain("独立正文");
      db.exec(`
        CREATE TABLE row_write_audit (operation TEXT, row_id TEXT);
        CREATE TRIGGER audit_row_update AFTER UPDATE ON task_conversation_rows
        BEGIN INSERT INTO row_write_audit VALUES ('update', NEW.id); END;
        CREATE TRIGGER audit_row_insert AFTER INSERT ON task_conversation_rows
        BEGIN INSERT INTO row_write_audit VALUES ('insert', NEW.id); END;
        CREATE TRIGGER audit_row_delete AFTER DELETE ON task_conversation_rows
        BEGIN INSERT INTO row_write_audit VALUES ('delete', OLD.id); END;
      `);

      store.update("conversation", (record) => {
        store.replaceRow(record, rows[1]!.id, { text: "只有第二行改变" });
      });

      expect(db.prepare("SELECT operation, row_id FROM row_write_audit").all()).toEqual([
        { operation: "update", row_id: rows[1]!.id },
      ]);
      expect(
        db.prepare("SELECT seq, updated_seq FROM task_conversation_rows ORDER BY seq").all(),
      ).toEqual([
        { seq: 1, updated_seq: 1 },
        { seq: 2, updated_seq: 4 },
        { seq: 3, updated_seq: 3 },
      ]);
      expect(store.fetch("conversation").rows.map((row) => row.text)).toEqual([
        "独立正文1",
        "只有第二行改变",
        "独立正文3",
      ]);
    } finally {
      db.close();
    }
  });

  it("persists inline images as uploaded file references and restores their bytes after restart", () => {
    const databasePath = filePath();
    const store = open(databasePath);
    create(store);
    const bytes = Buffer.from("任务图片原始字节".repeat(100));
    const data = bytes.toString("base64");
    store.update("conversation", (record) => {
      store.append(record, {
        sourceKey: "image-message",
        kind: "user",
        text: "图片说明",
        images: [{ data, mimeType: "image/png" }],
      });
    });
    const db = new DatabaseSync(databasePath);
    try {
      const raw = String(db.prepare("SELECT record FROM task_conversation_rows").get()!.record);
      const stored = JSON.parse(raw);
      expect(stored).not.toHaveProperty("images");
      expect(raw).not.toContain(data);
      expect(stored.imageReferences).toHaveLength(1);
      const reference = stored.imageReferences[0];
      expect(reference).toMatchObject({
        type: "uploaded_file",
        mimeType: "image/png",
        size: bytes.length,
      });
      expect(reference).not.toHaveProperty("data");
      expect(path.relative(path.dirname(databasePath), reference.path)).not.toMatch(/^\.\./);
      expect(readFileSync(reference.path)).toEqual(bytes);
      expect(
        String(db.prepare("SELECT record FROM task_conversations").get()!.record),
      ).not.toContain(data);
    } finally {
      db.close();
    }
    close(store);
    const restarted = open(databasePath);
    const image = restarted.fetch("conversation").rows[0]!.images![0]!;
    expect(image.mimeType).toBe("image/png");
    expect(Buffer.from(image.data, "base64")).toEqual(bytes);
  });

  it("keeps text and other rows readable when an uploaded image file is missing", () => {
    const databasePath = filePath();
    const store = open(databasePath);
    create(store);
    store.update("conversation", (record) => {
      store.append(record, {
        sourceKey: "missing-image",
        kind: "user",
        text: "图片说明仍可读取",
        images: [{ data: Buffer.from("图片").toString("base64"), mimeType: "image/png" }],
      });
      store.append(record, { sourceKey: "other-row", kind: "assistant", text: "其它发言" });
    });
    const db = new DatabaseSync(databasePath);
    try {
      const raw = db.prepare("SELECT record FROM task_conversation_rows WHERE seq = 1").get()!;
      const imagePath = JSON.parse(String(raw.record)).imageReferences[0].path;
      unlinkSync(imagePath);
    } finally {
      db.close();
    }
    const page = store.fetch("conversation");
    expect(page.rows.map((row) => row.text)).toEqual(["图片说明仍可读取", "其它发言"]);
    expect(page.rows[0]!.images).toEqual([]);
    expect(store.querySource("conversation", { sourceKey: "missing-image" })?.text).toBe(
      "图片说明仍可读取",
    );
  });

  it("keeps one durable sequence watermark per source without accumulating fragment keys", () => {
    const databasePath = filePath();
    const store = open(databasePath);
    create(store);
    store.update("conversation", (record) => {
      const row = store.append(record, { sourceKey: "turn-start", kind: "assistant", text: "" });
      for (let seq = 1; seq <= 250; seq++) {
        expect(store.acceptSourceSequence(record, "agent-planner", "source-epoch", seq)).toBe(true);
        store.replaceRow(record, row.id, { sourceKey: `fragment:${seq}`, text: `片段${seq}` });
      }
      expect(store.acceptSourceSequence(record, "agent-planner", "source-epoch", 250)).toBe(false);
      expect(store.acceptSourceSequence(record, "another-agent", "source-epoch", 4)).toBe(true);
      expect(store.acceptSourceSequence(record, "agent-planner", "another-epoch", 2)).toBe(true);
    });
    const db = new DatabaseSync(databasePath);
    try {
      expect(db.prepare("SELECT source_key FROM task_conversation_sources").all()).toEqual([
        { source_key: "turn-start" },
      ]);
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM task_conversation_source_watermarks").get()!
          .count,
      ).toBe(3);
      expect(
        db
          .prepare(
            "SELECT seq FROM task_conversation_source_watermarks WHERE backend_agent_id = ? AND epoch = ?",
          )
          .get("agent-planner", "source-epoch")!.seq,
      ).toBe(250);
    } finally {
      db.close();
    }
    close(store);
    const restarted = open(databasePath);
    restarted.update("conversation", (record) => {
      expect(restarted.acceptSourceSequence(record, "agent-planner", "source-epoch", 249)).toBe(
        false,
      );
      expect(restarted.acceptSourceSequence(record, "agent-planner", "source-epoch", 250)).toBe(
        false,
      );
      expect(restarted.acceptSourceSequence(record, "agent-planner", "source-epoch", 251)).toBe(
        true,
      );
    });
    expect(restarted.fetch("conversation").rows[0]!.text).toBe("片段250");
  });

  it.each([
    ["invalid JSON", "{"],
    ["invalid schema", JSON.stringify({ snapshot: { conversationId: "conversation" } })],
  ])("isolates %s from healthy records during listing and lookup", (_message, corrupted) => {
    const databasePath = filePath();
    const warnings = vi.fn();
    const store = open(databasePath, warnings);
    create(store);
    const healthy = snapshot("healthy", "healthy-workspace");
    healthy.members = [];
    healthy.anchorAgentId = "healthy-anchor";
    store.create(healthy, { idempotencyKey: "healthy-key", fingerprint: "healthy" });
    const db = new DatabaseSync(databasePath);
    try {
      db.prepare("UPDATE task_conversations SET record = ? WHERE conversation_id = ?").run(
        corrupted,
        "conversation",
      );
    } finally {
      db.close();
    }

    expect(store.list().map((record) => record.snapshot.conversationId)).toEqual(["healthy"]);
    expect(warnings).toHaveBeenCalledWith(expect.any(Error), "conversation");
    warnings.mockClear();
    expect(store.find({ conversationId: "conversation" })).toBeNull();
    expect(warnings).toHaveBeenCalledWith(expect.any(Error), "conversation");
    warnings.mockClear();
    expect(store.find({ workspaceId: "workspace" })).toBeNull();
    expect(warnings).toHaveBeenCalledWith(expect.any(Error), "conversation");
    warnings.mockClear();
    expect(store.find({ anchorAgentId: "healthy-anchor" })?.snapshot.conversationId).toBe(
      "healthy",
    );
    expect(store.find({ idempotencyKey: "healthy-key" })?.snapshot.conversationId).toBe("healthy");
    expect(warnings).toHaveBeenCalledWith(expect.any(Error), "conversation");
  });

  it("migrates healthy legacy records independently of corrupt records at startup", () => {
    const databasePath = filePath();
    const store = open(databasePath);
    create(store);
    store.update("conversation", (record) => {
      store.append(record, {
        sourceKey: "legacy-start",
        kind: "assistant",
        text: "旧格式公开历史",
        source: {
          backendAgentId: "agent-planner",
          memberId: "planner",
          epoch: "legacy-source",
          seq: 20,
        },
      });
    });
    const record = store.get("conversation")!;
    const legacy = {
      ...record,
      rows: record.rows,
      sources: { ...record.sources, "fragment:legacy": record.rows[0]!.id },
      rowSourceSeqRanges: record.rowSourceSeqRanges,
    };
    close(store);
    const db = new DatabaseSync(databasePath);
    try {
      db.prepare("UPDATE task_conversations SET record = ?").run(JSON.stringify(legacy));
      db.exec("DELETE FROM task_conversation_rows; DELETE FROM task_conversation_sources;");
      db.prepare("INSERT INTO task_conversations VALUES (?, ?, ?, ?)").run(
        "broken",
        "broken-workspace",
        "broken-key",
        "{",
      );
    } finally {
      db.close();
    }
    const warnings = vi.fn();
    let restarted!: TaskConversationStore;
    expect(() => {
      restarted = open(databasePath, warnings);
    }).not.toThrow();
    expect(warnings).toHaveBeenCalledWith(expect.any(Error), "broken");
    expect(restarted.list().map((entry) => entry.snapshot.conversationId)).toEqual([
      "conversation",
    ]);
    expect(restarted.fetch("conversation").rows[0]!.text).toBe("旧格式公开历史");
    expect(restarted.querySource("conversation", { sourceKey: "legacy-start" })).not.toBeNull();
    expect(restarted.querySource("conversation", { sourceKey: "fragment:legacy" })).toBeNull();
    restarted.update("conversation", (current) => {
      expect(restarted.acceptSourceSequence(current, "agent-planner", "legacy-source", 20)).toBe(
        false,
      );
    });
    const inspected = new DatabaseSync(databasePath);
    try {
      const metadata = JSON.parse(
        String(
          inspected
            .prepare("SELECT record FROM task_conversations WHERE conversation_id = ?")
            .get("conversation")!.record,
        ),
      );
      expect(metadata).not.toHaveProperty("rows");
      expect(
        inspected.prepare("SELECT COUNT(*) AS count FROM task_conversation_rows").get()!.count,
      ).toBe(1);
    } finally {
      inspected.close();
    }
  });

  it("retains the complete legacy blob when migration fails and retries safely after startup", async () => {
    const databasePath = filePath();
    const store = open(databasePath);
    create(store);
    store.update("conversation", (record) => {
      store.append(record, {
        sourceKey: "legacy-preserved",
        kind: "assistant",
        text: "迁移失败时必须完整保留的历史",
        completed: true,
      });
    });
    const record = store.get("conversation")!;
    const legacyJson = JSON.stringify({
      ...record,
      rows: record.rows,
      sources: record.sources,
      rowSourceSeqRanges: record.rowSourceSeqRanges,
    });
    close(store);
    const db = new DatabaseSync(databasePath);
    try {
      db.prepare("UPDATE task_conversations SET record = ?").run(legacyJson);
      db.exec(`
        DELETE FROM task_conversation_rows;
        DELETE FROM task_conversation_sources;
        CREATE TRIGGER reject_legacy_migration BEFORE INSERT ON task_conversation_rows
        BEGIN SELECT RAISE(ABORT, 'injected legacy row migration failure'); END;
      `);
    } finally {
      db.close();
    }

    const warnings = vi.fn();
    const failed = open(databasePath, warnings);
    expect(warnings).toHaveBeenCalledWith(
      expect.objectContaining({ message: "injected legacy row migration failure" }),
      "conversation",
    );
    expect(failed.list()).toEqual([]);
    expect(failed.find({ conversationId: "conversation" })).toBeNull();
    expect(failed.find({ workspaceId: "workspace" })).toBeNull();
    expect(() => failed.get("conversation")).toThrow();
    const pause = (current: StoredTaskConversation) => {
      current.snapshot.status = "paused";
    };
    expect(() => failed.update("conversation", pause)).toThrow();

    const service = new TaskConversationService({
      store: failed,
      agentManager: { subscribe: () => () => undefined },
      agentStorage: { get: async () => null },
      workspaceRegistry: { get: async () => null },
      plugins: { before: async () => undefined, hasBefore: () => false },
      logger: pino({ level: "silent" }),
    } as unknown as ConstructorParameters<typeof TaskConversationService>[0]);
    await service.close();
    stores.delete(failed);

    const inspected = new DatabaseSync(databasePath);
    try {
      expect(String(inspected.prepare("SELECT record FROM task_conversations").get()!.record)).toBe(
        legacyJson,
      );
      expect(
        inspected.prepare("SELECT COUNT(*) AS count FROM task_conversation_rows").get()!.count,
      ).toBe(0);
      inspected.exec("DROP TRIGGER reject_legacy_migration");
    } finally {
      inspected.close();
    }
    const retried = open(databasePath);
    expect(retried.fetch("conversation").rows[0]!.text).toBe("迁移失败时必须完整保留的历史");
    expect(retried.querySource("conversation", { sourceKey: "legacy-preserved" })?.seq).toBe(1);
    expect(retried.get("conversation")?.snapshot.status).toBe("active");
  });

  it("rejects lookups without any condition", () => {
    const store = open();
    create(store);
    expect(() => store.find({})).toThrow("at least one condition");
    expect(() => store.find({ conversationId: undefined, backendAgentId: undefined })).toThrow(
      "at least one condition",
    );
  });

  it("checks ordinary agent membership through the primary index without reading conversation records", () => {
    const databasePath = filePath();
    const warnings = vi.fn();
    const store = open(databasePath, warnings);
    create(store);
    const db = new DatabaseSync(databasePath);
    try {
      const plans = db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT 1 FROM task_conversation_members WHERE backend_agent_id = ?",
        )
        .all("ordinary-agent");
      const detail = plans.map((plan) => String(plan.detail)).join("\n");
      expect(detail).toMatch(/SEARCH task_conversation_members USING (?:COVERING )?INDEX/);
      expect(detail).not.toMatch(/SCAN|task_conversations\b/);
      // Invalid metadata makes accidental record reads observable, even on misses.
      db.exec("UPDATE task_conversations SET record = '{'");
      for (let index = 0; index < 2000; index++)
        expect(store.hasMember(`ordinary-${index}`)).toBe(false);
      expect(store.hasMember("agent-planner")).toBe(true);
      expect(warnings).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
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

it("rejects timeline writes outside the metadata transaction", () => {
  const store = open();
  create(store);
  const record = store.get("conversation")!;
  expect(() =>
    store.append(record, { sourceKey: "uncommitted", kind: "user", text: "不能独立写行" }),
  ).toThrow("require a store transaction");
  expect(() => store.replaceRow(record, "missing", { text: "不能独立更新" })).toThrow(
    "require a store transaction",
  );
  expect(() => store.acceptSourceSequence(record, "agent", "epoch", 1)).toThrow(
    "require a store transaction",
  );
  expect(store.fetch("conversation").rows).toEqual([]);
});
