import { z } from "zod";
import {
  TaskArtifactSchema,
  TaskArtifactKindSchema,
  TaskPlanSourceSchema,
  TaskControlSchema,
  TaskPhaseSchema,
  type TaskArtifact,
  type TaskArtifactKind,
  type TaskPlanSource,
  type TaskControl,
  type TaskPhase,
} from "../contract/task";
import { decodeRow } from "./rows";
import { publishEvent } from "./events";
import { createTaskCommands, TaskCommandError } from "./tasks";
import type { VibeDb } from "./sqlite";

export interface RecordTaskArtifactInput {
  workspaceId: string;
  kind: TaskArtifactKind;
  sourceKey: string;
  confirmedAt?: string | null;
  source: TaskPlanSource;
  summary: string;
  data?: Record<string, unknown> | null;
  /** Optional milestone state is committed atomically with its durable index. */
  phase?: TaskPhase;
  control?: TaskControl;
}

/** Milestone indexes only; the host owns public text and source history. */
export function createTaskArtifactCommands(db: VibeDb, options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());
  const tasks = createTaskCommands(db, { now });
  const get = (
    workspaceId: string,
    kind: TaskArtifactKind,
    sourceKey: string,
  ): TaskArtifact | undefined => {
    const row = db
      .prepare("SELECT * FROM task_artifact WHERE workspace_id = ? AND kind = ? AND source_key = ?")
      .get(workspaceId, kind, sourceKey);
    return row ? decodeRow(TaskArtifactSchema, row) : undefined;
  };
  const changed = (workspaceId: string) =>
    publishEvent(
      db,
      {
        type: "task.updated",
        payload: { workspaceId, fields: ["artifacts"] },
      },
      now,
    );
  return {
    get,
    list(
      workspaceId: string,
      filter: { kind?: TaskArtifactKind; confirmedAt?: string | null } = {},
    ): TaskArtifact[] {
      const rows = db
        .prepare("SELECT * FROM task_artifact WHERE workspace_id = ? ORDER BY created_at, rowid")
        .all(workspaceId);
      return rows
        .map((row) => decodeRow(TaskArtifactSchema, row))
        .filter(
          (artifact) =>
            (!filter.kind || artifact.kind === filter.kind) &&
            (filter.confirmedAt === undefined || artifact.confirmedAt === filter.confirmedAt),
        );
    },
    pendingPublish(workspaceId?: string): TaskArtifact[] {
      const rows = workspaceId
        ? db
            .prepare(
              "SELECT * FROM task_artifact WHERE published_json IS NULL AND workspace_id = ? ORDER BY created_at,rowid",
            )
            .all(workspaceId)
        : db
            .prepare(
              "SELECT * FROM task_artifact WHERE published_json IS NULL ORDER BY created_at,rowid",
            )
            .all();
      return rows.map((row) => decodeRow(TaskArtifactSchema, row));
    },
    record(input: RecordTaskArtifactInput): TaskArtifact {
      const parsed = z
        .object({
          workspaceId: z.string().trim().min(1),
          kind: TaskArtifactKindSchema,
          sourceKey: z.string().trim().min(1),
          confirmedAt: z.iso.datetime().nullable().optional(),
          source: TaskPlanSourceSchema,
          summary: z.string(),
          data: z.record(z.string(), z.unknown()).nullable().optional(),
          phase: TaskPhaseSchema.optional(),
          control: TaskControlSchema.optional(),
        })
        .strict()
        .parse(input);
      return db.immediate(() => {
        const task = tasks.get(parsed.workspaceId);
        if (!task) throw new TaskCommandError("not_found", "任务不存在");
        if (
          task.conversationId &&
          parsed.source.conversationId &&
          task.conversationId !== parsed.source.conversationId
        )
          throw new TaskCommandError("conflict", "沉淀来源与任务会话不一致");
        if (
          parsed.source.tabNumber &&
          !task.tabs.some(
            (tab) =>
              tab.number === parsed.source.tabNumber &&
              (!parsed.source.agentId || tab.agentId === parsed.source.agentId),
          )
        )
          throw new TaskCommandError("conflict", "沉淀来源不是当前任务的有效 tab");
        if (!parsed.source.tabNumber && !parsed.source.conversationId)
          throw new TaskCommandError("invalid", "沉淀需要任务 tab 或会话来源");
        const previous = get(parsed.workspaceId, parsed.kind, parsed.sourceKey);
        if (previous) {
          if (
            JSON.stringify(previous.source) !== JSON.stringify(parsed.source) ||
            previous.summary !== parsed.summary ||
            JSON.stringify(previous.data) !== JSON.stringify(parsed.data ?? null) ||
            previous.confirmedAt !== (parsed.confirmedAt ?? null)
          )
            throw new TaskCommandError("conflict", "相同来源的沉淀不可改写");
          return previous;
        }
        if (parsed.confirmedAt && task.confirmedAt !== parsed.confirmedAt)
          throw new TaskCommandError("conflict", "任务确认已变化，拒绝写入旧轮次沉淀");
        db.prepare(
          "INSERT INTO task_artifact (workspace_id,kind,source_key,confirmed_at,source_json,summary,data_json,created_at) VALUES (?,?,?,?,?,?,?,?)",
        ).run(
          parsed.workspaceId,
          parsed.kind,
          parsed.sourceKey,
          parsed.confirmedAt ?? null,
          JSON.stringify(parsed.source),
          parsed.summary,
          parsed.data ? JSON.stringify(parsed.data) : null,
          now().toISOString(),
        );
        if (parsed.phase) tasks.setPhase(parsed.workspaceId, parsed.phase);
        if (parsed.control) tasks.updateControl(parsed.workspaceId, parsed.control);
        changed(parsed.workspaceId);
        return get(parsed.workspaceId, parsed.kind, parsed.sourceKey)!;
      });
    },
    markPublished(
      workspaceId: string,
      kind: TaskArtifactKind,
      sourceKey: string,
      locator: { epoch: string; seq: number },
    ): TaskArtifact {
      const published = TaskArtifactSchema.shape.published.unwrap().parse(locator);
      return db.immediate(() => {
        const artifact = get(workspaceId, kind, sourceKey);
        if (!artifact) throw new TaskCommandError("not_found", "沉淀不存在");
        if (artifact.published) {
          if (JSON.stringify(artifact.published) !== JSON.stringify(published))
            throw new TaskCommandError("conflict", "沉淀已发布到其它群聊位置");
          return artifact;
        }
        db.prepare(
          "UPDATE task_artifact SET published_json = ? WHERE workspace_id = ? AND kind = ? AND source_key = ?",
        ).run(JSON.stringify(published), workspaceId, kind, sourceKey);
        changed(workspaceId);
        return get(workspaceId, kind, sourceKey)!;
      });
    },
  };
}
export type TaskArtifactCommands = ReturnType<typeof createTaskArtifactCommands>;
