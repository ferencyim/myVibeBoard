import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { z } from "zod";
import {
  AgentSessionConfigSchema,
  TaskConversationDeliverySchema,
  TaskConversationPageSchema,
  TaskConversationRowSchema,
  TaskConversationSnapshotSchema,
  type TaskConversationCursor,
  type TaskConversationDelivery,
  type TaskConversationPage,
  type TaskConversationRow,
  type TaskConversationSnapshot,
} from "@getpaseo/protocol/messages";
import type { AgentPromptInput, AgentSessionConfig } from "../agent/agent-sdk-types.js";

// The daemon runs on Node 24; its shared Node 20 type declarations predate node:sqlite.
interface Statement {
  run(...parameters: (string | number | null)[]): unknown;
  get(...parameters: (string | number | null)[]): Record<string, unknown> | undefined;
  all(...parameters: (string | number | null)[]): Record<string, unknown>[];
}
interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (filePath: string) => Database;
};

export interface StoredTaskConversationDelivery extends TaskConversationDelivery {
  requestFingerprint: string;
  prompt?: AgentPromptInput;
  sourceTurnId?: string;
}

export interface StoredTaskConversation {
  snapshot: TaskConversationSnapshot;
  creationKey: string;
  creationFingerprint: string;
  nextSeq: number;
  rows: TaskConversationRow[];
  sources: Record<string, string>;
  rowSourceSeqRanges: Record<string, TaskConversationPage["sourceSeqRanges"]>;
  control?: { status: "stopping" | "settled" | "unknown"; memberId?: string };
  memberConfigs: Record<
    string,
    {
      config: AgentSessionConfig;
      preparedConfig?: AgentSessionConfig;
      env?: Record<string, string>;
      fingerprint: string;
    }
  >;
  deliveries: Record<string, StoredTaskConversationDelivery>;
}

const StoredTaskConversationSchema = z.object({
  snapshot: TaskConversationSnapshotSchema,
  creationKey: z.string(),
  creationFingerprint: z.string(),
  nextSeq: z.number().int().positive(),
  rows: z.array(TaskConversationRowSchema),
  sources: z.record(z.string(), z.string()),
  rowSourceSeqRanges: z.record(z.string(), TaskConversationPageSchema.shape.sourceSeqRanges),
  control: z
    .object({ status: z.enum(["stopping", "settled", "unknown"]), memberId: z.string().optional() })
    .optional(),
  memberConfigs: z.record(
    z.string(),
    z.object({
      config: AgentSessionConfigSchema,
      preparedConfig: AgentSessionConfigSchema.optional(),
      env: z.record(z.string(), z.string()).optional(),
      fingerprint: z.string(),
    }),
  ),
  deliveries: z.record(
    z.string(),
    TaskConversationDeliverySchema.extend({
      requestFingerprint: z.string(),
      prompt: z.unknown().optional(),
      sourceTurnId: z.string().optional(),
    }),
  ),
});

export interface TaskConversationFetchOptions {
  direction?: "tail" | "before" | "after";
  cursor?: TaskConversationCursor;
  limit?: number;
}

export type TaskConversationAppendInput = Omit<
  TaskConversationRow,
  "id" | "epoch" | "seq" | "updatedSeq" | "createdAt"
> & { id?: string; createdAt?: string };

export type TaskConversationRowUpdate = Partial<
  Pick<TaskConversationRow, "text" | "completed" | "source" | "images" | "attachments">
> & { sourceKey?: string };

export interface TaskConversationFindOptions {
  conversationId?: string;
  workspaceId?: string;
  anchorAgentId?: string;
  backendAgentId?: string;
  idempotencyKey?: string;
}

function rowWatermark(row: TaskConversationRow): number {
  return row.updatedSeq ?? row.seq;
}

function validateFetchOptions(options: TaskConversationFetchOptions, epoch: string) {
  const direction = options.direction ?? "tail";
  const limit = options.limit ?? 100;
  const cursor = options.cursor;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("Task conversation page limit must be between 1 and 500");
  }
  if (cursor && cursor.epoch !== epoch) {
    throw new Error("Task conversation cursor belongs to another epoch");
  }
  if (direction !== "tail" && !cursor) {
    throw new Error("Task conversation pagination requires a cursor");
  }
  return { direction, limit, cursor };
}

function collapseRanges(
  record: StoredTaskConversation,
  rows: TaskConversationRow[],
): TaskConversationPage["sourceSeqRanges"] {
  return rows
    .flatMap((row) => record.rowSourceSeqRanges[row.id]!)
    .map((range) => ({ start: range.start, end: range.end }))
    .sort((left, right) => left.start - right.start)
    .reduce<TaskConversationPage["sourceSeqRanges"]>((ranges, range) => {
      const previous = ranges.at(-1);
      if (previous && range.start <= previous.end + 1) {
        previous.end = Math.max(previous.end, range.end);
      } else ranges.push(range);
      return ranges;
    }, []);
}

/** Public task history has its own durable authority, never provider hydration. */
export class TaskConversationStore {
  private readonly db: Database;

  constructor(options: { filePath: string }) {
    if (options.filePath !== ":memory:") {
      mkdirSync(path.dirname(options.filePath), { recursive: true });
    }
    this.db = new DatabaseSync(options.filePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS task_conversations (
        conversation_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL UNIQUE,
        creation_key TEXT NOT NULL UNIQUE,
        record TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_conversation_members (
        backend_agent_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES task_conversations(conversation_id)
      );
    `);
  }

  create(
    snapshot: TaskConversationSnapshot,
    options: { idempotencyKey: string; fingerprint: string },
  ): StoredTaskConversation {
    return this.transaction(() => {
      const existing = this.find({ idempotencyKey: options.idempotencyKey });
      if (existing) {
        if (existing.creationFingerprint !== options.fingerprint) {
          throw new Error("Task conversation creation key was reused with different input");
        }
        return existing;
      }
      if (snapshot.lastSeq !== 0) {
        throw new Error("A new task conversation must have an empty timeline");
      }
      const record: StoredTaskConversation = {
        snapshot: structuredClone(snapshot),
        creationKey: options.idempotencyKey,
        creationFingerprint: options.fingerprint,
        nextSeq: 1,
        rows: [],
        sources: {},
        rowSourceSeqRanges: {},
        memberConfigs: {},
        deliveries: {},
      };
      this.db
        .prepare(
          "INSERT INTO task_conversations (conversation_id, workspace_id, creation_key, record) VALUES (?, ?, ?, ?)",
        )
        .run(
          snapshot.conversationId,
          snapshot.workspaceId,
          options.idempotencyKey,
          JSON.stringify(record),
        );
      this.indexMembers(record);
      return record;
    });
  }

  get(conversationId: string): StoredTaskConversation | null {
    return this.read(
      this.db
        .prepare("SELECT record FROM task_conversations WHERE conversation_id = ?")
        .get(conversationId),
    );
  }

  list(): StoredTaskConversation[] {
    return this.db
      .prepare("SELECT record FROM task_conversations ORDER BY rowid")
      .all()
      .map((row) => this.read(row)!);
  }

  find(options: TaskConversationFindOptions): StoredTaskConversation | null {
    const filters: string[] = [];
    const parameters: string[] = [];
    for (const [field, value] of [
      ["conversation_id", options.conversationId],
      ["workspace_id", options.workspaceId],
      ["creation_key", options.idempotencyKey],
    ] as const) {
      if (value !== undefined) {
        filters.push(`c.${field} = ?`);
        parameters.push(value);
      }
    }
    if (options.backendAgentId !== undefined) {
      filters.push(
        "EXISTS (SELECT 1 FROM task_conversation_members m WHERE m.conversation_id = c.conversation_id AND m.backend_agent_id = ?)",
      );
      parameters.push(options.backendAgentId);
    }
    const records = this.db
      .prepare(
        `SELECT c.record FROM task_conversations c${filters.length ? ` WHERE ${filters.join(" AND ")}` : ""} ORDER BY c.rowid`,
      )
      .all(...parameters)
      .map((row) => this.read(row)!);
    return (
      records.find(
        (record) =>
          options.anchorAgentId === undefined ||
          record.snapshot.anchorAgentId === options.anchorAgentId,
      ) ?? null
    );
  }

  findByMember(backendAgentId: string): StoredTaskConversation | null {
    return this.find({ backendAgentId });
  }

  /** The callback is synchronous; callers may publish its result only after this returns. */
  update<T>(conversationId: string, mutate: (record: StoredTaskConversation) => T): T {
    return this.transaction(() => {
      const record = this.get(conversationId);
      if (!record) throw new Error("Task conversation not found");
      const identity = { ...record.snapshot };
      const result = mutate(record);
      if (result instanceof Promise) {
        throw new Error("Task conversation transactions must be synchronous");
      }
      if (
        record.snapshot.conversationId !== identity.conversationId ||
        record.snapshot.workspaceId !== identity.workspaceId ||
        record.snapshot.epoch !== identity.epoch
      ) {
        throw new Error("Task conversation identity is immutable");
      }
      record.snapshot.lastSeq = record.nextSeq - 1;
      record.snapshot.updatedAt = new Date().toISOString();
      this.db
        .prepare("UPDATE task_conversations SET record = ? WHERE conversation_id = ?")
        .run(JSON.stringify(record), conversationId);
      this.indexMembers(record);
      return result;
    });
  }

  append(record: StoredTaskConversation, input: TaskConversationAppendInput): TaskConversationRow {
    const existingId = Object.hasOwn(record.sources, input.sourceKey)
      ? record.sources[input.sourceKey]
      : undefined;
    if (existingId) return this.requireRow(record, existingId);
    const seq = record.nextSeq++;
    const row: TaskConversationRow = {
      ...structuredClone(input),
      id: input.id ?? randomUUID(),
      epoch: record.snapshot.epoch,
      seq,
      updatedSeq: seq,
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    record.rows.push(row);
    record.rowSourceSeqRanges[row.id] = [{ start: seq, end: seq }];
    Object.defineProperty(record.sources, input.sourceKey, {
      value: row.id,
      configurable: true,
      enumerable: true,
      writable: true,
    });
    record.snapshot.lastSeq = seq;
    return row;
  }

  /** Streaming changes retain the original row position and frozen speaker identity. */
  replaceRow(
    record: StoredTaskConversation,
    rowId: string,
    patch: TaskConversationRowUpdate,
  ): TaskConversationRow {
    const row = this.requireRow(record, rowId);
    if (patch.sourceKey && Object.hasOwn(record.sources, patch.sourceKey)) {
      return this.requireRow(record, record.sources[patch.sourceKey]!);
    }
    const { sourceKey, ...content } = structuredClone(patch);
    const seq = record.nextSeq++;
    Object.assign(row, content, { updatedSeq: seq });
    const ranges = record.rowSourceSeqRanges[row.id]!;
    const previous = ranges.at(-1);
    if (previous && previous.end === seq - 1) previous.end = seq;
    else ranges.push({ start: seq, end: seq });
    if (sourceKey) {
      Object.defineProperty(record.sources, sourceKey, {
        value: row.id,
        configurable: true,
        enumerable: true,
        writable: true,
      });
    }
    record.snapshot.lastSeq = record.nextSeq - 1;
    return row;
  }

  fetch(conversationId: string, options: TaskConversationFetchOptions = {}): TaskConversationPage {
    const record = this.get(conversationId);
    if (!record) throw new Error("Task conversation not found");
    const { direction, limit, cursor } = validateFetchOptions(options, record.snapshot.epoch);
    const candidates = record.rows.filter((row) => {
      if (direction === "before") return row.seq < cursor!.seq;
      if (direction === "after") return rowWatermark(row) > cursor!.seq;
      return true;
    });
    const position = direction === "after" ? rowWatermark : (row: TaskConversationRow) => row.seq;
    candidates.sort((left, right) => position(left) - position(right));
    const rows = direction === "after" ? candidates.slice(0, limit) : candidates.slice(-limit);
    const last = rows.at(-1);
    let endSeq = last ? position(last) : null;
    if (last && direction === "tail") endSeq = record.snapshot.lastSeq;
    rows.sort((left, right) => left.seq - right.seq);
    const startSeq = rows[0]?.seq ?? null;
    return {
      conversationId,
      epoch: record.snapshot.epoch,
      rows,
      startCursor: startSeq === null ? null : { epoch: record.snapshot.epoch, seq: startSeq },
      endCursor: endSeq === null ? null : { epoch: record.snapshot.epoch, seq: endSeq },
      hasOlder: startSeq !== null && record.rows.some((row) => row.seq < startSeq),
      hasNewer:
        direction === "before"
          ? endSeq !== null && record.rows.some((row) => row.seq > endSeq)
          : direction === "after" && candidates.length > rows.length,
      sourceSeqRanges: collapseRanges(record, rows),
    };
  }

  querySource(
    conversationId: string,
    options: {
      sourceKey?: string;
      cursor?: TaskConversationCursor;
      memberId?: string;
      role?: string;
      completed?: boolean;
    },
  ): TaskConversationRow | null {
    const record = this.get(conversationId);
    if (!record) throw new Error("Task conversation not found");
    if (options.cursor && options.cursor.epoch !== record.snapshot.epoch) return null;
    return (
      record.rows.findLast((row) => {
        if (options.sourceKey !== undefined) {
          if (!Object.hasOwn(record.sources, options.sourceKey)) return false;
          if (record.sources[options.sourceKey] !== row.id) return false;
        }
        return (
          (options.cursor === undefined || row.seq === options.cursor.seq) &&
          (options.memberId === undefined || row.speaker?.memberId === options.memberId) &&
          (options.role === undefined || row.speaker?.role === options.role) &&
          (options.completed === undefined || row.completed === options.completed)
        );
      }) ?? null
    );
  }

  close(): void {
    this.db.close();
  }

  private read(row: Record<string, unknown> | undefined): StoredTaskConversation | null {
    if (!row) return null;
    let value: unknown;
    try {
      value = JSON.parse(String(row.record));
    } catch {
      throw new Error("Task conversation store contains invalid JSON; history cannot be loaded");
    }
    if (!StoredTaskConversationSchema.safeParse(value).success) {
      throw new Error(
        "Task conversation store record is invalid or incompatible; history cannot be loaded",
      );
    }
    const record = value as StoredTaskConversation;
    if (record.nextSeq !== record.snapshot.lastSeq + 1) {
      throw new Error("Task conversation store sequence is inconsistent; history cannot be loaded");
    }
    for (const item of record.rows) {
      if (
        item.epoch !== record.snapshot.epoch ||
        rowWatermark(item) >= record.nextSeq ||
        !Object.hasOwn(record.rowSourceSeqRanges, item.id)
      ) {
        throw new Error("Task conversation store row is inconsistent; history cannot be loaded");
      }
    }
    return record;
  }

  private requireRow(record: StoredTaskConversation, rowId: string): TaskConversationRow {
    const row = record.rows.find((candidate) => candidate.id === rowId);
    if (!row) throw new Error("Task conversation source index is inconsistent");
    return row;
  }

  private indexMembers(record: StoredTaskConversation): void {
    const conversationId = record.snapshot.conversationId;
    this.db
      .prepare("DELETE FROM task_conversation_members WHERE conversation_id = ?")
      .run(conversationId);
    const insert = this.db.prepare(
      "INSERT INTO task_conversation_members (backend_agent_id, conversation_id) VALUES (?, ?)",
    );
    for (const member of record.snapshot.members) {
      insert.run(member.backendAgentId, conversationId);
    }
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
