// GENERATED FROM plugins/vibe-shared — DO NOT EDIT (run: node scripts/vibe/sync-shared.mjs)
import { findOverlap } from "../contract/overlap";
import { subtaskListError } from "../contract/subtasks";
import { publishEvent } from "./events";
import type { VibeDb } from "./sqlite";

// The in-task board (WP-127): a confirmed plan's subtasks, or ones the executor adds, with one
// claim each. All claim rules run inside one immediate transaction, so two agents claiming at the
// same moment cannot both win.

export type SubtaskStatus = "todo" | "in_progress" | "done" | "blocked";
export const SUBTASK_STATUS_LABELS: Record<SubtaskStatus, string> = {
  todo: "待办",
  in_progress: "进行中",
  done: "完成",
  blocked: "受阻",
};

export interface BoardSubtask {
  workspaceId: string;
  id: string;
  position: number;
  confirmedAt: string | null;
  source: "plan" | "agent";
  goal: string;
  files: string[];
  dependsOn: string[];
  acceptance: string;
  /** Changes no files: its claim takes no scope and never conflicts. */
  readOnly: boolean;
  /** Extra globs the out-of-scope check ignores for this subtask. */
  ignore: string[];
  status: SubtaskStatus;
  claimedBy: string | null;
  claimedTab: number | null;
  claimedAt: string | null;
  /** Opaque to the shared layer: the owning plugin's claim-time snapshot (git baseline). */
  claim: unknown;
  completedAt: string | null;
  summary: string;
  /** Opaque to the shared layer: the owning plugin's completion record. */
  result: unknown;
  updatedAt: string;
}

export interface BoardSubtaskInput {
  id: string;
  goal: string;
  files: readonly string[];
  dependsOn: readonly string[];
  acceptance?: string;
  readOnly?: boolean;
  ignore?: readonly string[];
}

export type ClaimRejection =
  | "not_found"
  | "done"
  | "claimed"
  | "blocked_by"
  | "overlap"
  | "no_scope";
export type ClaimResult =
  | { ok: true; subtask: BoardSubtask }
  /** `holder`: the in-progress subtask whose claim stands in the way (claimed, overlap). */
  | { ok: false; code: ClaimRejection; message: string; holder?: string };

/** The declared file globs. Empty means no scope: read-only, or not declared yet. A sole writer of
 *  the whole repository must say "**" explicitly. */
export function subtaskScope(files: readonly string[]): string[] {
  return files.map((file) => file.trim()).filter(Boolean);
}

/** Why a subtask cannot be claimed with its declared scope, or null. */
export function scopeError(input: {
  id: string;
  files: readonly string[];
  readOnly?: boolean;
}): string | null {
  if (input.readOnly || subtaskScope(input.files).length) return null;
  return `子任务 ${input.id} 没有声明文件范围：用 vibe_board_add 写明 files（整仓单写者显式写 "**"），只读调研或审查子任务声明 readOnly: true`;
}

/** Is this path inside the scope? */
export function pathInScope(path: string, files: readonly string[]): boolean {
  return findOverlap([path], subtaskScope(files)) !== null;
}

function who(row: BoardSubtask): string {
  return `${row.claimedTab ? `#${row.claimedTab} 的 ` : ""}${row.claimedBy ?? "未知 agent"}`;
}

type Row = {
  workspace_id: string;
  subtask_id: string;
  position: number;
  confirmed_at: string | null;
  source: "plan" | "agent";
  goal: string;
  files_json: string;
  depends_on_json: string;
  acceptance: string;
  read_only: number;
  ignore_json: string;
  status: SubtaskStatus;
  claimed_by: string | null;
  claimed_tab: number | null;
  claimed_at: string | null;
  claim_json: string | null;
  completed_at: string | null;
  summary: string;
  result_json: string | null;
  updated_at: string;
};

const decode = (row: Row): BoardSubtask => ({
  workspaceId: row.workspace_id,
  id: row.subtask_id,
  position: row.position,
  confirmedAt: row.confirmed_at,
  source: row.source,
  goal: row.goal,
  files: JSON.parse(row.files_json) as string[],
  dependsOn: JSON.parse(row.depends_on_json) as string[],
  acceptance: row.acceptance,
  readOnly: row.read_only === 1,
  ignore: JSON.parse(row.ignore_json) as string[],
  status: row.status,
  claimedBy: row.claimed_by,
  claimedTab: row.claimed_tab,
  claimedAt: row.claimed_at,
  claim: row.claim_json ? (JSON.parse(row.claim_json) as unknown) : null,
  completedAt: row.completed_at,
  summary: row.summary,
  result: row.result_json ? (JSON.parse(row.result_json) as unknown) : null,
  updatedAt: row.updated_at,
});

export function createTaskBoardCommands(db: VibeDb, options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());
  const stamp = () => now().toISOString();
  const changed = (workspaceId: string) =>
    publishEvent(db, { type: "task.updated", payload: { workspaceId, fields: ["board"] } }, now);
  function list(workspaceId: string): BoardSubtask[] {
    return db
      .prepare<Row>("SELECT * FROM task_subtask WHERE workspace_id = ? ORDER BY position, subtask_id")
      .all(workspaceId)
      .map(decode);
  }
  function get(workspaceId: string, id: string): BoardSubtask | undefined {
    const row = db
      .prepare<Row>("SELECT * FROM task_subtask WHERE workspace_id = ? AND subtask_id = ?")
      .get(workspaceId, id);
    return row ? decode(row) : undefined;
  }
  function insert(
    workspaceId: string,
    input: BoardSubtaskInput,
    position: number,
    confirmedAt: string | null,
    source: "plan" | "agent",
  ) {
    db.prepare(
      `INSERT INTO task_subtask (workspace_id, subtask_id, position, confirmed_at, source, goal,
         files_json, depends_on_json, acceptance, read_only, ignore_json, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'todo', ?)`,
    ).run(
      workspaceId,
      input.id,
      position,
      confirmedAt,
      source,
      input.goal,
      JSON.stringify(input.files),
      JSON.stringify(input.dependsOn),
      input.acceptance ?? "",
      input.readOnly ? 1 : 0,
      JSON.stringify(input.ignore ?? []),
      stamp(),
    );
  }
  /** The first other in-progress writer whose scope overlaps `files`, with the overlapping pair. */
  function overlapping(board: readonly BoardSubtask[], id: string, files: readonly string[]) {
    for (const other of board) {
      if (other.id === id || other.status !== "in_progress" || other.readOnly) continue;
      const pair = findOverlap(subtaskScope(files), subtaskScope(other.files));
      if (pair) return { other, pair };
    }
    return null;
  }
  /** Why `row` cannot be claimed now, or null. Reads the board inside the caller's transaction. */
  function claimBlock(row: BoardSubtask, board: readonly BoardSubtask[], agentId: string) {
    if (row.status === "done")
      return { code: "done" as const, message: `子任务 ${row.id} 已完成，不能再认领` };
    if (row.status === "in_progress" && row.claimedBy !== agentId)
      return {
        code: "claimed" as const,
        message: `子任务 ${row.id} 已被 ${who(row)} 认领（${row.claimedAt ?? "时间未知"}）`,
        holder: row.id,
      };
    const blockers = row.dependsOn
      .map((dep) => board.find((item) => item.id === dep))
      .filter((dep): dep is BoardSubtask => !!dep && dep.status !== "done");
    if (blockers.length)
      return {
        code: "blocked_by" as const,
        message: `子任务 ${row.id} 依赖的 ${blockers
          .map(
            (dep) =>
              `${dep.id}（${SUBTASK_STATUS_LABELS[dep.status]}${dep.status === "in_progress" ? `，${who(dep)}` : ""}）`,
          )
          .join("、")} 尚未完成`,
      };
    const noScope = scopeError(row);
    if (noScope) return { code: "no_scope" as const, message: noScope };
    // A read-only claim takes no scope: it neither waits for writers nor blocks them.
    const hit = row.readOnly ? null : overlapping(board, row.id, row.files);
    if (hit)
      return {
        code: "overlap" as const,
        message: `子任务 ${row.id} 的文件范围「${hit.pair[0]}」与进行中的 ${hit.other.id}（${who(hit.other)}）的「${hit.pair[1]}」重叠；等它完成后再认领，或先协商调整范围`,
        holder: hit.other.id,
      };
    return null;
  }
  return {
    list,
    get,
    /** A confirmation replaces the board with the confirmed plan's subtasks. A replay of the same
     *  confirmation (the board already belongs to `confirmedAt`) changes nothing. A new round keeps
     *  each running subtask the new plan does not reuse, as blocked, and returns every running claim
     *  it ended so the caller can tell those claimers to stop. */
    seed(
      workspaceId: string,
      confirmedAt: string | null,
      subtasks: readonly BoardSubtaskInput[],
    ): { seeded: boolean; displaced: BoardSubtask[] } {
      const result = db.immediate(() => {
        const previous = list(workspaceId);
        if (confirmedAt && previous.some((row) => row.confirmedAt === confirmedAt))
          return { seeded: false, displaced: [] };
        const displaced = previous.filter((row) => row.status === "in_progress");
        db.prepare("DELETE FROM task_subtask WHERE workspace_id = ?").run(workspaceId);
        subtasks.forEach((subtask, index) => insert(workspaceId, subtask, index, confirmedAt, "plan"));
        const reused = new Set(subtasks.map((subtask) => subtask.id));
        let position = subtasks.length;
        for (const row of displaced) {
          if (reused.has(row.id)) continue;
          insert(workspaceId, { ...row, dependsOn: [] }, position++, row.confirmedAt, row.source);
          db.prepare(
            "UPDATE task_subtask SET status = 'blocked', summary = ? WHERE workspace_id = ? AND subtask_id = ?",
          ).run(`方案已重新确认，${who(row)} 的认领已中止；等待执行主代理重新安排`, workspaceId, row.id);
        }
        return { seeded: true, displaced };
      });
      if (result.seeded) changed(workspaceId);
      return result;
    },
    /** Adds a subtask, or changes the goal/files/dependencies of one that is not done. */
    add(workspaceId: string, input: BoardSubtaskInput, confirmedAt: string | null): BoardSubtask {
      const result = db.immediate(() => {
        const board = list(workspaceId);
        const existing = board.find((item) => item.id === input.id);
        if (existing?.status === "done") throw new Error(`子任务 ${input.id} 已完成，不能修改`);
        const noScope = scopeError(input);
        if (noScope) throw new Error(noScope);
        const graph = board.map((item) =>
          item.id === input.id ? { id: item.id, dependsOn: input.dependsOn } : item,
        );
        if (!existing) graph.push({ id: input.id, dependsOn: input.dependsOn });
        const error = subtaskListError(graph);
        if (error) throw new Error(error);
        if (!existing) {
          insert(workspaceId, input, board.length, confirmedAt, "agent");
          return get(workspaceId, input.id)!;
        }
        const hit =
          existing.status === "in_progress" && !input.readOnly
            ? overlapping(board, existing.id, input.files)
            : null;
        if (hit)
          throw new Error(
            `新范围「${hit.pair[0]}」与进行中的 ${hit.other.id}（${who(hit.other)}）的「${hit.pair[1]}」重叠`,
          );
        db.prepare(
          `UPDATE task_subtask SET goal = ?, files_json = ?, depends_on_json = ?, acceptance = ?,
             read_only = ?, ignore_json = ?, updated_at = ? WHERE workspace_id = ? AND subtask_id = ?`,
        ).run(
          input.goal,
          JSON.stringify(input.files),
          JSON.stringify(input.dependsOn),
          input.acceptance ?? existing.acceptance,
          input.readOnly ? 1 : 0,
          JSON.stringify(input.ignore ?? existing.ignore),
          stamp(),
          workspaceId,
          input.id,
        );
        return get(workspaceId, input.id)!;
      });
      changed(workspaceId);
      return result;
    },
    claim(
      workspaceId: string,
      id: string,
      claimer: { agentId: string; tabNumber: number | null; claim?: unknown },
    ): ClaimResult {
      const result = db.immediate((): ClaimResult => {
        const board = list(workspaceId);
        const row = board.find((item) => item.id === id);
        if (!row)
          return {
            ok: false,
            code: "not_found",
            message: `看板没有子任务 ${id}；先用 vibe_board_list 查看，或用 vibe_board_add 补登`,
          };
        const block = claimBlock(row, board, claimer.agentId);
        if (block) return { ok: false, ...block };
        if (row.status === "in_progress") return { ok: true, subtask: row };
        const at = stamp();
        db.prepare(
          `UPDATE task_subtask SET status = 'in_progress', claimed_by = ?, claimed_tab = ?,
             claimed_at = ?, claim_json = ?, completed_at = NULL, result_json = NULL, updated_at = ?
           WHERE workspace_id = ? AND subtask_id = ?`,
        ).run(
          claimer.agentId,
          claimer.tabNumber,
          at,
          claimer.claim === undefined ? null : JSON.stringify(claimer.claim),
          at,
          workspaceId,
          id,
        );
        return { ok: true, subtask: get(workspaceId, id)! };
      });
      if (result.ok) changed(workspaceId);
      return result;
    },
    /** Hands a claim from the agent that took it to the sub-agent it dispatched. */
    assign(workspaceId: string, id: string, from: string, to: string): boolean {
      const info = db
        .prepare(
          `UPDATE task_subtask SET claimed_by = ?, updated_at = ?
           WHERE workspace_id = ? AND subtask_id = ? AND status = 'in_progress' AND claimed_by = ?`,
        )
        .run(to, stamp(), workspaceId, id, from);
      if (info.changes) changed(workspaceId);
      return info.changes > 0;
    },
    /** Replaces the plugin's claim record while the claim made at `claimedAt` still stands (it
     *  may have been handed to another agent meanwhile). */
    setClaim(workspaceId: string, id: string, claimedAt: string, claim: unknown): boolean {
      const info = db
        .prepare(
          `UPDATE task_subtask SET claim_json = ?, updated_at = ?
           WHERE workspace_id = ? AND subtask_id = ? AND status = 'in_progress' AND claimed_at = ?`,
        )
        .run(JSON.stringify(claim), stamp(), workspaceId, id, claimedAt);
      return info.changes > 0;
    },
    complete(workspaceId: string, id: string, input: { summary: string; result?: unknown }) {
      const at = stamp();
      const info = db
        .prepare(
          `UPDATE task_subtask SET status = 'done', completed_at = ?, summary = ?, result_json = ?,
             updated_at = ? WHERE workspace_id = ? AND subtask_id = ? AND status = 'in_progress'`,
        )
        .run(
          at,
          input.summary,
          input.result === undefined ? null : JSON.stringify(input.result),
          at,
          workspaceId,
          id,
        );
      if (!info.changes) throw new Error(`子任务 ${id} 不在进行中，不能完成`);
      changed(workspaceId);
      return get(workspaceId, id)!;
    },
    /** Gives a claim back: todo when abandoned, blocked when it failed. */
    release(
      workspaceId: string,
      id: string,
      input: { status: "todo" | "blocked"; summary: string },
    ) {
      const info = db
        .prepare(
          `UPDATE task_subtask SET status = ?, summary = ?, claimed_by = NULL, claimed_tab = NULL,
             claimed_at = NULL, claim_json = NULL, updated_at = ?
           WHERE workspace_id = ? AND subtask_id = ? AND status = 'in_progress'`,
        )
        .run(input.status, input.summary, stamp(), workspaceId, id);
      if (!info.changes) throw new Error(`子任务 ${id} 不在进行中，无需退回`);
      changed(workspaceId);
      return get(workspaceId, id)!;
    },
  };
}
export type TaskBoardCommands = ReturnType<typeof createTaskBoardCommands>;
