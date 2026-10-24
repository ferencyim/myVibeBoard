import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { tmpdir } from "node:os";
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
import { persistImageAttachment } from "../file-upload/image-attachment.js";

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
  recoveryMembers?: string[];
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
  recoveryMembers: z.array(z.string()).optional(),
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

export interface TaskConversationRowQuery {
  afterSeq?: number;
  throughSeq?: number;
  kind?: TaskConversationRow["kind"];
  completed?: boolean;
  backendAgentIds?: string[];
  clientMessageId?: string;
}

export interface TaskConversationUpdateOptions {
  /** Recoverable streaming projections can use NORMAL; delivery/control commits use FULL. */
  durability?: "normal" | "full";
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
  rowRanges: TaskConversationPage["sourceSeqRanges"][],
): TaskConversationPage["sourceSeqRanges"] {
  return rowRanges
    .flat()
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
  private inTransaction = false;
  private readonly attachmentsHome: string;
  private readonly warn: (error: unknown, conversationId: string) => void;

  constructor(options: {
    filePath: string;
    onCorruptRecord?: (error: unknown, conversationId: string) => void;
  }) {
    if (options.filePath !== ":memory:") {
      mkdirSync(path.dirname(options.filePath), { recursive: true });
    }
    this.db = new DatabaseSync(options.filePath);
    this.attachmentsHome =
      options.filePath === ":memory:" ? tmpdir() : path.dirname(options.filePath);
    this.warn =
      options.onCorruptRecord ??
      ((error, id) => console.warn(`Task conversation ${id} was skipped`, error));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
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
      CREATE INDEX IF NOT EXISTS task_conversation_members_conversation ON task_conversation_members(conversation_id);
      CREATE TABLE IF NOT EXISTS task_conversation_rows (
        conversation_id TEXT NOT NULL REFERENCES task_conversations(conversation_id),
        id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        updated_seq INTEGER NOT NULL,
        record TEXT NOT NULL,
        ranges TEXT NOT NULL,
        PRIMARY KEY (conversation_id, id),
        UNIQUE (conversation_id, seq)
      );
      CREATE INDEX IF NOT EXISTS task_conversation_rows_updates ON task_conversation_rows(conversation_id, updated_seq);
      CREATE TABLE IF NOT EXISTS task_conversation_sources (
        conversation_id TEXT NOT NULL REFERENCES task_conversations(conversation_id),
        source_key TEXT NOT NULL,
        row_id TEXT NOT NULL,
        PRIMARY KEY (conversation_id, source_key)
      );
      CREATE TABLE IF NOT EXISTS task_conversation_source_watermarks (
        conversation_id TEXT NOT NULL REFERENCES task_conversations(conversation_id),
        backend_agent_id TEXT NOT NULL,
        epoch TEXT NOT NULL,
        seq INTEGER NOT NULL,
        PRIMARY KEY (conversation_id, backend_agent_id, epoch)
      );
    `);
    // Migrate each legacy record independently: one damaged conversation must not prevent boot.
    for (const row of this.db
      .prepare("SELECT conversation_id, record FROM task_conversations")
      .all()) {
      try {
        const raw = JSON.parse(String(row.record));
        if (!Object.hasOwn(raw, "rows")) continue;
        const legacy = this.validate(raw);
        this.transaction(() => {
          for (const item of legacy.rows) this.writeRow(legacy, item);
          for (const [key, id] of Object.entries(legacy.sources)) {
            if (!key.startsWith("fragment:")) this.indexSource(legacy, key, id);
          }
          for (const item of legacy.rows) {
            if (item.source?.epoch && item.source.seq !== undefined)
              this.acceptSourceSequence(
                legacy,
                item.source.backendAgentId,
                item.source.epoch,
                item.source.seq,
              );
          }
          this.writeMetadata(legacy);
        });
      } catch (error) {
        this.warn(error, String(row.conversation_id));
      }
    }
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
          this.metadata(record),
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
      .prepare("SELECT conversation_id, record FROM task_conversations ORDER BY rowid")
      .all()
      .flatMap((row) => {
        try {
          return [this.read(row)!];
        } catch (error) {
          this.warn(error, String(row.conversation_id));
          return [];
        }
      });
  }

  find(options: TaskConversationFindOptions): StoredTaskConversation | null {
    if (!Object.values(options).some((value) => value !== undefined))
      throw new Error("Task conversation lookup requires at least one condition");
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
        "c.conversation_id = (SELECT conversation_id FROM task_conversation_members WHERE backend_agent_id = ?)",
      );
      parameters.push(options.backendAgentId);
    }
    const records = this.db
      .prepare(
        `SELECT c.conversation_id, c.record FROM task_conversations c${filters.length ? ` WHERE ${filters.join(" AND ")}` : ""} ORDER BY c.rowid`,
      )
      .all(...parameters)
      .flatMap((row) => {
        try {
          return [this.read(row)!];
        } catch (error) {
          this.warn(error, String(row.conversation_id));
          return [];
        }
      });
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

  hasMember(backendAgentId: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM task_conversation_members WHERE backend_agent_id = ?")
      .get(backendAgentId);
  }

  conversationIdForMember(backendAgentId: string): string | null {
    const row = this.db
      .prepare("SELECT conversation_id FROM task_conversation_members WHERE backend_agent_id = ?")
      .get(backendAgentId);
    return row ? String(row.conversation_id) : null;
  }

  sourceSequence(conversationId: string, agentId: string, epoch: string): number {
    return Number(
      this.db
        .prepare(
          "SELECT seq FROM task_conversation_source_watermarks WHERE conversation_id = ? AND backend_agent_id = ? AND epoch = ?",
        )
        .get(conversationId, agentId, epoch)?.seq ?? -1,
    );
  }

  acceptSourceSequence(
    record: StoredTaskConversation,
    agentId: string,
    epoch: string,
    seq: number,
  ): boolean {
    this.assertTransaction();
    const previous = this.db
      .prepare(
        "SELECT seq FROM task_conversation_source_watermarks WHERE conversation_id = ? AND backend_agent_id = ? AND epoch = ?",
      )
      .get(record.snapshot.conversationId, agentId, epoch);
    if (previous && Number(previous.seq) >= seq) return false;
    this.db
      .prepare(
        "INSERT INTO task_conversation_source_watermarks VALUES (?, ?, ?, ?) ON CONFLICT(conversation_id, backend_agent_id, epoch) DO UPDATE SET seq = excluded.seq",
      )
      .run(record.snapshot.conversationId, agentId, epoch, seq);
    return true;
  }

  /** The callback is synchronous; callers may publish its result only after this returns. */
  update<T>(
    conversationId: string,
    mutate: (record: StoredTaskConversation) => T,
    options: TaskConversationUpdateOptions = {},
  ): T {
    return this.transaction(() => {
      const record = this.get(conversationId);
      if (!record) throw new Error("Task conversation not found");
      const identity = { ...record.snapshot };
      const membersBefore = record.snapshot.members
        .map((member) => member.backendAgentId)
        .join("\n");
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
      this.writeMetadata(record);
      if (
        membersBefore !== record.snapshot.members.map((member) => member.backendAgentId).join("\n")
      )
        this.indexMembers(record);
      return result;
    }, options.durability);
  }

  append(record: StoredTaskConversation, input: TaskConversationAppendInput): TaskConversationRow {
    this.assertTransaction();
    const existingId = this.sourceRowId(record, input.sourceKey);
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
    this.writeRow(record, row, [{ start: seq, end: seq }]);
    this.indexSource(record, input.sourceKey, row.id);
    record.snapshot.lastSeq = seq;
    return row;
  }

  /** Streaming changes retain the original row position and frozen speaker identity. */
  replaceRow(
    record: StoredTaskConversation,
    rowOrId: TaskConversationRow | string,
    patch: TaskConversationRowUpdate,
  ): TaskConversationRow {
    this.assertTransaction();
    const row = typeof rowOrId === "string" ? this.requireRow(record, rowOrId) : rowOrId;
    const existingId = patch.sourceKey && this.sourceRowId(record, patch.sourceKey);
    if (existingId) {
      return this.requireRow(record, existingId);
    }
    const { sourceKey, ...content } = structuredClone(patch);
    const seq = record.nextSeq++;
    Object.assign(row, content, { updatedSeq: seq });
    const ranges = this.ranges(record, row.id);
    const previous = ranges.at(-1);
    if (previous && previous.end === seq - 1) previous.end = seq;
    else ranges.push({ start: seq, end: seq });
    this.writeRow(record, row, ranges);
    if (sourceKey && !sourceKey.startsWith("fragment:"))
      this.indexSource(record, sourceKey, row.id);
    record.snapshot.lastSeq = record.nextSeq - 1;
    return row;
  }

  fetch(conversationId: string, options: TaskConversationFetchOptions = {}): TaskConversationPage {
    const record = this.get(conversationId);
    if (!record) throw new Error("Task conversation not found");
    const { direction, limit, cursor } = validateFetchOptions(options, record.snapshot.epoch);
    const after = direction === "after";
    const condition = direction === "tail" ? "" : ` AND ${after ? "updated_seq >" : "seq <"} ?`;
    const parameters = [
      conversationId,
      ...(cursor && direction !== "tail" ? [cursor.seq] : []),
      limit + 1,
    ];
    const selected = this.db
      .prepare(
        `SELECT record, ranges FROM task_conversation_rows WHERE conversation_id = ?${condition} ORDER BY ${after ? "updated_seq ASC" : "seq DESC"} LIMIT ?`,
      )
      .all(...parameters);
    const hasMore = selected.length > limit;
    const rows = selected.slice(0, limit).map((row) => this.readRow(row));
    if (!after) rows.reverse();
    const last = rows.at(-1);
    let endSeq: number | null = null;
    if (last) endSeq = after ? rowWatermark(last) : last.seq;
    if (direction === "tail" && last) endSeq = record.snapshot.lastSeq;
    rows.sort((left, right) => left.seq - right.seq);
    const startSeq = rows[0]?.seq ?? null;
    return {
      conversationId,
      epoch: record.snapshot.epoch,
      rows,
      startCursor: startSeq === null ? null : { epoch: record.snapshot.epoch, seq: startSeq },
      endCursor: endSeq === null ? null : { epoch: record.snapshot.epoch, seq: endSeq },
      hasOlder: this.hasRowsBeyond(conversationId, startSeq, "<"),
      hasNewer: after
        ? hasMore
        : direction === "before" && this.hasRowsBeyond(conversationId, endSeq, ">"),
      sourceSeqRanges: collapseRanges(rows.map((row) => this.ranges(record, row.id))),
    };
  }

  private hasRowsBeyond(conversationId: string, seq: number | null, direction: "<" | ">"): boolean {
    return (
      seq !== null &&
      !!this.db
        .prepare(
          `SELECT 1 FROM task_conversation_rows WHERE conversation_id = ? AND seq ${direction} ? LIMIT 1`,
        )
        .get(conversationId, seq)
    );
  }

  querySource(
    conversation: string | StoredTaskConversation,
    options: {
      sourceKey?: string;
      cursor?: TaskConversationCursor;
      memberId?: string;
      role?: string;
      completed?: boolean;
    },
  ): TaskConversationRow | null {
    const record = typeof conversation === "string" ? this.get(conversation) : conversation;
    if (!record) throw new Error("Task conversation not found");
    const conversationId = record.snapshot.conversationId;
    if (options.cursor && options.cursor.epoch !== record.snapshot.epoch) return null;
    const filters = ["conversation_id = ?"];
    const parameters: (string | number)[] = [conversationId];
    if (options.sourceKey !== undefined) {
      const id = this.sourceRowId(record, options.sourceKey);
      if (!id) return null;
      filters.push("id = ?");
      parameters.push(id);
    }
    if (options.cursor) {
      filters.push("seq = ?");
      parameters.push(options.cursor.seq);
    }
    if (options.memberId !== undefined) {
      filters.push("json_extract(record, '$.speaker.memberId') = ?");
      parameters.push(options.memberId);
    }
    if (options.role !== undefined) {
      filters.push("json_extract(record, '$.speaker.role') = ?");
      parameters.push(options.role);
    }
    if (options.completed !== undefined) {
      filters.push("COALESCE(json_extract(record, '$.completed'), 0) = ?");
      parameters.push(Number(options.completed));
    }
    const row = this.db
      .prepare(
        `SELECT record FROM task_conversation_rows WHERE ${filters.join(" AND ")} ORDER BY seq DESC LIMIT 1`,
      )
      .get(...parameters);
    return row ? this.readRow(row) : null;
  }

  /** Filter in SQLite so admission/recovery never hydrate an entire conversation implicitly. */
  queryRows(
    conversation: string | StoredTaskConversation,
    options: TaskConversationRowQuery,
  ): TaskConversationRow[] {
    const conversationId =
      typeof conversation === "string" ? conversation : conversation.snapshot.conversationId;
    const filters = ["conversation_id = ?"];
    const parameters: (string | number)[] = [conversationId];
    if (options.afterSeq !== undefined) {
      filters.push("updated_seq > ?");
      parameters.push(options.afterSeq);
    }
    if (options.throughSeq !== undefined) {
      filters.push("updated_seq <= ?");
      parameters.push(options.throughSeq);
    }
    if (options.kind !== undefined) {
      filters.push("json_extract(record, '$.kind') = ?");
      parameters.push(options.kind);
    }
    if (options.completed !== undefined) {
      filters.push("COALESCE(json_extract(record, '$.completed'), 0) = ?");
      parameters.push(Number(options.completed));
    }
    if (options.backendAgentIds !== undefined) {
      if (!options.backendAgentIds.length) return [];
      filters.push(
        `json_extract(record, '$.source.backendAgentId') IN (${options.backendAgentIds.map(() => "?").join(", ")})`,
      );
      parameters.push(...options.backendAgentIds);
    }
    if (options.clientMessageId !== undefined) {
      filters.push("json_extract(record, '$.clientMessageId') = ?");
      parameters.push(options.clientMessageId);
    }
    return this.db
      .prepare(
        `SELECT record FROM task_conversation_rows WHERE ${filters.join(" AND ")} ORDER BY seq`,
      )
      .all(...parameters)
      .map((row) => this.readRow(row));
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
    if (value && typeof value === "object" && Object.hasOwn(value, "rows"))
      throw new Error(
        "Task conversation legacy migration is incomplete; original history has been retained",
      );
    value = this.validate({ rows: [], sources: {}, rowSourceSeqRanges: {}, ...(value as object) });
    return value as StoredTaskConversation;
  }

  private validate(value: unknown): StoredTaskConversation {
    if (!StoredTaskConversationSchema.safeParse(value).success)
      throw new Error(
        "Task conversation store record is invalid or incompatible; history cannot be loaded",
      );
    const record = value as StoredTaskConversation;
    if (record.nextSeq !== record.snapshot.lastSeq + 1)
      throw new Error("Task conversation store sequence is inconsistent; history cannot be loaded");
    for (const item of record.rows) {
      if (
        item.epoch !== record.snapshot.epoch ||
        rowWatermark(item) >= record.nextSeq ||
        !Object.hasOwn(record.rowSourceSeqRanges, item.id)
      )
        throw new Error("Task conversation store row is inconsistent; history cannot be loaded");
    }
    return record;
  }

  private metadata(record: StoredTaskConversation): string {
    for (const delivery of Object.values(record.deliveries)) delete delivery.prompt;
    const {
      rows: _rows,
      sources: _sources,
      rowSourceSeqRanges: _ranges,
      ...metadata
    } = Object.fromEntries(Object.entries(record)) as StoredTaskConversation;
    return JSON.stringify(metadata);
  }

  private writeMetadata(record: StoredTaskConversation): void {
    this.db
      .prepare("UPDATE task_conversations SET record = ? WHERE conversation_id = ?")
      .run(this.metadata(record), record.snapshot.conversationId);
  }

  private readRow(row: Record<string, unknown>): TaskConversationRow {
    const { imageReferences, ...item } = JSON.parse(String(row.record));
    if (imageReferences)
      item.images = imageReferences.flatMap((image: { path: string; mimeType: string }) => {
        try {
          return [{ data: readFileSync(image.path).toString("base64"), mimeType: image.mimeType }];
        } catch (error) {
          // A missing upload must not make otherwise valid public history unreadable.
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          return [];
        }
      });
    return TaskConversationRowSchema.parse(item);
  }

  private writeRow(
    record: StoredTaskConversation,
    row: TaskConversationRow,
    ranges = record.rowSourceSeqRanges[row.id],
  ): void {
    const { images, ...item } = row;
    const imageReferences = images?.map((image) =>
      persistImageAttachment(this.attachmentsHome, image),
    );
    this.db
      .prepare(
        "INSERT INTO task_conversation_rows VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(conversation_id, id) DO UPDATE SET updated_seq = excluded.updated_seq, record = excluded.record, ranges = excluded.ranges",
      )
      .run(
        record.snapshot.conversationId,
        row.id,
        row.seq,
        rowWatermark(row),
        JSON.stringify({ ...item, ...(imageReferences ? { imageReferences } : {}) }),
        JSON.stringify(ranges),
      );
  }

  private ranges(
    record: StoredTaskConversation,
    rowId: string,
  ): TaskConversationPage["sourceSeqRanges"] {
    return JSON.parse(
      String(
        this.db
          .prepare("SELECT ranges FROM task_conversation_rows WHERE conversation_id = ? AND id = ?")
          .get(record.snapshot.conversationId, rowId)!.ranges,
      ),
    );
  }

  private sourceRowId(record: StoredTaskConversation, sourceKey: string): string | undefined {
    const row = this.db
      .prepare(
        "SELECT row_id FROM task_conversation_sources WHERE conversation_id = ? AND source_key = ?",
      )
      .get(record.snapshot.conversationId, sourceKey);
    return row ? String(row.row_id) : undefined;
  }

  private indexSource(record: StoredTaskConversation, key: string, rowId: string): void {
    this.db
      .prepare(
        "INSERT INTO task_conversation_sources VALUES (?, ?, ?) ON CONFLICT(conversation_id, source_key) DO NOTHING",
      )
      .run(record.snapshot.conversationId, key, rowId);
  }

  private requireRow(record: StoredTaskConversation, rowId: string): TaskConversationRow {
    const row = this.db
      .prepare("SELECT record FROM task_conversation_rows WHERE conversation_id = ? AND id = ?")
      .get(record.snapshot.conversationId, rowId);
    if (!row) throw new Error("Task conversation source index is inconsistent");
    return this.readRow(row);
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

  private transaction<T>(operation: () => T, durability: "normal" | "full" = "full"): T {
    if (durability === "full") this.db.exec("PRAGMA synchronous = FULL");
    let began = false;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      began = true;
      this.inTransaction = true;
      const result = operation();
      this.db.exec("COMMIT");
      began = false;
      return result;
    } catch (error) {
      if (began) this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.inTransaction = false;
      if (durability === "full") this.db.exec("PRAGMA synchronous = NORMAL");
    }
  }
  private assertTransaction(): void {
    if (!this.inTransaction) throw new Error("Task timeline writes require a store transaction");
  }
}
