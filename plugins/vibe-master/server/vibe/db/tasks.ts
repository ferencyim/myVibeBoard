// GENERATED FROM plugins/vibe-shared — DO NOT EDIT (run: node scripts/vibe/sync-shared.mjs)
import { z } from "zod";
import { TaskRoleSnapshotSchema, type TaskRoleSnapshot } from "../contract/model-roles";
import {
  TaskPhaseSchema,
  TaskPlanSchema,
  TaskSchema,
  TaskSubtaskRunSchema,
  parseTaskPlan,
  type Task,
  type TaskPhase,
  type TaskPlan,
  type TaskSubtaskRun,
} from "../contract/task";
import { publishEvent } from "./events";
import { decodeRow } from "./rows";
import type { VibeDb } from "./sqlite";

export class TaskCommandError extends Error {
  constructor(
    readonly code: "not_found" | "invalid" | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "TaskCommandError";
  }
}
export interface ConfirmTaskInput {
  plan?: TaskPlan;
  rolesSnapshot?: TaskRoleSnapshot;
}
export interface SetTaskSubtaskRunInput {
  subtaskId: string;
  state: TaskSubtaskRun["state"];
  agentId?: string | null;
  actualModel?: TaskSubtaskRun["actualModel"];
  continuation?: TaskSubtaskRun["continuation"];
  summary?: string;
}

const TRANSITIONS: Record<TaskPhase, readonly TaskPhase[]> = {
  planning: ["awaiting_confirmation", "paused", "failed"],
  awaiting_confirmation: ["planning", "paused", "failed"],
  queued: ["executing", "paused", "failed"],
  executing: ["reviewing", "verifying", "paused", "failed"],
  reviewing: ["executing", "verifying", "paused", "failed"],
  verifying: ["executing", "awaiting_acceptance", "paused", "failed"],
  awaiting_acceptance: ["executing", "completed", "paused", "failed"],
  completed: ["planning"],
  paused: ["planning", "executing", "reviewing", "verifying", "awaiting_acceptance", "failed"],
  failed: ["planning", "paused"],
};
const CONFIRMED_PHASES = new Set<TaskPhase>([
  "queued",
  "executing",
  "reviewing",
  "verifying",
  "awaiting_acceptance",
  "completed",
]);
const EDITABLE_PHASES = new Set<TaskPhase>([
  "planning",
  "awaiting_confirmation",
  "paused",
  "failed",
  "completed",
]);

/** The only writer of task. Every mutation and its bus notification share one transaction. */
export function createTaskCommands(db: VibeDb, options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());
  const get = (workspaceId: string): Task | undefined => {
    const row = db.prepare("SELECT * FROM task WHERE workspace_id = ?").get(workspaceId);
    return row ? decodeRow(TaskSchema, row) : undefined;
  };
  const requireTask = (workspaceId: string): Task => {
    const task = get(workspaceId);
    if (!task) throw new TaskCommandError("not_found", "任务不存在：" + workspaceId);
    return task;
  };
  const changed = (workspaceId: string, fields: string[]) => {
    publishEvent(db, { type: "task.updated", payload: { workspaceId, fields } }, now);
    return requireTask(workspaceId);
  };
  const assertEditable = (task: Task) => {
    if (
      !EDITABLE_PHASES.has(task.phase) ||
      task.subtaskRuns.some((run) => ["running", "waiting"].includes(run.state))
    )
      throw new TaskCommandError("conflict", "请先停止并暂停当前任务，再替换方案或角色快照");
  };
  return {
    get,
    list(filter: { phase?: TaskPhase } = {}): Task[] {
      const rows = filter.phase
        ? db
            .prepare("SELECT * FROM task WHERE phase = ? ORDER BY confirmed_at, workspace_id")
            .all(TaskPhaseSchema.parse(filter.phase))
        : db.prepare("SELECT * FROM task ORDER BY confirmed_at, workspace_id").all();
      return rows.map((row) => decodeRow(TaskSchema, row));
    },
    create(input: { workspaceId: string; anchorAgentId: string }): Task {
      const parsed = z
        .object({ workspaceId: z.string().trim().min(1), anchorAgentId: z.string().trim().min(1) })
        .strict()
        .parse(input);
      return db.immediate(() => {
        if (get(parsed.workspaceId))
          throw new TaskCommandError("conflict", "该 workspace 已有任务");
        db.prepare(
          "INSERT INTO task (workspace_id, anchor_agent_id, phase, subtask_runs_json, summary) VALUES (?, ?, 'planning', '[]', '')",
        ).run(parsed.workspaceId, parsed.anchorAgentId);
        return changed(parsed.workspaceId, ["created"]);
      });
    },
    setPhase(workspaceId: string, phase: TaskPhase): Task {
      TaskPhaseSchema.parse(phase);
      return db.immediate(() => {
        const task = requireTask(workspaceId);
        if (task.phase === phase) return task;
        if (!TRANSITIONS[task.phase].includes(phase))
          throw new TaskCommandError("conflict", "任务阶段不能从 " + task.phase + " 变为 " + phase);
        if (CONFIRMED_PHASES.has(phase) && (!task.confirmedAt || !task.plan || !task.rolesSnapshot))
          throw new TaskCommandError("invalid", "任务需要有效方案、角色快照和执行确认");
        if (phase === "planning") {
          assertEditable(task);
          db.prepare(
            "UPDATE task SET phase = ?, confirmed_at = NULL, roles_snapshot_json = NULL, subtask_runs_json = '[]' WHERE workspace_id = ?",
          ).run(phase, workspaceId);
          return changed(workspaceId, ["phase", "confirmedAt", "rolesSnapshot", "subtaskRuns"]);
        }
        db.prepare("UPDATE task SET phase = ? WHERE workspace_id = ?").run(phase, workspaceId);
        return changed(workspaceId, ["phase"]);
      });
    },
    savePlan(workspaceId: string, input: TaskPlan): Task {
      const plan = TaskPlanSchema.parse(input);
      return db.immediate(() => {
        assertEditable(requireTask(workspaceId));
        db.prepare(
          "UPDATE task SET plan_json = ?, phase = 'awaiting_confirmation', confirmed_at = NULL, roles_snapshot_json = NULL, subtask_runs_json = '[]' WHERE workspace_id = ?",
        ).run(JSON.stringify(plan), workspaceId);
        return changed(workspaceId, [
          "plan",
          "phase",
          "confirmedAt",
          "rolesSnapshot",
          "subtaskRuns",
        ]);
      });
    },
    savePlanOutput(workspaceId: string, output: string): Task {
      return this.savePlan(workspaceId, parseTaskPlan(output));
    },
    saveRolesSnapshot(workspaceId: string, input: TaskRoleSnapshot): Task {
      const roles = TaskRoleSnapshotSchema.parse(input);
      return db.immediate(() => {
        const task = requireTask(workspaceId);
        assertEditable(task);
        if (task.confirmedAt)
          throw new TaskCommandError("conflict", "已确认角色不可替换；请先回到规划并重新确认");
        db.prepare("UPDATE task SET roles_snapshot_json = ? WHERE workspace_id = ?").run(
          JSON.stringify(roles),
          workspaceId,
        );
        return changed(workspaceId, ["rolesSnapshot"]);
      });
    },
    /** Caller must first verify the source is the anchor's latest completed native output. */
    confirm(workspaceId: string, input: ConfirmTaskInput = {}): Task {
      return db.immediate(() => {
        const task = requireTask(workspaceId);
        if (!["planning", "awaiting_confirmation"].includes(task.phase))
          throw new TaskCommandError("conflict", "只允许规划或待确认任务进入排队，请勿重复确认");
        if (task.subtaskRuns.some((run) => ["running", "waiting"].includes(run.state)))
          throw new TaskCommandError("conflict", "旧子任务仍在运行，请先停止");
        const plan = TaskPlanSchema.safeParse(input.plan ?? task.plan);
        if (!plan.success) throw new TaskCommandError("invalid", "执行确认需要完整有效的方案快照");
        const roles = TaskRoleSnapshotSchema.safeParse(input.rolesSnapshot ?? task.rolesSnapshot);
        if (!roles.success)
          throw new TaskCommandError(
            "invalid",
            "执行确认需要完整角色快照（含 planner、worker、verifier）",
          );
        const result = db
          .prepare(
            "UPDATE task SET phase = 'queued', plan_json = ?, roles_snapshot_json = ?, confirmed_at = ?, subtask_runs_json = '[]' WHERE workspace_id = ? AND phase IN ('planning', 'awaiting_confirmation')",
          )
          .run(
            JSON.stringify(plan.data),
            JSON.stringify(roles.data),
            now().toISOString(),
            workspaceId,
          );
        if (result.changes !== 1)
          throw new TaskCommandError("conflict", "任务阶段已变化，请重新读取");
        return changed(workspaceId, [
          "phase",
          "plan",
          "rolesSnapshot",
          "confirmedAt",
          "subtaskRuns",
        ]);
      });
    },
    setSubtaskRun(workspaceId: string, input: SetTaskSubtaskRunInput): Task {
      return db.immediate(() => {
        const task = requireTask(workspaceId);
        if (
          !task.confirmedAt ||
          !task.rolesSnapshot ||
          !["executing", "reviewing", "verifying", "paused"].includes(task.phase)
        )
          throw new TaskCommandError("conflict", "仅已确认且进入执行的任务可更新子任务运行状态");
        const subtask = task.plan?.subtasks.find((item) => item.id === input.subtaskId);
        if (!subtask) throw new TaskCommandError("invalid", "方案中没有子任务：" + input.subtaskId);
        const previous = task.subtaskRuns.find((run) => run.subtaskId === input.subtaskId);
        const run = TaskSubtaskRunSchema.parse({
          subtaskId: input.subtaskId,
          dependsOn: subtask.dependsOn,
          state: input.state,
          agentId: input.agentId !== undefined ? input.agentId : (previous?.agentId ?? null),
          actualModel:
            input.actualModel !== undefined ? input.actualModel : (previous?.actualModel ?? null),
          continuation:
            input.continuation !== undefined
              ? input.continuation
              : (previous?.continuation ?? null),
          summary: input.summary ?? previous?.summary ?? "",
        });
        const runs = task.subtaskRuns
          .filter((item) => item.subtaskId !== input.subtaskId)
          .concat(run);
        db.prepare("UPDATE task SET subtask_runs_json = ? WHERE workspace_id = ?").run(
          JSON.stringify(runs),
          workspaceId,
        );
        return changed(workspaceId, ["subtaskRuns"]);
      });
    },
    setSummary(workspaceId: string, summary: string): Task {
      z.string().parse(summary);
      return db.immediate(() => {
        requireTask(workspaceId);
        db.prepare("UPDATE task SET summary = ? WHERE workspace_id = ?").run(summary, workspaceId);
        return changed(workspaceId, ["summary"]);
      });
    },
  };
}
export type TaskCommands = ReturnType<typeof createTaskCommands>;
