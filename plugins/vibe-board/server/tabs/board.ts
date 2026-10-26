import { statSync } from "node:fs";
import { join } from "node:path";
import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import type { PluginBeforeRequests, PluginHookAgent } from "@getpaseo/plugin/server";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { Task, TaskTab } from "../vibe/contract";
import {
  pathInScope,
  subtaskScope,
  SUBTASK_STATUS_LABELS,
  type BoardSubtask,
  type BoardSubtaskInput,
  type VibeStore,
} from "../vibe/db";
import { git } from "./handoff";

// The in-task board (WP-127). Sub-agents of the execution tab share one worktree, so every
// dispatch maps to a claimed subtask; claims refuse unfinished dependencies and overlapping file
// scopes, and completion compares the changes made during the claim with the claimed scope.

/** create_agent label that binds a new sub-agent to a board subtask. */
export const SUBTASK_LABEL = "vibe.subtask";
/** A claimer idle this long (no running turn) may be reclaimed by the executor. */
export const CLAIM_STALE_MS = 30 * 60_000;
/** A claim the executor made for a create_agent call goes back to todo when no sub-agent was
 *  created within this time (the create failed). */
export const PENDING_CLAIM_MS = 60_000;
/** The claim-time git baseline runs inside the create_agent hook; it must stay short. */
export const SNAPSHOT_TIMEOUT_MS = 5_000;
/** Generated or tool-owned files the out-of-scope check never reports. */
export const OUT_OF_SCOPE_IGNORE = [
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/bun.lock",
  "**/bun.lockb",
  "**/Cargo.lock",
  "**/poetry.lock",
  "**/Gemfile.lock",
  "**/composer.lock",
  "**/go.sum",
  "**/*.snap",
  "**/dist/**",
  "**/build/**",
  "**/*.generated.*",
];

/** Claim-time worktree baseline: HEAD and the files already dirty, with size and mtime. */
export interface ScopeSnapshot {
  head: string | null;
  dirty: Record<string, string>;
}
/** What the plugin keeps with a claim. `snapshot` is undefined until taken and null when git
 *  failed; `pendingParent` marks a claim the executor made for a sub-agent not created yet. */
interface ClaimRecord {
  pendingParent?: string;
  snapshot?: ScopeSnapshot | null;
}
export interface SubtaskResult {
  changedFiles: string[];
  outOfScope: string[];
}

function stamp(worktree: string, path: string): string {
  try {
    const stat = statSync(join(worktree, path));
    return `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
  } catch {
    return "gone";
  }
}

/** Paths in `git status --porcelain -z`, including a rename's old path (it follows the entry). */
function porcelainPaths(output: string): string[] {
  const entries = output.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    const [x, y] = [entry[0]!, entry[1]!];
    if ("RC".includes(x) || "RC".includes(y)) {
      const source = entries[++i];
      if (source && (x === "R" || y === "R")) paths.push(source);
    }
  }
  return paths;
}

const GIT = ["-c", "core.quotepath=false"];

/** Null when git failed. */
export async function scopeSnapshot(
  worktree: string,
  timeout = SNAPSHOT_TIMEOUT_MS,
): Promise<ScopeSnapshot | null> {
  const status = await git(worktree, [...GIT, "status", "--porcelain", "-z", "-uall"], timeout);
  if (status === undefined) return null;
  const head = (await git(worktree, [...GIT, "rev-parse", "HEAD"], timeout))?.trim() || null;
  const dirty: Record<string, string> = {};
  for (const path of porcelainPaths(status)) dirty[path] = stamp(worktree, path);
  return { head, dirty };
}

/** Files changed since the snapshot: commits and edits after HEAD, new untracked files, and
 *  files that were already dirty but changed again. Null when git failed. */
export async function changedSince(
  worktree: string,
  snapshot: ScopeSnapshot,
): Promise<string[] | null> {
  const status = await git(worktree, [...GIT, "status", "--porcelain", "-z", "-uall"]);
  if (status === undefined) return null;
  const paths = new Set(porcelainPaths(status));
  if (snapshot.head) {
    const diff = await git(worktree, [
      ...GIT,
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      snapshot.head,
    ]);
    if (diff === undefined) return null;
    for (const path of diff.split("\0")) if (path) paths.add(path);
  }
  return [...paths]
    .filter((path) => snapshot.dirty[path] === undefined || snapshot.dirty[path] !== stamp(worktree, path))
    .sort();
}

function describe(row: BoardSubtask) {
  const result = (row.result ?? null) as Partial<SubtaskResult> | null;
  return {
    id: row.id,
    goal: row.goal,
    status: row.status,
    statusLabel: SUBTASK_STATUS_LABELS[row.status],
    files: row.files,
    readOnly: row.readOnly,
    ignore: row.ignore,
    dependsOn: row.dependsOn,
    acceptance: row.acceptance,
    source: row.source,
    claimedBy: row.claimedBy,
    claimedTab: row.claimedTab,
    claimedAt: row.claimedAt,
    completedAt: row.completedAt,
    summary: row.summary,
    changedFiles: result?.changedFiles ?? [],
    outOfScope: result?.outOfScope ?? [],
  };
}
export type BoardItem = ReturnType<typeof describe>;

function scopeText(row: BoardSubtask): string {
  return row.readOnly ? "只读（不改文件）" : subtaskScope(row.files).join("、");
}

export function boardProgress(rows: readonly BoardSubtask[]): string {
  if (!rows.length) return "看板：暂无子任务";
  const count = (status: BoardSubtask["status"]) => rows.filter((row) => row.status === status).length;
  const running = rows
    .filter((row) => row.status === "in_progress")
    .map((row) => `${row.id}${row.claimedTab ? `（#${row.claimedTab}）` : ""}`);
  return [
    `看板：完成 ${count("done")}/${rows.length}`,
    running.length ? `进行中 ${running.join("、")}` : "",
    count("blocked") ? `受阻 ${count("blocked")}` : "",
  ]
    .filter(Boolean)
    .join("，");
}

export function createTaskBoard(options: {
  store: VibeStore;
  getPaseo(): PaseoApi | null;
  /** The task worktree; the board's git checks run there. */
  directory(workspaceId: string): Promise<string>;
  appendStatus(agentId: string, text: string): Promise<void>;
  now?: () => number;
  staleMs?: number;
  log?: (message: string, error?: unknown) => void;
}) {
  const { store } = options;
  const now = options.now ?? (() => Date.now());
  const staleMs = options.staleMs ?? CLAIM_STALE_MS;
  const log = options.log ?? ((message, error) => console.error("[vibe-board]", message, error ?? ""));
  function paseo(): PaseoApi {
    const api = options.getPaseo();
    if (!api) throw new Error("任务宿主尚未连接");
    return api;
  }
  async function agentOf(agentId: string): Promise<PaseoAgent | undefined> {
    try {
      const handle = paseo().agents.ref(agentId);
      await handle.refresh();
      return handle.current() ?? undefined;
    } catch {
      return undefined;
    }
  }
  const recordOf = (row: BoardSubtask) => (row.claim ?? {}) as ClaimRecord;
  /** Executor-made claims whose sub-agent never appeared go back to todo. */
  function expirePending(workspaceId: string, board: BoardSubtask[]): BoardSubtask[] {
    const expired = board.filter((row) => {
      const parent = recordOf(row).pendingParent;
      return (
        row.status === "in_progress" &&
        !!parent &&
        row.claimedBy === parent &&
        now() - (Date.parse(row.claimedAt ?? "") || 0) >= PENDING_CLAIM_MS
      );
    });
    for (const row of expired)
      store.taskBoard.release(workspaceId, row.id, {
        status: "todo",
        summary: `派发的子代理 ${PENDING_CLAIM_MS / 1000} 秒内没有创建，认领已自动退回`,
      });
    return expired.length ? store.taskBoard.list(workspaceId) : board;
  }
  /** Old tasks confirmed before the board existed get their plan's subtasks on first use. */
  function rows(task: Task): BoardSubtask[] {
    const existing = store.taskBoard.list(task.workspaceId);
    if (existing.length || !task.confirmedAt || !task.plan?.subtasks.length)
      return expirePending(task.workspaceId, existing);
    store.taskBoard.seed(task.workspaceId, task.confirmedAt, task.plan.subtasks);
    return store.taskBoard.list(task.workspaceId);
  }
  /** The caller's task and the task tab it acts for: its own tab, or the tab whose sub-agent
   *  (at any depth) it is. */
  async function caller(agentId: string) {
    let agent = await agentOf(agentId);
    if (!agent?.workspaceId) throw new Error("当前 agent 不属于任务 workspace");
    const task = store.tasks.get(agent.workspaceId);
    if (!task) throw new Error("当前 workspace 不是 Vibe 任务");
    let tab: TaskTab | undefined;
    for (let depth = 0; agent && depth < 5; depth++) {
      tab = task.tabs.find((candidate) => candidate.agentId === agent!.id);
      if (tab) break;
      const parent: string | undefined = agent.labels?.[PARENT_AGENT_ID_LABEL];
      agent = parent ? await agentOf(parent) : undefined;
    }
    return { task, tab, self: tab?.agentId === agentId };
  }
  async function executorCaller(agentId: string) {
    const found = await caller(agentId);
    if (found.tab?.role !== "worker")
      throw new Error("只有执行 tab 与它的子代理可以修改看板；其它 tab 用 vibe_board_list 查看");
    if (!found.task.confirmedAt) throw new Error("任务尚未确认执行，看板还不能使用");
    return { ...found, tab: found.tab };
  }
  /** Status line in the execution tab; a message only while it is mid-turn, so an idle executor
   *  is not woken (and billed) for a warning it can read later. */
  async function notifyExecutor(executorId: string, text: string, sourceAgentId?: string) {
    await options.appendStatus(executorId, text).catch((error) => log("看板状态追加失败", error));
    if (!sourceAgentId || sourceAgentId === executorId) return;
    if (!(await agentOf(executorId))?.activeTurn) return;
    await paseo()
      .agents.ref(executorId)
      .send(text, { sourceAgentId, activeTurnBehavior: "steer" })
      .catch((error) => log("看板告警发送失败", error));
  }
  /** Why a claimer may be reclaimed, or null while it is still active. */
  async function staleReason(row: BoardSubtask): Promise<string | null> {
    if (!row.claimedBy) return "没有认领者";
    const agent = await agentOf(row.claimedBy);
    if (!agent) return "认领者已不存在";
    if (agent.archivedAt) return "认领者已归档";
    if (agent.status === "closed" || agent.status === "error")
      return `认领者状态为 ${agent.status}`;
    if (agent.activeTurn) return null;
    const last = Math.max(
      Date.parse(agent.updatedAt ?? "") || 0,
      Date.parse(row.claimedAt ?? "") || 0,
    );
    const idle = now() - last;
    return idle >= staleMs ? `认领者已 ${Math.round(idle / 60_000)} 分钟无活动` : null;
  }
  /** Claims first, then records the git baseline: a slow or failing git never holds up the claim
   *  (or the create_agent call it runs in); without a baseline the scope check is skipped. */
  async function claimFor(
    task: Task,
    tab: TaskTab,
    id: string,
    claimer: string,
    pendingParent?: string,
  ): Promise<BoardSubtask> {
    rows(task);
    const result = store.taskBoard.claim(task.workspaceId, id, {
      agentId: claimer,
      tabNumber: tab.number,
      claim: (pendingParent ? { pendingParent } : {}) satisfies ClaimRecord,
    });
    if (!result.ok) {
      let message = result.message;
      const holder = result.holder ? store.taskBoard.get(task.workspaceId, result.holder) : undefined;
      const stale = holder ? await staleReason(holder) : null;
      if (stale) message += `。${stale}，执行主代理可用 vibe_board_release 收回 ${holder!.id} 后再认领`;
      throw new Error(message);
    }
    const record = recordOf(result.subtask);
    if (record.snapshot !== undefined || !result.subtask.claimedAt) return result.subtask;
    const directory = await options.directory(task.workspaceId).catch(() => null);
    const snapshot = directory ? await scopeSnapshot(directory) : null;
    store.taskBoard.setClaim(task.workspaceId, id, result.subtask.claimedAt, {
      ...record,
      snapshot,
    } satisfies ClaimRecord);
    return store.taskBoard.get(task.workspaceId, id) ?? result.subtask;
  }
  function subtaskBrief(row: BoardSubtask): string {
    return [
      `你负责任务看板上的子任务 ${row.id}：${row.goal}`,
      `文件范围：${scopeText(row)}`,
      row.dependsOn.length ? `依赖（已完成）：${row.dependsOn.join("、")}` : "",
      row.acceptance ? `验收：${row.acceptance}` : "",
      `完成后调用 vibe_board_complete（id=${row.id}，附改动文件与结论）；放弃或失败调用 vibe_board_release。`,
    ]
      .filter(Boolean)
      .join("\n");
  }
  async function list(callerAgentId: string) {
    const { task, tab } = await caller(callerAgentId);
    const board = rows(task);
    return {
      workspaceId: task.workspaceId,
      phase: task.phase,
      self: { agentId: callerAgentId, tab: tab?.number ?? null },
      progress: boardProgress(board),
      subtasks: board.map(describe),
    };
  }
  async function claim(callerAgentId: string, input: { id: string; assignee?: string }) {
    const { task, tab } = await executorCaller(callerAgentId);
    let claimer = callerAgentId;
    if (input.assignee && input.assignee !== callerAgentId) {
      const assignee = await agentOf(input.assignee);
      if (!assignee || assignee.workspaceId !== task.workspaceId)
        throw new Error("assignee 必须是本任务 workspace 里的子代理");
      claimer = input.assignee;
    }
    const row = await claimFor(task, tab, input.id, claimer);
    return {
      subtask: describe(row),
      message: `已认领 ${row.id}（文件范围 ${scopeText(row)}）。派发子代理时在 create_agent 的 labels 里写 {"${SUBTASK_LABEL}":"${row.id}"}。`,
    };
  }
  async function complete(
    callerAgentId: string,
    input: { id: string; summary: string; changedFiles?: string[] },
  ) {
    const { task, tab, self } = await executorCaller(callerAgentId);
    const row = store.taskBoard.get(task.workspaceId, input.id);
    if (!row) throw new Error(`看板没有子任务 ${input.id}`);
    if (row.status !== "in_progress") throw new Error(`子任务 ${row.id} 不在进行中`);
    // Only the current claimer, or the execution tab itself. A reclaimed agent's parent link no
    // longer authorizes it.
    if (row.claimedBy !== callerAgentId && !self)
      throw new Error(`子任务 ${row.id} 由 ${row.claimedBy ?? "其它 agent"} 认领，只能由认领者或执行主代理完成`);
    const snapshot = recordOf(row).snapshot;
    const changed = snapshot
      ? await changedSince(await options.directory(task.workspaceId), snapshot)
      : null;
    const ignore = [...OUT_OF_SCOPE_IGNORE, ...row.ignore];
    // A shared worktree cannot attribute edits; a file another subtask claimed or finished during
    // this claim is presumed theirs.
    const peers = store.taskBoard
      .list(task.workspaceId)
      .filter(
        (other) =>
          other.id !== row.id &&
          (other.status === "in_progress" ||
            (other.status === "done" && (other.completedAt ?? "") > (row.claimedAt ?? ""))),
      );
    const outside = (path: string) => !pathInScope(path, row.files) && !pathInScope(path, ignore);
    const changedFiles = (changed ?? []).filter((path) => pathInScope(path, row.files));
    const reported = (input.changedFiles ?? []).map((path) => path.trim()).filter(Boolean);
    const outOfScope = [
      ...new Set([
        ...(changed ?? []).filter(
          (path) => outside(path) && !peers.some((peer) => pathInScope(path, peer.files)),
        ),
        ...reported.filter(outside),
      ]),
    ].sort();
    const warning = !outOfScope.length
      ? ""
      : row.readOnly
        ? `只读子任务 ${row.id} 认领期间有文件被写入（推断：不属于其它进行中子任务）：${outOfScope.join("、")}`
        : `子任务 ${row.id} 可能越界（推断：认领期间出现、不在其范围 ${scopeText(row)} 内，也不属于其它进行中子任务）：${outOfScope.join("、")}`;
    const gitNote = changed === null ? "越界比对未执行（git 失败）" : "";
    const summary = [input.summary.trim(), warning, gitNote].filter(Boolean).join("\n");
    const result: SubtaskResult = { changedFiles, outOfScope };
    const done = store.taskBoard.complete(task.workspaceId, row.id, { summary, result });
    if (warning)
      await notifyExecutor(
        tab.agentId,
        `${warning}。请核实这些改动是否属于 ${row.id}；共用 worktree 无法精确归因，这是推断。`,
        callerAgentId,
      );
    return {
      subtask: describe(done),
      outOfScope,
      message:
        [warning, gitNote].filter(Boolean).join("\n") || `已完成 ${row.id}，改动均在范围内。`,
    };
  }
  async function release(
    callerAgentId: string,
    input: { id: string; reason: string; failed?: boolean },
  ) {
    const { task, self } = await executorCaller(callerAgentId);
    const row = store.taskBoard.get(task.workspaceId, input.id);
    if (!row) throw new Error(`看板没有子任务 ${input.id}`);
    if (row.status !== "in_progress") throw new Error(`子任务 ${row.id} 不在进行中，无需退回`);
    let note = input.reason.trim();
    let reclaimed: string | null = null;
    if (row.claimedBy !== callerAgentId) {
      if (!self) throw new Error(`子任务 ${row.id} 由 ${row.claimedBy} 认领，只有认领者或执行主代理能退回`);
      const stale = await staleReason(row);
      if (!stale)
        throw new Error(
          `认领者 ${row.claimedBy} 仍在活动，不能收回 ${row.id}；先用 send_agent_prompt 与它协商，或等它退回`,
        );
      note = `执行主代理收回（${stale}）` + (note ? `：${note}` : "");
      reclaimed = row.claimedBy;
    }
    const released = store.taskBoard.release(task.workspaceId, row.id, {
      status: input.failed ? "blocked" : "todo",
      summary: note,
    });
    // Tell a reclaimed claimer that is still around to stop; a closed one is not reopened.
    const previous = reclaimed ? await agentOf(reclaimed) : undefined;
    if (previous && !previous.archivedAt && previous.status !== "closed" && previous.status !== "error")
      await paseo()
        .agents.ref(previous.id)
        .send(
          `子任务 ${row.id} 已被执行主代理收回（${note}）。请立即停手：不要再修改文件，也不要调用 vibe_board_complete；等待执行主代理安排。`,
          { sourceAgentId: callerAgentId, activeTurnBehavior: "steer" },
        )
        .catch((error) => log("收回停手消息发送失败", error));
    return { subtask: describe(released), message: `${row.id} 已退回为${SUBTASK_STATUS_LABELS[released.status]}。` };
  }
  async function add(callerAgentId: string, input: BoardSubtaskInput) {
    const { task, self } = await executorCaller(callerAgentId);
    rows(task);
    const existing = store.taskBoard.get(task.workspaceId, input.id);
    if (existing?.status === "in_progress" && existing.claimedBy !== callerAgentId && !self)
      throw new Error(`子任务 ${input.id} 由 ${existing.claimedBy} 认领，只有认领者或执行主代理能改范围`);
    const row = store.taskBoard.add(task.workspaceId, input, task.confirmedAt);
    return {
      subtask: describe(row),
      message: existing ? `已更新 ${row.id}。` : `已补登 ${row.id}，可用 vibe_board_claim 认领。`,
    };
  }
  /** create_agent from the execution tab must name a board subtask the tab may hold. Returns the
   *  subtask brief for the sub-agent's system prompt; throws to reject the creation. */
  async function guardCreate(
    request: PluginBeforeRequests["agent.create"],
  ): Promise<string | undefined> {
    const parentId = request.parentAgentId ?? request.labels?.[PARENT_AGENT_ID_LABEL];
    if (!parentId || !request.workspaceId) return undefined;
    const task = store.tasks.get(request.workspaceId);
    const tab = task?.tabs.find((candidate) => candidate.agentId === parentId);
    if (!task || tab?.role !== "worker") return undefined;
    if (!task.confirmedAt) throw new Error("任务尚未确认执行，执行 tab 不能派发子代理");
    const id = request.labels?.[SUBTASK_LABEL]?.trim();
    if (!id)
      throw new Error(
        `派发子代理前必须对应任务看板上的子任务：先用 vibe_board_list 查看、vibe_board_claim 认领（没有合适的先用 vibe_board_add 补登），再在 create_agent 的 labels 里写 {"${SUBTASK_LABEL}":"<子任务 id>"}`,
      );
    const row = rows(task).find((item) => item.id === id);
    if (row?.status === "in_progress" && row.claimedBy === parentId) return subtaskBrief(row);
    return subtaskBrief(await claimFor(task, tab, id, parentId, parentId));
  }
  /** The new sub-agent takes over the claim its parent made for it. When that claim is gone (it
   *  expired before a slow create finished, or was taken), the sub-agent claims the subtask itself;
   *  when that fails too, the execution tab is told the sub-agent runs without a claim. */
  async function agentCreated(agent: PluginHookAgent) {
    const id = agent.labels?.[SUBTASK_LABEL]?.trim();
    if (!id || !agent.parentAgentId || !agent.workspaceId) return;
    const task = store.tasks.get(agent.workspaceId);
    const tab = task?.tabs.find((candidate) => candidate.agentId === agent.parentAgentId);
    if (!task || tab?.role !== "worker") return;
    if (store.taskBoard.assign(task.workspaceId, id, tab.agentId, agent.id)) return;
    try {
      await claimFor(task, tab, id, agent.id);
    } catch (error) {
      await notifyExecutor(
        tab.agentId,
        `子代理 ${agent.id} 已创建，但看板子任务 ${id} 的认领没能交给它：${error instanceof Error ? error.message : String(error)}。它现在没有认领，请用 vibe_board_claim（id=${id}，assignee=${agent.id}）补认领，或让它停手。`,
        agent.id,
      );
    }
  }
  /** The execution tab may message its own sub-agent while that sub-agent holds a claim, while
   *  the claim for it is still being handed over, or after its subtask is done (follow-ups,
   *  corrections, stop requests). Work for a sub-agent with no board relation is refused. */
  async function guardPrompt(request: PluginBeforeRequests["agent.prompt"]) {
    if (!request.workspaceId || request.parentAgentId !== request.callerAgentId) return;
    const task = store.tasks.get(request.workspaceId);
    const tab = task?.tabs.find((candidate) => candidate.agentId === request.callerAgentId);
    if (!task || tab?.role !== "worker") return;
    const board = rows(task);
    if (board.some((row) => row.status === "in_progress" && row.claimedBy === request.agentId)) return;
    const label = (await agentOf(request.agentId))?.labels?.[SUBTASK_LABEL]?.trim();
    const bound = label ? board.find((row) => row.id === label) : undefined;
    if (
      bound &&
      (bound.status === "done" ||
        (bound.status === "in_progress" && bound.claimedBy === request.callerAgentId))
    )
      return;
    throw new Error(
      `子代理 ${request.agentId} 当前没有进行中的看板子任务。交代新工作前先用 vibe_board_claim（id=<子任务 id>，assignee=${request.agentId}）为它认领；看板没有合适的子任务（包括无方案直接授权时）先用 vibe_board_add 补登。依赖未完成或范围冲突时认领会被拒绝`,
    );
  }
  function panel(task: Task): BoardItem[] {
    return rows(task).map(describe);
  }
  return {
    list,
    claim,
    complete,
    release,
    add,
    guardCreate,
    agentCreated,
    guardPrompt,
    panel,
  };
}
export type TaskBoard = ReturnType<typeof createTaskBoard>;
