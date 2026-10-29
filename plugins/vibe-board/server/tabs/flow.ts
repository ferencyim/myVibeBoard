import { PROJECT_COMPLETION_PROMPT } from "../project-agent/completion-prompt";
import { PROJECT_AGENT_PROMPT } from "../project-agent/prompts";
import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { PaseoAgent, PaseoApi, PaseoAgentHandle } from "@getpaseo/client";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import {
  TaskRoleSnapshotSchema,
  mainFallbackSnapshot,
  TASK_PHASE_LABELS,
  TASK_TAB_PRESET_LABEL,
  TASK_TAB_ROLE_LABEL,
  TASK_TAB_ROLE_LABELS,
  UNRESOLVED_TAB_MODEL,
  findTaskActualPreset,
  freezeTaskSubtaskPresets,
  parseTaskPlan,
  presetModeId,
  taskRoleModeId,
  TaskPlanSchema,
  validateTaskSubtaskPresets,
  TASK_PLAN_PROMPT,
  type Task,
  type TaskArtifact,
  type TaskPlan,
  type TaskPlanSource,
  type TaskPresetSnapshot,
  type TaskPhase,
  type TaskRoleSnapshot,
  type TaskTab,
} from "../vibe/contract";
import {
  createTaskRuntimeCommands,
  readResourceBriefing,
  publishEvent,
  type BoardSubtask,
  type VibeDb,
  type VibeStore,
} from "../vibe/db";
import { createTaskResources, type TaskTurnToken } from "../task-host/resources";
import { createTaskGitFinalizer, type GitState } from "../task-conversation/git";
import { TASK_FLOW_PROMPTS } from "../task-conversation/prompts";
import {
  HISTORY_NOTICE_PROMPT,
  PLAN_REVIEW_REQUEST_PROMPT,
  PLAN_REVIEW_REVISE_PROMPT,
  SCOUT_ASK_PROMPT,
  TASK_TAB_GUIDE_PROMPT,
} from "./prompts";
import { createPlanReview, reviewActive, reviewState } from "./plan-review";
import type { PluginTurnOutcome } from "@getpaseo/plugin/server";
import type { GroupChat } from "./group-chat";
import {
  HandoffPacketSchema,
  buildPacket,
  captureCheckpoint,
  checkpointDrift,
  renderHandoff,
  type HandoffPacket,
} from "./handoff";
import { TASK_HOST_PROMPTS } from "../task-host/prompts";
import {
  FLOW_ROLE_ORDER,
  HANDOFF_PATTERN,
  roleTabPreset,
  roleTabDisabled,
  roleVars,
  tabTitle,
  TaskWorkspaceUnavailableError,
  type FlowRole,
  type TaskTabs,
} from "./service";

type Admission = {
  workspaceId: string;
  confirmedAt: string;
  reservationId: string;
  presetId: string;
  provider: string;
  model: string;
};

interface TimelineEntry {
  item: AgentTimelineItem;
  turnId?: string | null;
  seqEnd: number;
}
interface TimelinePage {
  epoch: string;
  entries: TimelineEntry[];
}

const DELIVERY = /^```vibe-delivery[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/m;
const BUSY_ROLES = new Set(["worker", "subagent", "reviewer", "verifier"]);
const HANDOFF_NUMBER = /#\s*(\d+)/;

function handoffTarget(reason: string | undefined): number | undefined {
  if (!reason) return undefined;
  const match = HANDOFF_NUMBER.exec(reason) ?? /^\s*(\d+)\s*$/.exec(reason);
  return match ? Number(match[1]) : undefined;
}
function naturalHandoffTarget(text: string): number | undefined {
  const match = HANDOFF_PATTERN.exec(text);
  return match ? Number(match[1] ?? match[2]) : undefined;
}
const ROLE_PROMPT_KEYS: Partial<Record<TaskTab["role"], string>> = {
  main: "task.role.main",
  planner: "task.role.planner",
  scout: "task.role.scout",
  plan_reviewer: "task.role.plan_reviewer",
  worker: "board.task.work",
  reviewer: "verify.reviewer_system",
  verifier: "verify.verifier_system",
};
function rolePromptKey(role: TaskTab["role"]): string | undefined {
  return ROLE_PROMPT_KEYS[role];
}

function parseDelivery(
  text: string,
): { status: "completed" | "blocked"; summary: string } | undefined {
  const match = DELIVERY.exec(text);
  if (!match) return undefined;
  try {
    const value = JSON.parse(match[1]!) as { status?: unknown; summary?: unknown };
    if (value.status !== "completed" && value.status !== "blocked") return undefined;
    return { status: value.status, summary: String(value.summary ?? "") };
  } catch {
    return undefined;
  }
}
function headCommit(cwd: string): Promise<string | undefined> {
  return new Promise((done) => {
    execFile(
      "git",
      ["rev-parse", "HEAD"],
      { cwd, windowsHide: true, timeout: 30_000 },
      (error, stdout) => done(error ? undefined : String(stdout).trim() || undefined),
    );
  });
}
function sourceFor(tab: TaskTab, page: TimelinePage, entry: TimelineEntry): TaskPlanSource {
  return {
    tabNumber: tab.number,
    agentId: tab.agentId,
    sourceKey: `tab:${tab.number}:${page.epoch}:${entry.seqEnd}`,
    epoch: page.epoch,
    seq: entry.seqEnd,
    memberId: tab.agentId,
    backendAgentId: tab.agentId,
    ...(entry.item.type === "assistant_message" && entry.item.messageId
      ? { messageId: entry.item.messageId }
      : {}),
  };
}

const PREBUILT_ROLES = FLOW_ROLE_ORDER;
type PrebuiltRole = FlowRole;
/** Nonterminal tasks keep their complete flow available, including while paused. */
const PROVISION_PHASES = new Set<TaskPhase>([
  "paused",
  "planning",
  "awaiting_confirmation",
  "queued",
  "executing",
  "reviewing",
  "verifying",
  "awaiting_acceptance",
]);
const DIRECT_NO_PLAN = "无方案，按用户在执行 tab 的指示执行";

/** A user message in the execution tab without a complete plan is itself the task description. */
function directPlan(text: string): TaskPlan {
  return TaskPlanSchema.parse({
    goal: text.replace(/\s+/g, " ").trim().slice(0, 200),
    approach: `${DIRECT_NO_PLAN}。用户消息：\n${text.trim().slice(0, 4_000)}`,
    files: ["**"],
    subtasks: [],
    checks: [{ text: "结果符合用户在执行 tab 的指示", method: "用户核对执行交付与验证结果" }],
  });
}

/** Freeze a pre-created tab's actual model into the confirmation snapshot so the scheduler,
 *  worker reuse and verify reuse all pick the model that tab already runs. */
function snapshotForTab(tab: TaskTab, base: TaskPresetSnapshot | null): TaskPresetSnapshot {
  const index = base?.models.findIndex(
    (model) => model.provider === tab.provider && model.model === tab.model,
  );
  if (base && index !== undefined && index >= 0) {
    if (index === 0) return base;
    return {
      ...base,
      models: [base.models[index]!, ...base.models.filter((_, at) => at !== index)],
    };
  }
  return {
    presetId: base?.presetId ?? tab.presetId ?? "task-tab-native",
    source: base?.source ?? "task",
    models: [
      {
        provider: tab.provider,
        model: tab.model,
        thinking: tab.thinking ?? "",
        // Same source as the role's preset; only a task without any snapshot falls back.
        permissionMode: base?.models[0]?.permissionMode ?? "full",
      },
    ],
    environmentKind: base?.environmentKind ?? "project-default",
    runtimeEnv: base?.runtimeEnv ?? null,
    instructions: base?.instructions ?? "",
  };
}

/** Existing role tabs win over later default edits: freeze their model at confirmation. */
function alignRolesToTabs(roles: TaskRoleSnapshot, tabs: readonly TaskTab[]): TaskRoleSnapshot {
  const aligned = { ...roles };
  for (const role of PREBUILT_ROLES) {
    const base = aligned[role];
    if (base === null) continue;
    const tab = [...tabs]
      .reverse()
      .find(
        (candidate) =>
          candidate.role === role && candidate.model && candidate.model !== UNRESOLVED_TAB_MODEL,
      );
    if (tab) aligned[role] = snapshotForTab(tab, base);
  }
  if (aligned.worker !== roles.worker) aligned.subagent = { ...aligned.worker, source: "worker" };
  return TaskRoleSnapshotSchema.parse(aligned);
}

export function createTaskFlow(options: {
  db: VibeDb;
  store: VibeStore;
  tabs: TaskTabs;
  getPaseo(): PaseoApi | null;
  git?: Pick<ReturnType<typeof createTaskGitFinalizer>, "finalize">;
  log?: (message: string, error?: unknown) => void;
  /** Per plan reviewer timeout (owner setting); default 20 minutes. */
  reviewTimeoutMs?: () => number;
  now?: () => number;
  /** #1 progress rows (WP-131). */
  progress: Pick<GroupChat, "report" | "tabTurnEnded">;
}) {
  const { db, store, tabs } = options;
  const log =
    options.log ?? ((message, error) => console.error("[vibe-board]", message, error ?? ""));
  const git = options.git ?? createTaskGitFinalizer();
  const resources = createTaskResources(db);
  const runtime = createTaskRuntimeCommands(db);
  const accepting = new Map<string, { cancelled: boolean }>();
  // Pre-created tabs whose registration failed, keyed by workspace and role (see provisionTabsNow).
  const orphanTabs = new Map<string, { agentId: string; presetId: string }>();
  const provisioning = new Map<string, Promise<void>>();
  const provisionFailures = new Map<string, { attempts: number; retryAt: number; loggedAt: number }>();
  const now = options.now ?? Date.now;
  function canProvision(key: string) {
    const failure = provisionFailures.get(key);
    return !failure || now() >= failure.retryAt;
  }
  function provisionFailed(key: string, error: unknown) {
    const previous = provisionFailures.get(key);
    if (previous?.retryAt === Infinity) return;
    const permanent = error instanceof TaskWorkspaceUnavailableError;
    const at = now();
    const attempts = (previous?.attempts ?? 0) + 1;
    const shouldLog = permanent || !previous || at - previous.loggedAt >= 5 * 60_000;
    provisionFailures.set(key, {
      attempts,
      retryAt: permanent ? Infinity : at + Math.min(30 * 60_000, 60_000 * 2 ** Math.min(attempts - 1, 5)),
      loggedAt: shouldLog ? at : (previous?.loggedAt ?? at),
    });
    if (shouldLog)
      log(permanent ? `流程 tab 预建停止：${error.message}` : "流程 tab 预建暂缓：稍后退避重试");
  }
  const serial = new Map<string, Promise<unknown>>();

  function paseo(): PaseoApi {
    const api = options.getPaseo();
    if (!api) throw new Error("任务宿主尚未连接");
    return api;
  }
  function requireTask(workspaceId: string): Task {
    const task = store.tasks.get(workspaceId);
    if (!task) throw new Error("当前 workspace 不是 Vibe 任务");
    return task;
  }
  /** A finished tab releases its slot; a still-running agent keeps the lease and freezes. */
  async function releaseIdle(workspaceId: string, agentId: string, turn?: TaskTurnToken) {
    // A turn that ran under an older lease generation must not release a newer admission.
    if (turn && !turn.isCurrent()) return;
    try {
      const handle = paseo().agents.ref(agentId);
      await handle.refresh();
      const agent = handle.current();
      if (!agent || agent.activeTurn || !["idle", "error", "closed"].includes(agent.status)) return;
      if (turn) await turn.release();
      else await resources.releaseAgent(workspaceId, agentId);
    } catch (error) {
      log("执行 tab 资源释放未确认", error);
    }
  }
  function queue<T>(workspaceId: string, action: () => Promise<T>): Promise<T> {
    const previous = serial.get(workspaceId) ?? Promise.resolve();
    const current = previous.then(action, action);
    const tail = current.finally(() => {
      if (serial.get(workspaceId) === tail) serial.delete(workspaceId);
    });
    // The caller owns `current`; the queue tail must never surface its rejection as unhandled.
    void tail.catch(() => {});
    serial.set(workspaceId, tail);
    return current;
  }
  async function waitStopped(handle: PaseoAgentHandle, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await handle.refresh();
      const agent = handle.current();
      if (!agent || !agent.activeTurn) return;
      if (Date.now() >= deadline) throw new Error("原生会话停止未确认，保留资源");
      await delay(250);
    }
  }
  async function timeline(agentId: string, limit = 120): Promise<TimelinePage> {
    const handle = paseo().agents.ref(agentId);
    await handle.refresh();
    const page = await handle.timeline.refetch({ direction: "tail", limit });
    const entries = (page.entries ?? []) as unknown as TimelineEntry[];
    return { epoch: page.epoch, entries };
  }
  function turnEntries(page: TimelinePage, turnId: string | null, type: AgentTimelineItem["type"]) {
    const matching = page.entries.filter(
      (entry) => entry.item.type === type && (!turnId || entry.turnId === turnId),
    );
    return matching.length || turnId
      ? matching
      : page.entries.filter((entry) => entry.item.type === type);
  }
  function lastAssistant(page: TimelinePage, turnId: string | null) {
    const entries = turnEntries(page, turnId, "assistant_message");
    return entries.at(-1);
  }
  function planMessage(page: TimelinePage) {
    for (const entry of [...page.entries].reverse()) {
      if (entry.item.type !== "assistant_message") continue;
      try {
        return { plan: parseTaskPlan(entry.item.text), entry };
      } catch {
        /* Not every reply carries a plan fence. */
      }
    }
    return undefined;
  }
  function tabFor(task: Task, agentId: string) {
    return task.tabs.find((tab) => tab.agentId === agentId);
  }
  function anchorTab(task: Task) {
    return tabFor(task, task.anchorAgentId) ?? task.tabs[0];
  }
  /** The tab that writes plans: the latest 方案 tab (a task from before round 8 may not have one yet). */
  function plannerTab(task: Task) {
    return [...task.tabs].reverse().find((tab) => tab.role === "planner");
  }
  /** Where a confirmation looks for the latest complete plan: the user's tab, #2, then #1. */
  function planCandidates(task: Task, tab: TaskTab): TaskTab[] {
    const list = [tab, plannerTab(task), anchorTab(task)].filter(
      (candidate): candidate is TaskTab => !!candidate,
    );
    return list.filter(
      (candidate, index) =>
        list.findIndex((other) => other.agentId === candidate.agentId) === index,
    );
  }
  const review = createPlanReview({
    store,
    tabs,
    report: options.progress.report,
    getPaseo: options.getPaseo,
    turnOutput: async (agentId, turnId) => {
      const entry = lastAssistant(await timeline(agentId), turnId);
      return entry?.item.type === "assistant_message" ? entry.item.text : "";
    },
    projectId: async (workspaceId) => {
      try {
        return (await tabs.workspace(workspaceId)).projectId ?? null;
      } catch {
        return null;
      }
    },
    log,
    ...(options.reviewTimeoutMs ? { timeoutMs: options.reviewTimeoutMs } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  /** Settle review cycles whose events were missed (plugin start, periodic sweep, task turns). */
  async function recoverReviews(workspaceId?: string) {
    const ids = workspaceId
      ? [workspaceId]
      : store.tasks
          .list()
          .filter((task) => reviewActive(task))
          .map((task) => task.workspaceId);
    for (const id of ids)
      await queue(id, () => review.recover(id)).catch((error) => log("方案审阅恢复失败", error));
  }
  /** agent.closed / agent.archived: a running plan reviewer counts as failed. */
  async function reviewerGone(
    agent: { id: string; workspaceId: string | null },
    how: "closed" | "archived",
  ) {
    const workspaceId = agent.workspaceId;
    if (!workspaceId || !review.isReviewer(store.tasks.get(workspaceId), agent.id)) return;
    await queue(workspaceId, () => review.reviewerGone(workspaceId, agent.id, how));
  }
  /** /重新审阅 (only from the user's composer or the panel, in #1 or the 方案 tab): review the
   *  方案 tab's latest plan again. */
  function rereview(input: { workspaceId: string; agentId: string }) {
    return queue(input.workspaceId, async () => {
      const task = requireTask(input.workspaceId);
      const caller = tabFor(task, input.agentId);
      if (!caller || (caller.role !== "main" && caller.role !== "planner"))
        throw new Error("请在主会话或方案 tab（或任务流程面板）发送 /重新审阅");
      const planner = plannerTab(task);
      if (!planner) throw new Error("本任务还没有方案 tab");
      const page = await timeline(planner.agentId);
      const found = planMessage(page);
      if (!found) throw new Error(`#${planner.number} 方案还没有输出完整方案`);
      const result = await review.restart(task, planner, {
        plan: found.plan,
        text: found.entry.item.type === "assistant_message" ? found.entry.item.text : "",
        source: sourceFor(planner, page, found.entry),
      });
      return { task: requireTask(input.workspaceId), message: result.message };
    });
  }
  async function projectFor(workspaceId: string) {
    const placement = await tabs.workspace(workspaceId);
    const project = placement.projectId ? store.projectConfigs.get(placement.projectId) : undefined;
    if (!placement.directory || !placement.projectId || !project)
      throw new Error("找不到任务工作区或项目 Git 路径");
    return { placement, project, directory: placement.directory, projectId: placement.projectId };
  }
  async function rolesFor(task: Task, _tab: TaskTab): Promise<TaskRoleSnapshot> {
    const { projectId } = await projectFor(task.workspaceId);
    const resolved = store.modelDefaults.resolveTask(
      task.roleSelections ?? {},
      projectId,
      task.tabs.find((candidate) => candidate.role === "main"),
    );
    const main = task.tabs.find((candidate) => candidate.role === "main");
    const enabled = task.control?.enabledRoles;
    if (main && Array.isArray(enabled)) {
      for (const role of ["scout", "reviewer"] as const)
        if (enabled.includes(role) && !resolved[role]) resolved[role] = mainFallbackSnapshot(main);
    }
    return resolved;
  }
  async function execute(input: {
    workspaceId: string;
    agentId: string;
    requestId: string;
    reason?: string;
  }) {
    // An explicit user command: a task created before role tabs existed gets them first, so the
    // confirmation freezes the execution tab's model (provisioning runs ahead in the same queue).
    void provisionTabs(input.workspaceId).catch((error) => log("流程 tab 预建失败", error));
    return queue(input.workspaceId, async () => {
      let task = requireTask(input.workspaceId);
      if (!["planning", "awaiting_confirmation"].includes(task.phase))
        throw new Error("当前阶段不能确认执行；请先在主会话修改方案");
      const tab = tabFor(task, input.agentId) ?? anchorTab(task);
      if (!tab) throw new Error("任务还没有主会话 tab");
      const candidates = planCandidates(task, tab);
      let located:
        | { plan: TaskPlan; entry: TimelineEntry; page: TimelinePage; sourceTab: TaskTab }
        | undefined;
      for (const candidate of candidates) {
        const page = await timeline(candidate.agentId);
        const found = planMessage(page);
        if (found) {
          located = { ...found, page, sourceTab: candidate };
          break;
        }
      }
      if (!located) throw new Error("还没有完整方案，请让 #2 方案输出 vibe-plan 方案");
      task = store.tasks.savePlan(input.workspaceId, located.plan);
      const reason = input.reason?.trim();
      if (reason) store.tasks.updateControl(input.workspaceId, { executionReason: reason });
      return confirmWith(
        task,
        located.plan,
        sourceFor(located.sourceTab, located.page, located.entry),
        input.requestId,
        tab,
      );
    });
  }
  /** A new round ends the previous round's running claims; their sub-agents are told to stop.
   *  Task tabs get the new plan anyway, and closed agents are not reopened. */
  async function stopDisplacedClaimers(
    task: Task,
    displaced: readonly BoardSubtask[],
    sourceAgentId: string,
  ) {
    for (const row of displaced) {
      const agentId = row.claimedBy;
      if (!agentId || task.tabs.some((tab) => tab.agentId === agentId)) continue;
      try {
        const handle = paseo().agents.ref(agentId);
        await handle.refresh();
        const agent = handle.current();
        if (!agent || agent.archivedAt || agent.status === "closed" || agent.status === "error")
          continue;
        await handle.send(
          `方案已重新确认（新一轮），你认领的看板子任务 ${row.id} 已中止。请立即停手：不要再修改文件，也不要调用 vibe_board_complete；等待执行主代理重新安排。`,
          { sourceAgentId, activeTurnBehavior: "steer" },
        );
      } catch (error) {
        log("新一轮停手消息发送失败", error);
      }
    }
  }
  async function confirmWith(
    task: Task,
    plan: TaskPlan,
    source: TaskPlanSource,
    requestId: string,
    tab: TaskTab,
  ) {
    // The user's confirmation wins over an unfinished review: it confirms the plan as it stands.
    await review.cancel(task.workspaceId, "用户在审阅完成前确认了方案");
    const roles = alignRolesToTabs(await rolesFor(task, tab), task.tabs);
    const frozen = freezeTaskSubtaskPresets(plan, roles, (id) => store.presets.get(id));
    validateTaskSubtaskPresets(plan, frozen);
    const confirmed = store.tasks.confirm(task.workspaceId, {
      plan,
      rolesSnapshot: frozen,
      planSource: source,
      requestId,
    });
    // The confirmed subtasks become this round's board; a plan without subtasks starts empty. A
    // replayed confirmation leaves the board alone.
    const { displaced } = store.taskBoard.seed(
      task.workspaceId,
      confirmed.confirmedAt,
      plan.subtasks,
    );
    await stopDisplacedClaimers(confirmed, displaced, tab.agentId);
    // A confirmation of a real plan clears a previous round's "no plan" marker.
    if (confirmed.control?.directInstruction)
      store.tasks.updateControl(task.workspaceId, { directInstruction: null });
    store.taskArtifacts.record({
      workspaceId: task.workspaceId,
      kind: "plan",
      sourceKey: "confirmed:" + requestId,
      confirmedAt: confirmed.confirmedAt,
      source,
      summary: "已确认方案：" + plan.goal,
      data: { plan },
    });
    await tabs.appendStatus(
      tab.agentId,
      `已确认方案并进入排队。\n${await tabs.status(task.workspaceId, tab.agentId).then((r) => r.text)}`,
    );
    return { task: confirmed, message: "已确认方案，等待调度器准入后发送给执行 tab。" };
  }
  /** Create the idle role tabs a task should expose (#2 方案、#3 探路、#4 执行、#5 复核、#6 验证).
   *  No prompt is sent, so pre-created tabs do not consume a model turn. */
  function provisionTabs(workspaceId: string): Promise<void> {
    const pending = provisioning.get(workspaceId);
    if (pending) return pending;
    if (!canProvision(workspaceId)) return Promise.resolve();
    const run = queue(workspaceId, () => provisionTabsNow(workspaceId)).catch((error) => {
      provisionFailed(workspaceId, error);
    }).finally(() => {
      if (provisioning.get(workspaceId) === run) provisioning.delete(workspaceId);
    });
    provisioning.set(workspaceId, run);
    return run;
  }
  async function registerRoleTab(agentId: string, role: PrebuiltRole, presetId: string) {
    try {
      return !!(await tabs.ensureTab(agentId, { role, presetId }));
    } catch {
      return false;
    }
  }
  async function provisionTabsNow(workspaceId: string) {
    let task = store.tasks.get(workspaceId);
    if (!task || !PROVISION_PHASES.has(task.phase)) return;
    const placement = await tabs.workspace(workspaceId);
    if (!task.tabs.some((tab) => tab.role === "main")) {
      const main = await tabs.ensureTab(task.anchorAgentId, { role: "main" });
      if (!main) throw new Error("旧任务主会话尚不可用，暂缓流程 tab 补建");
      task = requireTask(workspaceId);
    }
    for (const role of PREBUILT_ROLES) {
      task = store.tasks.get(workspaceId);
      if (!task || !PROVISION_PHASES.has(task.phase)) return;
      const key = workspaceId + ":" + role;
      if (task.tabs.some((tab) => tab.role === role)) {
        orphanTabs.delete(key);
        continue;
      }
      if (roleTabDisabled(store, role, { task, projectId: placement.projectId })) continue;
      if (!canProvision(key)) continue;
      // A tab created earlier whose registration failed: register it instead of creating
      // another agent; if it still cannot be registered, archive it so it does not linger.
      const orphan = orphanTabs.get(key);
      if (orphan) {
        orphanTabs.delete(key);
        if (await registerRoleTab(orphan.agentId, role, orphan.presetId)) continue;
        provisionFailed(key, new Error("流程 tab 登记仍不可用"));
        await paseo()
          .agents.ref(orphan.agentId)
          .archive()
          .catch((error) => provisionFailed(key, error));
        continue;
      }
      try {
        await ensureRoleTabNow({ workspaceId, role });
        provisionFailures.delete(key);
      } catch (error) {
        if (error instanceof TaskWorkspaceUnavailableError) throw error;
        provisionFailed(key, error);
      }
    }
    provisionFailures.delete(workspaceId);
  }
  interface EnsureRoleInput {
    workspaceId: string;
    role: FlowRole;
    enable?: boolean;
    provider?: string;
    thinkingOptionId?: string;
  }
  function ensureRoleTab(input: EnsureRoleInput): Promise<{ agentId: string }> {
    return queue(input.workspaceId, () => ensureRoleTabNow(input));
  }
  async function ensureRoleTabNow(input: EnsureRoleInput): Promise<{ agentId: string }> {
    const task = requireTask(input.workspaceId);
    const existing = task.tabs.find((tab) => tab.role === input.role);
    if (existing && (!input.provider || input.provider.split("/")[0] === existing.provider))
      return { agentId: existing.agentId };
    if (existing) {
      const handle = paseo().agents.ref(existing.agentId);
      await handle.refresh();
      const current = handle.current();
      const history = await handle.timeline.refetch({ direction: "tail", limit: 1 });
      if (current?.activeTurn || history.entries.length)
        throw new Error("该 tab 已有对话，无法自动更换 agent 类型；请先在该 tab 切换模型后再发送");
    }
    const key = input.workspaceId + ":" + input.role;
    const orphan = orphanTabs.get(key);
    if (orphan) {
      if (!(await registerRoleTab(orphan.agentId, input.role, orphan.presetId)))
        throw new Error("流程 tab 登记失败，请重试");
      orphanTabs.delete(key);
      return { agentId: orphan.agentId };
    }
    const placement = await tabs.workspace(input.workspaceId);
    const { snapshot, model } = resolveEnsureModel(task, input, placement.projectId);
    const modeId = taskRoleModeId(input.role, model.provider, model.permissionMode);
    const handle = await paseo()
      .workspaces.ref(input.workspaceId)
      .agents.create({
        config: {
          provider: model.provider + "/" + model.model,
          ...(modeId ? { modeId } : {}),
          ...(model.thinking && model.thinking !== "default"
            ? { thinkingOptionId: model.thinking }
            : {}),
          ...(snapshot.instructions ? { systemPrompt: snapshot.instructions } : {}),
        },
        env: {
          VIBE_ROLE: input.role,
          VIBE_WORKSPACE_ID: input.workspaceId,
          ...(snapshot.runtimeEnv ? { VIBE_RUNTIME_ENV: snapshot.runtimeEnv } : {}),
        },
        labels: { [TASK_TAB_ROLE_LABEL]: input.role, [TASK_TAB_PRESET_LABEL]: snapshot.presetId },
      });
    if (existing) {
      store.tasks.updateTab(input.workspaceId, existing.agentId, {
        replacementAgentId: handle.id,
        provider: model.provider,
        model: model.model,
        thinking: model.thinking,
        presetId: snapshot.presetId,
      });
    }
    if (!(await registerRoleTab(handle.id, input.role, snapshot.presetId))) {
      orphanTabs.set(input.workspaceId + ":" + input.role, {
        agentId: handle.id,
        presetId: snapshot.presetId,
      });
      throw new Error("流程 tab 已创建但登记失败，请重试");
    }
    if (existing)
      await paseo()
        .agents.ref(existing.agentId)
        .archive()
        .catch((error) => log("旧空流程 tab 归档失败", error));
    return { agentId: handle.id };
  }
  function resolveEnsureModel(task: Task, input: EnsureRoleInput, projectId: string | null) {
    let preset = roleTabPreset(store, input.role, { task, projectId: projectId });
    const disabled = roleTabDisabled(store, input.role, { task, projectId: projectId });
    if (!preset && input.provider && !disabled) {
      const main = task.tabs.find((tab) => tab.role === "main");
      const slash = input.provider.indexOf("/");
      const snapshot = mainFallbackSnapshot(
        main ?? {
          provider: input.provider.slice(0, slash),
          model: input.provider.slice(slash + 1),
        },
      );
      preset = { snapshot, model: snapshot.models[0]! };
    }
    if (!preset && input.enable && ["scout", "reviewer"].includes(input.role)) {
      const main = task.tabs.find((tab) => tab.role === "main");
      if (!main) throw new Error("主会话模型尚未就绪，请到「任务默认模型」设置选择模型");
      const snapshot = mainFallbackSnapshot(main);
      const model = snapshot.models[0]!;
      preset = { snapshot, model };
      store.tasks.setRoleSelections(input.workspaceId, {
        ...task.roleSelections,
        [input.role]: { mode: "inherit" },
      });
      store.tasks.updateControl(input.workspaceId, {
        enabledRoles: [
          ...new Set([
            ...(Array.isArray(task.control?.enabledRoles) ? task.control.enabledRoles : []),
            input.role,
          ]),
        ],
      });
    }
    if (!preset)
      throw new Error(
        "该流程角色未启用或默认模型不可用；请到「任务默认模型」设置选择模型，或先启用该 tab",
      );
    const { snapshot } = preset;
    let model = preset.model;
    if (input.provider !== undefined) {
      const slash = input.provider.indexOf("/");
      if (slash <= 0 || slash === input.provider.length - 1)
        throw new Error("请选择完整的 provider/model 模型");
      model = {
        ...model,
        provider: input.provider.slice(0, slash),
        model: input.provider.slice(slash + 1),
      };
    }
    if (input.thinkingOptionId !== undefined)
      model = { ...model, thinking: input.thinkingOptionId };
    if (!model.provider || !model.model || model.model === UNRESOLVED_TAB_MODEL)
      throw new Error("主会话模型尚未解析，请到「任务默认模型」设置选择模型");
    return { snapshot, model };
  }
  async function provisionMissing() {
    for (const task of store.tasks.list()) {
      if (needsProvision(task))
        await provisionTabs(task.workspaceId).catch((error) =>
          log("旧任务流程 tab 补建失败", error),
        );
    }
  }
  /** The scheduler admitted a queued task. The phase check runs inside the workspace queue, so a
   *  direct authorization in the execution tab and this path always see each other's result. */
  async function workerAdmitted(admission: Admission) {
    await queue(admission.workspaceId, async () => {
      const task = store.tasks.get(admission.workspaceId);
      if (!task || task.confirmedAt !== admission.confirmedAt || task.phase !== "queued") return;
      await openWorker(task, admission);
    });
  }
  async function startWork(
    task: Task,
    handle: PaseoAgentHandle,
    tab: TaskTab | null,
    projectId: string,
  ) {
    const reason = String(task.control?.executionReason ?? "").trim();
    const executing = store.tasks.setPhase(task.workspaceId, "executing");
    const prompt = store.prompts.resolve("board.task.work", {
      projectId,
      vars: { plan: JSON.stringify(executing.plan, null, 2), reason },
    });
    await handle.send(prompt + "\n\n" + readResourceBriefing(db).briefing, {
      sourceAgentId: executing.anchorAgentId,
    });
    if (reason) store.tasks.updateControl(task.workspaceId, { executionReason: null });
    store.tasks.updateControl(task.workspaceId, { blockingReason: null });
    store.tasks.setSummary(task.workspaceId, `执行 tab #${tab?.number ?? "?"} 已启动，等待交付。`);
  }
  async function openWorker(initial: Task, admission: Admission) {
    let task = requireTask(initial.workspaceId);
    const preset =
      findTaskActualPreset(task, { role: "worker", admittedOnly: true }) ??
      task.rolesSnapshot?.worker;
    if (!preset) throw new Error("任务缺少执行角色快照");
    const index = preset.models.findIndex(
      (model) => model.provider === admission.provider && model.model === admission.model,
    );
    if (index < 0) throw new Error("调度准入模型与确认快照不一致，保留排队等待核对");
    const model = preset.models[index]!;
    const { projectId } = await projectFor(task.workspaceId);
    // Another path (a direct authorization in the execution tab) already bound this admission.
    if (resources.holderOf(admission.reservationId)) return;
    // The agent this call binds the admission to; the failure path only releases that binding.
    let admitting: string | undefined;
    const admit = (agent: { id: string; provider: string; model: string; thinking?: string }) => {
      admitting = agent.id;
      return resources.admit(
        {
          workspaceId: task.workspaceId,
          role: "worker",
          agentId: agent.id,
          presetId: preset.presetId,
          provider: agent.provider,
          model: agent.model,
          candidateIndex: index,
        },
        task.confirmedAt,
        () => {
          runtime.registerSession({
            workspaceId: task.workspaceId,
            projectId,
            agentId: agent.id,
            role: "worker",
            provider: agent.provider,
            model: agent.model,
            thinking: agent.thinking,
            candidateIndex: index,
            confirmedAt: task.confirmedAt!,
          });
        },
      );
    };
    try {
      // The pre-created execution tab is the execution surface: reuse it instead of opening
      // another top-level tab. Only a missing/closed/mismatched tab falls back to creation.
      const candidate = [...task.tabs].reverse().find((tab) => tab.role === "worker");
      if (candidate) {
        const existing = paseo().agents.ref(candidate.agentId);
        let reusable: PaseoAgent | undefined;
        let busy = false;
        try {
          await existing.refresh();
          let current = existing.current();
          if (current?.status === "closed" && typeof existing.resume === "function") {
            await existing.resume().catch(() => {});
            await existing.refresh();
            current = existing.current();
          }
          if (
            current &&
            !current.archivedAt &&
            !current.internal &&
            current.model &&
            !current.activeTurn &&
            current.provider === admission.provider &&
            current.model === admission.model
          )
            reusable = current;
          else busy = !!current?.activeTurn;
        } catch (error) {
          log("执行 tab 核对失败，改用新 tab", error);
        }
        if (reusable || busy) {
          // The probe above awaited the host; anything that left `queued` meanwhile owns the task.
          task = requireTask(task.workspaceId);
          if (task.phase !== "queued" || task.confirmedAt !== admission.confirmedAt) return;
        }
        if (busy) {
          // A running turn in the execution tab is normally the user's own message: its
          // turn_started authorization binds this admission. Keep the reservation; turnEnded
          // retries the admission when nothing bound it.
          store.tasks.updateControl(task.workspaceId, {
            blockingReason: "执行 tab 正在运行；本轮结束后插件自动发送执行确认",
          });
          return;
        }
        if (reusable) {
          const tab = await tabs.ensureTab(candidate.agentId, {
            role: "worker",
            presetId: preset.presetId,
          });
          await admit({
            id: candidate.agentId,
            provider: reusable.provider,
            model: reusable.model!,
            ...(reusable.thinkingOptionId ? { thinking: reusable.thinkingOptionId } : {}),
          });
          task = requireTask(task.workspaceId);
          if (task.phase !== "queued") throw new Error("任务已停止，不启动执行 tab");
          await startWork(task, existing, tab, projectId);
          return;
        }
        const updated = store.tasks.updateTab(task.workspaceId, candidate.agentId, {
          role: "session",
        });
        await existing
          .setTitle(tabTitle(updated))
          .catch((error) => log("旧执行 tab 标题更新失败", error));
      }
      const modeId = taskRoleModeId("worker", model.provider, model.permissionMode);
      const handle = await paseo()
        .workspaces.ref(task.workspaceId)
        .agents.create({
          config: {
            provider: `${model.provider}/${model.model}`,
            ...(modeId ? { modeId } : {}),
            ...(model.thinking ? { thinkingOptionId: model.thinking } : {}),
          },
          env: {
            VIBE_ROLE: "worker",
            VIBE_WORKSPACE_ID: task.workspaceId,
            ...(preset.runtimeEnv ? { VIBE_RUNTIME_ENV: preset.runtimeEnv } : {}),
          },
          labels: {
            [TASK_TAB_ROLE_LABEL]: "worker",
            [TASK_TAB_PRESET_LABEL]: preset.presetId,
          },
        });
      await handle.refresh();
      const agent = handle.current();
      if (!agent?.model) throw new Error("无法核对执行 tab 的实际模型");
      const tab = await tabs.ensureTab(handle.id, {
        role: "worker",
        presetId: preset.presetId,
      });
      await admit({
        id: handle.id,
        provider: agent.provider,
        model: agent.model,
        ...(agent.thinkingOptionId ? { thinking: agent.thinkingOptionId } : {}),
      });
      task = requireTask(task.workspaceId);
      if (task.phase !== "queued") throw new Error("任务已停止，不打开执行 tab");
      await startWork(task, handle, tab, projectId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // Release only what this call holds: the admission it bound, or the still-unbound
      // admission when it never started binding. A reservation another path bound stays put.
      try {
        const holder = resources.holderOf(admission.reservationId);
        if (holder && holder === admitting) await resources.releaseAgent(task.workspaceId, holder);
        else if (!holder && !admitting) {
          await resources.request({
            workspaceId: task.workspaceId,
            action: "release",
            reservationId: admission.reservationId,
          });
          resources.forgetAdmission(task.workspaceId, admission.reservationId);
        }
      } catch (releaseError) {
        log("执行准入释放失败", releaseError);
      }
      if (store.tasks.get(task.workspaceId)?.phase === "queued")
        store.tasks.updateControl(task.workspaceId, { blockingReason: "执行启动失败：" + reason });
      throw error;
    }
  }
  async function workerCompleted(
    task: Task,
    tab: TaskTab,
    page: TimelinePage,
    turnId: string | null,
  ) {
    const entry = lastAssistant(page, turnId);
    if (!entry || entry.item.type !== "assistant_message") return;
    const delivery = parseDelivery(entry.item.text);
    const { directory } = await projectFor(task.workspaceId);
    const commitHash = await headCommit(directory);
    const source = sourceFor(tab, page, entry);
    if (delivery) {
      store.taskArtifacts.record({
        workspaceId: task.workspaceId,
        kind: "delivery",
        sourceKey: source.sourceKey,
        confirmedAt: task.confirmedAt,
        source,
        summary: delivery.summary,
        data: { status: delivery.status, summary: delivery.summary, commitHash },
      });
    }
    if (delivery?.status === "completed") {
      const target = task.rolesSnapshot?.reviewer ? "reviewing" : "verifying";
      const current = requireTask(task.workspaceId);
      if (current.phase === "executing") store.tasks.setPhase(task.workspaceId, target);
      store.tasks.setSummary(
        task.workspaceId,
        `执行 tab #${tab.number} 已交付：${delivery.summary || "见执行记录"}`,
      );
      await tabs.appendStatus(
        tab.agentId,
        `执行交付已记录（#${tab.number}）。${target === "reviewing" ? "正在打开代码复核 tab。" : "正在打开验证 tab。"}`,
      );
      return;
    }
    if (delivery?.status === "blocked") {
      const current = requireTask(task.workspaceId);
      if (current.phase === "executing") store.tasks.setPhase(task.workspaceId, "paused");
      store.tasks.updateControl(task.workspaceId, {
        blockingReason: delivery.summary || "执行报告受阻",
      });
      store.tasks.setSummary(task.workspaceId, `执行受阻：${delivery.summary}`);
      return;
    }
    store.tasks.setSummary(
      task.workspaceId,
      `执行 tab #${tab.number} 回合结束，未输出 vibe-delivery 完成标记；可在该 tab 继续。`,
    );
  }
  /** A complete plan in a #2 turn starts, continues or finishes the multi-model review. */
  async function plannerTurnEnded(
    workspaceId: string,
    tab: TaskTab,
    page: TimelinePage,
    turnId: string | null,
  ) {
    const entry = lastAssistant(page, turnId);
    if (entry?.item.type !== "assistant_message") return;
    let plan: TaskPlan;
    try {
      plan = parseTaskPlan(entry.item.text);
    } catch {
      return;
    }
    const text = entry.item.text;
    await queue(workspaceId, async () => {
      const task = store.tasks.get(workspaceId);
      if (!task || !tabFor(task, tab.agentId)) return;
      await review.onPlannerPlan(task, tab, { plan, text, source: sourceFor(tab, page, entry) });
    });
  }
  async function savePlanFromTurn(task: Task, tab: TaskTab, page: TimelinePage) {
    if (!["planning", "awaiting_confirmation"].includes(task.phase)) return;
    const found = planMessage(page);
    if (!found) return;
    const current = requireTask(task.workspaceId);
    if (JSON.stringify(current.plan) === JSON.stringify(found.plan)) return;
    store.tasks.savePlan(task.workspaceId, found.plan);
    store.tasks.setSummary(task.workspaceId, `主会话已更新方案：${found.plan.goal}`);
  }
  /** The latest verification of this confirmation round must itself have passed. */
  async function latestVerification(task: Task) {
    const latest = store.taskArtifacts
      .list(task.workspaceId, { kind: "verification", confirmedAt: task.confirmedAt })
      .at(-1);
    if (!latest || latest.data?.conclusion !== "pass" || latest.data?.voided === true)
      return undefined;
    return latest;
  }
  async function accept(input: {
    workspaceId: string;
    agentId: string;
    requestId: string;
    reason?: string;
  }) {
    // Serialize the whole finalizer: a second click enters after this attempt and sees the
    // new phase or the recorded request instead of starting a parallel Git run.
    return queue(input.workspaceId, async () => {
      const task = requireTask(input.workspaceId);
      if (task.phase !== "awaiting_acceptance" || !task.confirmedAt)
        throw new Error("只有本轮验证通过的待验收任务可通过");
      if (accepting.has(task.workspaceId)) throw new Error("Git 收尾正在进行，请稍后核对结果");
      const attemptKey = "accept-request:" + input.requestId;
      const control = task.control ?? {};
      if (
        store.taskArtifacts.get(task.workspaceId, "git", attemptKey) ||
        control.acceptanceRequestId === input.requestId
      )
        throw new Error("本次通过请求已经处理；请核对结果");
      const active = { cancelled: false };
      accepting.set(task.workspaceId, active);
      try {
        const verification = await latestVerification(task);
        if (!verification) throw new Error("本轮没有完成且通过的最新验证");
        const commitHash = String(verification.data?.commitHash ?? "");
        if (!/^(?:[\da-f]{40}|[\da-f]{64})$/i.test(commitHash))
          throw new Error("验证沉淀缺少本轮完整 commit");
        const busy = (await tabs.tabsFor(task, true)).filter(
          (tab) => tab.busy && BUSY_ROLES.has(tab.role),
        );
        if (busy.length)
          throw new Error(
            "执行、复核或验证 tab 仍在运行：" + busy.map((tab) => `#${tab.number}`).join("、"),
          );
        const { directory, project } = await projectFor(task.workspaceId);
        const tab = tabFor(task, input.agentId) ?? anchorTab(task);
        if (!tab) throw new Error("任务还没有可记录的 tab 来源");
        const reason = input.reason?.trim() || "";
        const source: TaskPlanSource = {
          tabNumber: tab.number,
          agentId: tab.agentId,
          sourceKey: attemptKey,
        };
        store.taskArtifacts.record({
          workspaceId: task.workspaceId,
          kind: "git",
          sourceKey: attemptKey,
          confirmedAt: task.confirmedAt,
          source,
          summary: reason ? "用户发起通过尝试：" + reason : "用户发起通过尝试",
          data: { action: "accept", requestId: input.requestId, ...(reason ? { reason } : {}) },
        });
        const attempt = Number(task.control?.gitAttempt ?? 0) + 1;
        const previousState = task.control?.git as GitState | undefined;
        const previous = previousState?.verifiedCommit === commitHash ? previousState : undefined;
        store.tasks.updateControl(task.workspaceId, {
          acceptanceSource: source,
          acceptanceRequestId: input.requestId,
          verifiedCommit: commitHash,
          currentStep: "git",
          gitAttempt: attempt,
        });
        const result = await git.finalize({
          worktree: directory,
          repoPath: project.repoPath,
          verifiedCommit: commitHash,
          previous,
          isCancelled: () =>
            active.cancelled || requireTask(task.workspaceId).confirmedAt !== task.confirmedAt,
          onProgress: (state) => {
            store.tasks.updateControl(task.workspaceId, { git: state });
          },
        });
        // verification_required, blocked and pending_push all leave the task paused until the
        // user resolves the condition; only a fully merged and pushed round is completed.
        const phase = result.status === "completed" ? "completed" : "paused";
        store.taskArtifacts.record({
          workspaceId: task.workspaceId,
          kind: "git",
          sourceKey: "git:" + input.requestId,
          confirmedAt: task.confirmedAt,
          source: { ...source, sourceKey: "git:" + input.requestId },
          summary: result.message,
          data: { ...result, ...(reason ? { reason } : {}) },
          phase,
          control: {
            ...(requireTask(task.workspaceId).control ?? {}),
            git: result,
            currentStep: result.status === "completed" ? "done" : "git",
            blockingReason: result.status === "completed" ? null : result.message,
          },
        });
        store.tasks.setSummary(task.workspaceId, result.message);
        await tabs.appendStatus(
          tab.agentId,
          `Git 收尾：${result.message}` + (reason ? `\n用户说明：${reason}` : ""),
        );
        // The task is over: its tabs no longer need repeat suppression.
        if (phase === "completed") tabs.forgetStatus(task.tabs.map((item) => item.agentId));
        return { task: requireTask(task.workspaceId), message: result.message };
      } finally {
        if (accepting.get(task.workspaceId) === active) accepting.delete(task.workspaceId);
      }
    });
  }
  async function status(input: { workspaceId: string; agentId: string }) {
    const result = await tabs.status(input.workspaceId, input.agentId);
    await tabs.appendStatus(input.agentId, result.text);
    return { task: result.task, text: result.text };
  }
  /** Stop queued dispatch, cancel running tabs and release confirmed leases before pausing. */
  function stop(input: {
    workspaceId: string;
    agentId: string;
    requestId: string;
    reason?: string;
  }) {
    // Signal the running finalizer before waiting in the queue; otherwise stop would sit behind
    // the very Git run it is meant to interrupt.
    const activeAccept = accepting.get(input.workspaceId);
    if (activeAccept) activeAccept.cancelled = true;
    return queue(input.workspaceId, async () => {
      const task = requireTask(input.workspaceId);
      await review.cancel(task.workspaceId, "任务已停止");
      const views = await tabs.tabsFor(task, true);
      const failures: string[] = [];
      for (const view of views) {
        if (!view.busy) continue;
        const handle = paseo().agents.ref(view.agentId);
        try {
          await handle.cancelRun();
          await waitStopped(handle);
        } catch (error) {
          failures.push(
            `#${view.number} 停止未确认：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      try {
        await resources.settled(task.workspaceId);
      } catch (error) {
        failures.push(
          "资源释放未确认：" + (error instanceof Error ? error.message : String(error)),
        );
      }
      const current = requireTask(task.workspaceId);
      if (
        [
          "planning",
          "awaiting_confirmation",
          "queued",
          "executing",
          "reviewing",
          "verifying",
          "awaiting_acceptance",
        ].includes(current.phase)
      )
        store.tasks.setPhase(task.workspaceId, "paused");
      const reason = input.reason?.trim();
      const text = failures.length
        ? "已请求停止，但以下会话或资源仍需核对：" + failures.join("；")
        : "任务已停止：排队派发已撤销，运行中的 tab 已停止，资源已释放或核对。";
      store.tasks.updateControl(task.workspaceId, {
        blockingReason: failures.length ? text : null,
        stoppedReason: reason ?? null,
        stoppedAt: new Date().toISOString(),
      });
      store.tasks.setSummary(task.workspaceId, text);
      await tabs.appendStatus(input.agentId, text);
      if (failures.length) throw new Error(text);
      return { task: requireTask(task.workspaceId), message: text };
    });
  }
  function makePacket(
    task: Task,
    tab: TaskTab,
    output: string,
    checkpoint: HandoffPacket["checkpoint"],
  ): HandoffPacket {
    return buildPacket({
      fromTab: {
        number: tab.number,
        agentId: tab.agentId,
        role: TASK_TAB_ROLE_LABELS[tab.role],
        model: tab.model,
      },
      phase: TASK_PHASE_LABELS[task.phase],
      planGoal: task.plan?.goal ?? "",
      checkpoint,
      output,
      now: new Date(),
    });
  }
  /** Old tasks and corrupt rows have no usable packet; callers then build one from the timeline. */
  function loadHandoff(workspaceId: string, tabNumber: number): HandoffPacket | undefined {
    const parsed = HandoffPacketSchema.safeParse(
      store.taskHandoffs.get(workspaceId, tabNumber)?.packet,
    );
    return parsed.success ? parsed.data : undefined;
  }
  /** Every finished turn leaves the tab's latest packet in vibe.db for a later takeover. */
  async function refreshHandoff(
    task: Task,
    tab: TaskTab,
    page: TimelinePage,
    turnId: string | null,
  ) {
    const entry = lastAssistant(page, turnId);
    if (entry?.item.type !== "assistant_message" || !entry.item.text.trim()) return;
    try {
      const { directory } = await projectFor(task.workspaceId);
      const packet = makePacket(task, tab, entry.item.text, await captureCheckpoint(directory));
      store.taskHandoffs.save(task.workspaceId, tab.number, tab.agentId, packet);
    } catch (error) {
      log("刷新交接包失败", error);
    }
  }
  type HandoffInput = {
    workspaceId: string;
    agentId: string;
    requestId: string;
    reason?: string;
  };
  /** A user-native `/接手 #n` or "继续 #n 的工作" moves #n's role, progress and worker lease. */
  function handoff(input: HandoffInput) {
    return queue(input.workspaceId, () => handoffNow(input));
  }
  async function handoffNow(input: HandoffInput) {
    const task = requireTask(input.workspaceId);
    const targetNumber = handoffTarget(input.reason);
    if (!targetNumber) throw new Error("请提供要接手的 tab 编号，例如 /接手 #2");
    const from = task.tabs.find((tab) => tab.number === targetNumber);
    if (!from) throw new Error(`任务没有 #${targetNumber} tab`);
    if (from.agentId === input.agentId) throw new Error("不能接手当前 tab 自身");
    if (from.role === "session") throw new Error(`#${targetNumber} 没有可接手的角色`);
    const claimed = await tabs.ensureTab(input.agentId);
    if (!claimed) throw new Error("当前 tab 尚未登记为任务 tab");
    if (claimed.number === from.number) throw new Error("不能接手当前 tab 自身");
    const views = await tabs.tabsFor(task, true);
    const toView = views.find((view) => view.agentId === input.agentId);
    if (!toView) throw new Error("当前 tab 尚未登记为任务 tab");
    let worker: { presetId: string; index: number } | undefined;
    if (from.role === "worker") {
      const preset =
        findTaskActualPreset(task, { role: "worker", admittedOnly: true }) ??
        task.rolesSnapshot?.worker;
      if (!preset) throw new Error("任务缺少执行角色快照");
      if (toView.model === UNRESOLVED_TAB_MODEL)
        throw new Error("当前 tab 的模型尚未解析，请稍后再试");
      const index = preset.models.findIndex(
        (candidate) => candidate.provider === toView.provider && candidate.model === toView.model,
      );
      if (index < 0)
        throw new Error(
          `当前 tab 的模型 ${toView.provider}/${toView.model} 不在本轮执行快照内；请先在当前 tab 选择已确认的执行模型`,
        );
      worker = { presetId: preset.presetId, index };
    }
    const fromHandle = paseo().agents.ref(from.agentId);
    await fromHandle.refresh();
    const fromRunning = !!fromHandle.current()?.activeTurn;
    // The stored packet is the state at the end of #n's last turn; a running tab has moved on.
    const stored = fromRunning ? undefined : loadHandoff(task.workspaceId, from.number);
    const directory = (await projectFor(task.workspaceId)).directory;
    const checkpoint = await captureCheckpoint(directory);
    let packet = stored;
    if (!packet) {
      try {
        const page = await timeline(from.agentId, 40);
        const entry = lastAssistant(page, null);
        packet = makePacket(
          task,
          from,
          entry?.item.type === "assistant_message" ? entry.item.text : "",
          checkpoint,
        );
      } catch (error) {
        log("读取接手来源进度失败", error);
      }
    }
    const drift = stored ? checkpointDrift(stored.checkpoint, checkpoint) : undefined;
    if (fromRunning) {
      await fromHandle.cancelRun();
      await waitStopped(fromHandle);
    }
    // The receiving tab may still be mid-turn; stop it before changing mode or role.
    const toHandle = paseo().agents.ref(input.agentId);
    await toHandle.refresh();
    if (toHandle.current()?.activeTurn) {
      await toHandle.cancelRun();
      await waitStopped(toHandle);
    }
    try {
      const { projectId } = await projectFor(task.workspaceId);
      if (worker) {
        await resources.releaseAgent(task.workspaceId, from.agentId);
        if (resources.hasLease(from.agentId)) throw new Error("原执行租约尚未释放，资源保持待核对");
        const previousSession = runtime.findSessionByAgent(from.agentId);
        await resources.admit(
          {
            workspaceId: task.workspaceId,
            role: "worker",
            agentId: input.agentId,
            presetId: worker.presetId,
            provider: toView.provider,
            model: toView.model,
            candidateIndex: worker.index,
          },
          task.confirmedAt,
          () => {
            if (previousSession) {
              runtime.recordContinuation({
                fromSessionId: previousSession.id,
                agentId: input.agentId,
                provider: toView.provider,
                model: toView.model,
                candidateIndex: worker!.index,
                reason: input.reason?.trim() || "接手 #" + from.number,
                ...(claimed.thinking ? { thinking: claimed.thinking } : {}),
              });
            } else {
              runtime.registerSession({
                workspaceId: task.workspaceId,
                projectId,
                agentId: input.agentId,
                role: "worker",
                provider: toView.provider,
                model: toView.model,
                thinking: claimed.thinking,
                candidateIndex: worker!.index,
                confirmedAt: task.confirmedAt,
              });
            }
          },
        );
      }
      const updatedTo = store.tasks.updateTab(task.workspaceId, input.agentId, {
        role: from.role,
      });
      const updatedFrom = store.tasks.updateTab(task.workspaceId, from.agentId, {
        role: "session",
      });
      await Promise.all([
        toHandle
          .setTitle(tabTitle(updatedTo))
          .catch((error) => log("接手 tab 标题更新失败", error)),
        fromHandle
          .setTitle(tabTitle(updatedFrom))
          .catch((error) => log("原 tab 标题更新失败", error)),
      ]);
      const roleText = rolePromptKey(from.role);
      const continuation = store.prompts.resolve("board.task.continuation", {
        projectId,
        vars: {
          summary: [
            `#${from.number} ${TASK_TAB_ROLE_LABELS[from.role]} 已停止，由 #${updatedTo.number} 接手。`,
            `任务阶段：${TASK_PHASE_LABELS[task.phase]}`,
            packet
              ? renderHandoff(packet, {
                  notice: store.prompts.resolve(HISTORY_NOTICE_PROMPT.key, { projectId }),
                  ...(drift ? { drift } : {}),
                })
              : "",
          ]
            .filter(Boolean)
            .join("\n"),
          prompt:
            (input.reason ?? "").replace(/#\s*\d+/, "").trim() ||
            "请继续未完成的工作，保持已确认方案范围。",
        },
      });
      const message = [
        roleText
          ? store.prompts.resolve(roleText, {
              projectId,
              vars: roleVars(requireTask(task.workspaceId).tabs),
            })
          : "",
        continuation,
      ]
        .filter(Boolean)
        .join("\n\n");
      await toHandle.send(message, { sourceAgentId: from.agentId });
      const text = `#${from.number} 已由 #${updatedTo.number} 接手（${TASK_TAB_ROLE_LABELS[from.role]}）。`;
      store.tasks.setSummary(task.workspaceId, text);
      await tabs.appendStatus(from.agentId, `已停止，由 #${updatedTo.number} 接手。`);
      await tabs.appendStatus(input.agentId, `已接手 #${from.number} 的角色与进度。`);
      return { task: requireTask(task.workspaceId), message: text };
    } catch (error) {
      const current = requireTask(task.workspaceId);
      if (["executing", "reviewing", "verifying", "awaiting_acceptance"].includes(current.phase))
        store.tasks.setPhase(task.workspaceId, "paused");
      const text = "接手失败：" + (error instanceof Error ? error.message : String(error));
      store.tasks.updateControl(task.workspaceId, { blockingReason: text });
      store.tasks.setSummary(task.workspaceId, text);
      throw error;
    }
  }
  type ContinuationInput = {
    requestId: string;
    workspaceId: string;
    agentId: string;
    role: string;
    reason: "failure" | "context";
    message: string;
    summary: string;
    candidateIndex: number;
    confirmedAt: string | null;
    prompt: string;
    previousPhase?: TaskPhase;
    /** When the owner published the request; a later user stop wins over it. */
    requestedAt?: string;
  };
  type ContinuationResult = {
    status: "continued" | "paused" | "exhausted" | "deferred";
    reason: string;
    agentId?: string;
    sessionId?: string;
    candidateIndex?: number;
  };
  const RESTORABLE_PHASES = new Set<TaskPhase>([
    "planning",
    "awaiting_confirmation",
    "executing",
    "reviewing",
    "verifying",
    "awaiting_acceptance",
  ]);
  function publishContinuationResult(
    workspaceId: string,
    requestId: string,
    result: ContinuationResult,
  ) {
    try {
      publishEvent(db, {
        type: "context.continuation_result",
        payload: { requestId, workspaceId, ...result },
      });
    } catch (error) {
      log("上下文接续结果回写失败", error);
    }
  }
  function finishContinuation(task: Task, input: ContinuationInput, result: ContinuationResult) {
    store.tasks.updateControl(task.workspaceId, {
      continuationRequestId: input.requestId,
      continuationResult: result,
    });
    publishContinuationResult(task.workspaceId, input.requestId, result);
    return { task: requireTask(task.workspaceId), message: result.reason };
  }
  /** vibe-context freezes a worker/main/scout session whose context must be replaced. */
  async function continuation(input: ContinuationInput) {
    return queue(input.workspaceId, async () => {
      const initial = store.tasks.get(input.workspaceId);
      if (!initial) return;
      if (initial.control?.continuationRequestId === input.requestId) {
        const saved = initial.control?.continuationResult as ContinuationResult | undefined;
        if (saved) publishContinuationResult(input.workspaceId, input.requestId, saved);
        return { task: initial, message: saved?.reason ?? "接续请求已处理" };
      }
      const fail = (reason: string, status: "paused" | "exhausted" = "paused") =>
        finishContinuation(initial, input, { status, reason });
      if (initial.confirmedAt !== input.confirmedAt)
        return fail("任务的执行确认已变化，未自动接续");
      const from = tabFor(initial, input.agentId);
      // Reviewer/verifier (vibe-verify) and master have their own owners.
      if (!from || !["main", "planner", "scout", "worker"].includes(from.role)) return;
      const sessionRole = from.role === "main" ? "planner" : from.role;
      if (sessionRole !== input.role) return fail("接续请求的角色与来源 tab 不一致");
      const oldSession = runtime.findSessionByAgent(input.agentId);
      if (!oldSession) return fail("来源会话没有实际模型记录，无法自动接续");
      const replacement = runtime.getContinuation(oldSession.id);
      if (replacement)
        return finishContinuation(initial, input, {
          status: "continued",
          reason: "会话已经接续，不再重复打开 tab",
          agentId: replacement.agentId,
          sessionId: replacement.id,
          candidateIndex: replacement.candidateIndex ?? input.candidateIndex,
        });
      // The owner froze the task only so this request could replace one tab. A phase the state
      // machine cannot restore from paused, or a user stop after the request, means the task must
      // stay paused untouched.
      if (!input.previousPhase || !RESTORABLE_PHASES.has(input.previousPhase))
        return fail(
          "任务阶段为" +
            (initial.phase ? TASK_PHASE_LABELS[initial.phase] : "未知") +
            "，不能自动恢复；保持暂停",
        );
      const stoppedAt = Date.parse(String(initial.control?.stoppedAt ?? ""));
      const requestedAt = Date.parse(input.requestedAt ?? "");
      if (Number.isFinite(stoppedAt) && (!Number.isFinite(requestedAt) || stoppedAt > requestedAt))
        return fail("任务在接续请求之后被用户停止，保持暂停");
      try {
        const views = await tabs.tabsFor(initial, true);
        const fromView = views.find((view) => view.agentId === input.agentId);
        let provider: string;
        let model: string;
        let thinking = from.thinking;
        let modeId: string | undefined;
        let candidateIndex = input.candidateIndex;
        let presetId: string | undefined;
        let runtimeEnv: string | null | undefined;
        if (from.role === "worker") {
          const preset =
            findTaskActualPreset(initial, { role: "worker", admittedOnly: true }) ??
            initial.rolesSnapshot?.worker;
          if (!preset) return fail("任务缺少执行角色快照");
          // A context handoff keeps the model; a failure moves to the next confirmed candidate.
          const index =
            input.reason === "failure" ? input.candidateIndex + 1 : input.candidateIndex;
          const candidate = preset.models[index];
          if (!candidate)
            return fail(
              input.reason === "failure" ? "预设候选模型已耗尽" : "接续模型不在本轮确认快照内",
              input.reason === "failure" ? "exhausted" : "paused",
            );
          provider = candidate.provider;
          model = candidate.model;
          thinking = candidate.thinking || undefined;
          modeId = taskRoleModeId("worker", provider, candidate.permissionMode);
          candidateIndex = index;
          presetId = preset.presetId;
          runtimeEnv = preset.runtimeEnv;
        } else {
          if (!fromView || fromView.model === UNRESOLVED_TAB_MODEL)
            return fail("来源 tab 的模型尚未解析，请稍后重试");
          provider = fromView.provider;
          model = fromView.model;
          modeId = presetModeId(provider, "auto");
        }
        const handle = await paseo()
          .workspaces.ref(input.workspaceId)
          .agents.create({
            config: {
              provider: `${provider}/${model}`,
              ...(modeId ? { modeId } : {}),
              ...(thinking && thinking !== "default" ? { thinkingOptionId: thinking } : {}),
            },
            env: {
              VIBE_ROLE: sessionRole,
              VIBE_WORKSPACE_ID: input.workspaceId,
              ...(runtimeEnv ? { VIBE_RUNTIME_ENV: runtimeEnv } : {}),
            },
            labels: {
              [TASK_TAB_ROLE_LABEL]: from.role,
              ...(presetId ? { [TASK_TAB_PRESET_LABEL]: presetId } : {}),
            },
          });
        await handle.refresh();
        const agent = handle.current();
        if (!agent?.model) return fail("无法核对接续 tab 的实际模型");
        const created = await tabs.ensureTab(handle.id);
        if (!created) return fail("接续 tab 未登记到任务");
        // The owner froze the task; admission and turn handling need the previous phase back.
        if (requireTask(input.workspaceId).phase === "paused")
          store.tasks.setPhase(input.workspaceId, input.previousPhase);
        await handoffNow({
          workspaceId: input.workspaceId,
          agentId: handle.id,
          requestId: input.requestId,
          reason: `#${from.number} ${input.message || "上下文接续"}`,
        });
        // Handoff registers the worker's session; planner/scout need their chain too.
        if (from.role !== "worker" && !runtime.findSessionByAgent(handle.id))
          runtime.recordContinuation({
            fromSessionId: oldSession.id,
            agentId: handle.id,
            provider: agent.provider,
            model: agent.model,
            thinking: agent.thinkingOptionId ?? undefined,
            candidateIndex,
            reason: input.message || "上下文接续",
          });
        const next = runtime.findSessionByAgent(handle.id);
        const nextTab = tabFor(requireTask(input.workspaceId), handle.id);
        const text = `#${from.number} 已由 #${nextTab?.number ?? created.number} 接续（${TASK_TAB_ROLE_LABELS[from.role]}）。`;
        store.tasks.setSummary(input.workspaceId, "上下文接续：" + text);
        await tabs
          .appendStatus(handle.id, "已接续 " + text)
          .catch((error) => log("接续状态追加失败", error));
        return finishContinuation(initial, input, {
          status: "continued",
          reason: "已打开接续 tab：" + text,
          agentId: handle.id,
          ...(next ? { sessionId: next.id } : {}),
          candidateIndex,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        log("上下文接续失败", error);
        const current = requireTask(input.workspaceId);
        if (!["paused", "completed", "failed"].includes(current.phase))
          store.tasks.setPhase(input.workspaceId, "paused");
        return finishContinuation(current, input, {
          status: "paused",
          reason: "接续失败：" + reason,
        });
      }
    });
  }
  async function standaloneAccept(
    agentId: string,
    workspaceId: string,
    page: TimelinePage,
    turnId: string | null,
  ) {
    const task = requireTask(workspaceId);
    if (task.phase !== "awaiting_acceptance") return;
    const messages = page.entries.filter(
      (entry) =>
        entry.item.type === "user_message" &&
        (!turnId || entry.turnId === turnId) &&
        entry.item.text.trim() === "通过" &&
        !entry.item.text.trimStart().startsWith("<paseo-system"),
    );
    const message = messages.at(-1);
    if (!message) return;
    const key =
      "pass:" +
      (message.item.type === "user_message"
        ? (message.item.messageId ?? String(message.seqEnd))
        : message.seqEnd);
    if (task.control?.handledAcceptanceSource === key) return;
    store.tasks.updateControl(workspaceId, { handledAcceptanceSource: key });
    try {
      await accept({ workspaceId, agentId, requestId: key });
    } catch (error) {
      await tabs
        .appendStatus(
          agentId,
          "通过失败：" + (error instanceof Error ? error.message : String(error)),
        )
        .catch(() => {});
      throw error;
    }
  }
  /** A user's whole message "继续 #2 的工作" hands that tab's role to this session tab. */
  async function naturalHandoff(
    task: Task,
    tab: TaskTab,
    page: TimelinePage,
    turnId: string | null,
  ): Promise<boolean> {
    // Natural-language takeover is only for tabs the user opened; a main/worker tab keeps its
    // role even when its text happens to contain a handoff phrase.
    if (tab.role !== "session") return false;
    const messages = page.entries.filter(
      (entry) =>
        entry.item.type === "user_message" &&
        (!turnId || entry.turnId === turnId) &&
        !!entry.item.text.trim() &&
        !entry.item.text.trimStart().startsWith("<paseo-system"),
    );
    const message = messages.at(-1);
    if (!message || message.item.type !== "user_message") return false;
    const number = naturalHandoffTarget(message.item.text);
    if (!number) return false;
    const current = requireTask(task.workspaceId);
    const target = current.tabs.find((item) => item.number === number);
    // The old tab becomes a plain session once handed over, which also stops re-triggering on
    // the slash command's own message.
    if (!target || target.agentId === tab.agentId || target.role === "session") return false;
    const key = "handoff:" + (message.item.messageId ?? String(message.seqEnd));
    if (current.control?.handledHandoffSource === key) return true;
    store.tasks.updateControl(task.workspaceId, { handledHandoffSource: key });
    try {
      await handoff({
        workspaceId: task.workspaceId,
        agentId: tab.agentId,
        requestId: key,
        reason: "#" + number,
      });
    } catch (error) {
      await tabs
        .appendStatus(
          tab.agentId,
          "接手失败：" + (error instanceof Error ? error.message : String(error)),
        )
        .catch(() => {});
      throw error;
    }
    return true;
  }
  async function locatePlan(candidates: readonly TaskTab[]) {
    for (const candidate of candidates) {
      const page = await timeline(candidate.agentId);
      const found = planMessage(page);
      if (found) return { ...found, page, sourceTab: candidate };
    }
    return undefined;
  }
  /** The real user message that started this turn; plugin/agent messages carry <paseo-system>.
   *  Without a turn id nothing proves which message belongs to the turn, so nothing authorizes. */
  async function userTurnMessage(agentId: string, turnId: string | null) {
    if (!turnId) return undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      const page = await timeline(agentId, 30);
      const entry = page.entries
        .filter(
          (candidate) =>
            candidate.item.type === "user_message" &&
            candidate.turnId === turnId &&
            !!candidate.item.text.trim() &&
            !candidate.item.text.trimStart().startsWith("<paseo-system"),
        )
        .at(-1);
      if (entry) return { page, entry };
      await delay(150);
    }
    return undefined;
  }
  async function recordConclusion(
    task: Task,
    tab: TaskTab,
    page: TimelinePage,
    turnId: string | null,
  ) {
    if (tab.role !== "scout" && tab.role !== "plan_reviewer") return;
    const entry = lastAssistant(page, turnId);
    if (!entry || entry.item.type !== "assistant_message") return;
    const text = entry.item.text.trim();
    if (!text) return;
    const source = sourceFor(tab, page, entry);
    try {
      store.taskArtifacts.record({
        workspaceId: task.workspaceId,
        kind: tab.role === "scout" ? "scout" : "plan_review",
        sourceKey: source.sourceKey,
        confirmedAt: task.confirmedAt,
        source,
        summary: text.length > 600 ? text.slice(0, 600) + "…" : text,
        data: { text: text.length > 8_000 ? text.slice(0, 8_000) : text },
      });
      store.tasks.setSummary(
        task.workspaceId,
        `#${tab.number} ${TASK_TAB_ROLE_LABELS[tab.role]}结论：${text.length > 200 ? text.slice(0, 200) + "…" : text}`,
      );
    } catch (error) {
      log("探路或方案复核结论记录失败", error);
    }
  }
  async function rejectWorkerTurn(workspaceId: string, tab: TaskTab, text: string): Promise<void> {
    store.tasks.updateControl(workspaceId, { blockingReason: text });
    await tabs.appendStatus(tab.agentId, text).catch((error) => log("执行提示追加失败", error));
    await paseo()
      .agents.ref(tab.agentId)
      .cancelRun()
      .catch((error) => log("未准入的执行回合停止失败", error));
  }
  /** A user's native message in the execution tab authorizes that tab's turn. It still goes
   *  through scheduler admission; agent-to-agent messages never reach this path. */
  async function authorizeWorkerTurn(input: {
    workspaceId: string;
    tab: TaskTab;
    page: TimelinePage;
    entry: TimelineEntry;
    text: string;
  }) {
    const { workspaceId, tab } = input;
    let previousPhase: TaskPhase | undefined;
    try {
      let task = requireTask(workspaceId);
      const currentTab = tabFor(task, tab.agentId);
      if (!currentTab || currentTab.role !== "worker") return;
      // A follow-up while this tab already runs the admitted execution: nothing to admit, bind
      // or cancel.
      if (task.phase === "executing" && resources.hasLease(tab.agentId)) return;
      if (
        ["reviewing", "verifying", "awaiting_acceptance", "completed", "failed"].includes(
          task.phase,
        )
      ) {
        await rejectWorkerTurn(
          workspaceId,
          tab,
          `任务当前阶段为${TASK_PHASE_LABELS[task.phase]}，不能直接执行；请先停止或重新确认方案。`,
        );
        return;
      }
      previousPhase = task.phase;
      let kickoff = ["queued", "paused"].includes(task.phase);
      let direct = `用户在本 tab 直接授权执行。用户消息：\n${input.text}`;
      if (task.phase === "planning" || task.phase === "awaiting_confirmation") {
        // The user's message is the confirmation: of the latest complete plan when there is one,
        // otherwise of the message itself as the task description.
        const source = sourceFor(tab, input.page, input.entry);
        const requestId = "direct:" + source.sourceKey;
        const located = await locatePlan(planCandidates(task, tab));
        if (located) {
          task = store.tasks.savePlan(workspaceId, located.plan);
          await confirmWith(
            task,
            located.plan,
            sourceFor(located.sourceTab, located.page, located.entry),
            requestId,
            tab,
          );
        } else {
          const plan = directPlan(input.text);
          task = store.tasks.savePlan(workspaceId, plan);
          await confirmWith(task, plan, source, requestId, tab);
          store.tasks.updateControl(workspaceId, { directInstruction: true });
          direct = `${DIRECT_NO_PLAN}。用户消息：\n${input.text}`;
        }
        task = requireTask(workspaceId);
        kickoff = true;
      } else if (!task.confirmedAt) {
        await rejectWorkerTurn(
          workspaceId,
          tab,
          "任务没有可执行的确认方案，请先确认 #2 的方案（/执行 或面板「执行」）。",
        );
        return;
      }
      const snapshot = task.rolesSnapshot?.worker;
      if (!snapshot || !task.confirmedAt) {
        await rejectWorkerTurn(workspaceId, tab, "任务缺少本轮执行快照，请重新确认方案。");
        return;
      }
      const handle = paseo().agents.ref(tab.agentId);
      await handle.refresh();
      const agent = handle.current();
      if (!agent?.model) {
        await rejectWorkerTurn(workspaceId, tab, "无法核对执行 tab 的实际模型，请稍后重试。");
        return;
      }
      const index = snapshot.models.findIndex(
        (model) => model.provider === agent.provider && model.model === agent.model,
      );
      if (index < 0) {
        await rejectWorkerTurn(
          workspaceId,
          tab,
          `执行 tab 的模型 ${agent.provider}/${agent.model} 不在本轮确认快照内；请在面板停止后重新确认方案。`,
        );
        return;
      }
      const { projectId } = await projectFor(workspaceId);
      // A direct user message is a fresh authorization; a paused task moves to executing only
      // after the snapshot checks, and an admission failure restores paused.
      if (task.phase === "paused") task = store.tasks.setPhase(workspaceId, "executing");
      try {
        await resources.admit(
          {
            workspaceId,
            role: "worker",
            agentId: tab.agentId,
            presetId: snapshot.presetId,
            provider: agent.provider,
            model: agent.model,
            candidateIndex: index,
          },
          task.confirmedAt,
          () => {
            runtime.registerSession({
              workspaceId,
              projectId,
              agentId: tab.agentId,
              role: "worker",
              provider: agent.provider,
              model: agent.model!,
              thinking: agent.thinkingOptionId ?? undefined,
              candidateIndex: index,
              confirmedAt: task.confirmedAt!,
            });
          },
        );
      } catch (error) {
        if (previousPhase === "paused" && store.tasks.get(workspaceId)?.phase === "executing")
          store.tasks.setPhase(workspaceId, "paused");
        const queued = store.tasks.get(workspaceId)?.phase === "queued";
        const text =
          "执行准入未通过：" +
          (error instanceof Error ? error.message : String(error)) +
          (queued
            ? "。任务保持排队，调度器准入后插件会在本 tab 发送执行确认。"
            : "。本轮未获得资源；可在面板重试或停止任务。");
        store.tasks.updateControl(workspaceId, { blockingReason: text });
        await tabs.appendStatus(tab.agentId, text).catch(() => {});
        await handle
          .cancelRun()
          .catch((cancelError) => log("未准入的执行回合停止失败", cancelError));
        return;
      }
      const latest = requireTask(workspaceId);
      if (latest.phase === "queued") store.tasks.setPhase(workspaceId, "executing");
      store.tasks.updateControl(workspaceId, { blockingReason: null });
      store.tasks.setSummary(
        workspaceId,
        latest.control?.directInstruction
          ? `执行 tab #${tab.number} 已由用户直接授权运行（${DIRECT_NO_PLAN}）。`
          : `执行 tab #${tab.number} 已由用户直接授权运行。`,
      );
      if (kickoff) {
        // The execution confirmation: the tab was told not to edit files before it arrives.
        const current = requireTask(workspaceId);
        const prompt = store.prompts.resolve("board.task.work", {
          projectId,
          vars: { plan: JSON.stringify(current.plan, null, 2), reason: direct },
        });
        await handle.send(prompt + "\n\n" + readResourceBriefing(db).briefing, {
          sourceAgentId: current.anchorAgentId,
        });
      }
    } catch (error) {
      if (previousPhase === "paused" && store.tasks.get(workspaceId)?.phase === "executing") {
        try {
          store.tasks.setPhase(workspaceId, "paused");
        } catch (restoreError) {
          log("执行授权失败后恢复暂停状态失败", restoreError);
        }
      }
      await rejectWorkerTurn(
        workspaceId,
        tab,
        "执行授权失败：" + (error instanceof Error ? error.message : String(error)),
      );
    }
  }
  /** A nonterminal task that lacks a role tab its defaults (or snapshot) would create. */
  function needsProvision(task: Task): boolean {
    if (!PROVISION_PHASES.has(task.phase)) return false;
    if (task.tabs.length <= 1) return true;
    const projectId = typeof task.control?.projectId === "string" ? task.control.projectId : null;
    return PREBUILT_ROLES.some(
      (role) =>
        !task.tabs.some((tab) => tab.role === role) &&
        !!roleTabPreset(store, role, { task, projectId }),
    );
  }
  async function turnStarted(event: {
    agent: { id: string; workspaceId: string | null };
    turnId: string | null;
  }) {
    const workspaceId = event.agent.workspaceId;
    if (!workspaceId) return;
    let task = store.tasks.get(workspaceId);
    if (!task) return;
    if (needsProvision(task))
      void provisionTabs(workspaceId).catch((error) => log("流程 tab 预建失败", error));
    if (review.isReviewer(task, event.agent.id)) return;
    if (reviewActive(task)) void recoverReviews(workspaceId);
    let tab = tabFor(task, event.agent.id);
    if (!tab) {
      tab =
        (await tabs.ensureTab(event.agent.id).catch((error) => {
          log("任务 tab 补登记失败", error);
          return null;
        })) ?? undefined;
      if (!tab) return;
      task = store.tasks.get(workspaceId) ?? task;
    }
    if (tab.role !== "worker") return;
    const agentId = tab.agentId;
    // Ties this turn to the lease it runs under, so its end cannot release a newer admission.
    const noteTurn = () => {
      if (resources.hasLease(agentId)) resources.noteTurnStarted(agentId, event.turnId);
    };
    const message = await userTurnMessage(agentId, event.turnId);
    if (!message || message.entry.item.type !== "user_message") {
      noteTurn();
      return;
    }
    const text = message.entry.item.text.trim();
    // Acceptance and handoff phrases are user authorizations for those actions, not execution.
    if (text === "通过" || HANDOFF_PATTERN.test(text)) {
      noteTurn();
      return;
    }
    await queue(workspaceId, () =>
      authorizeWorkerTurn({
        workspaceId,
        tab: tab!,
        page: message.page,
        entry: message.entry,
        text,
      }),
    ).catch((error) => log("执行 tab 直接授权失败", error));
    noteTurn();
  }
  async function turnEnded(event: {
    agent: { id: string; workspaceId: string | null };
    turnId: string | null;
    outcome: PluginTurnOutcome;
  }) {
    const workspaceId = event.agent.workspaceId;
    if (!workspaceId) return;
    let task = store.tasks.get(workspaceId);
    if (!task) return;
    if (needsProvision(task))
      void provisionTabs(workspaceId).catch((error) => log("流程 tab 预建失败", error));
    // #2's plan reviewers are sub-agents, not tabs: their turns feed the review cycle.
    if (review.isReviewer(task, event.agent.id)) {
      const agentId = event.agent.id;
      await queue(workspaceId, async () => {
        const current = store.tasks.get(workspaceId);
        if (current) await review.reviewerTurnEnded(current, agentId, event.turnId, event.outcome);
      });
      return;
    }
    let tab = tabFor(task, event.agent.id);
    if (!tab) {
      // A fast first turn can end before the agent.created hook has finished registering its tab.
      tab =
        (await tabs.ensureTab(event.agent.id).catch((error) => {
          log("任务 tab 补登记失败", error);
          return null;
        })) ?? undefined;
      if (!tab) return;
      task = store.tasks.get(workspaceId) ?? task;
    }
    const turn = tab.role === "worker" ? resources.takeTurn(tab.agentId, event.turnId) : undefined;
    const page = await timeline(tab.agentId);
    await refreshHandoff(task, tab, page, event.turnId);
    const reviewBefore = reviewMark(task);
    if (event.outcome.kind === "completed") {
      if (await naturalHandoff(task, tab, page, event.turnId)) return;
      if (["main", "session"].includes(tab.role)) await savePlanFromTurn(task, tab, page);
      if (tab.role === "planner") await plannerTurnEnded(workspaceId, tab, page, event.turnId);
      await recordConclusion(task, tab, page, event.turnId);
      if (tab.role === "worker") {
        await workerCompleted(task, tab, page, event.turnId);
        await releaseIdle(workspaceId, tab.agentId, turn);
      }
      await standaloneAccept(tab.agentId, workspaceId, page, event.turnId);
    } else if (event.outcome.kind === "failed" && BUSY_ROLES.has(tab.role)) {
      const current = requireTask(workspaceId);
      if (["executing", "reviewing", "verifying"].includes(current.phase))
        store.tasks.setPhase(workspaceId, "paused");
      store.tasks.updateControl(workspaceId, {
        blockingReason: `${tab.role} tab #${tab.number} 运行失败`,
      });
      if (tab.role === "worker") await releaseIdle(workspaceId, tab.agentId, turn);
    }
    // #1 hears about every other tab's turn; a planner turn that moved the review cycle is already
    // reported by the review rows.
    if (!(tab.role === "planner" && reviewMark(store.tasks.get(workspaceId)) !== reviewBefore)) {
      const entry = lastAssistant(page, event.turnId);
      await options.progress
        .tabTurnEnded({
          task: store.tasks.get(workspaceId) ?? task,
          tab,
          outcome: event.outcome,
          output: entry?.item.type === "assistant_message" ? entry.item.text : "",
        })
        .catch((error) => log("#1 回合汇报失败", error));
    }
    if (tab.role === "worker") await retryAdmission(workspaceId);
    if (reviewActive(store.tasks.get(workspaceId))) await recoverReviews(workspaceId);
  }
  /** Changes when a turn moved the review cycle (started, advanced or finalized it). */
  function reviewMark(task: Task | undefined): string {
    const state = reviewState(task);
    return state ? `${state.cycle}:${state.status}:${task?.plan?.goal ?? ""}` : "";
  }

  /** openWorker leaves an admission unbound while the execution tab is running a turn; once the
   *  tab is idle again and nothing bound it, start execution with that admission. */
  async function retryAdmission(workspaceId: string) {
    const task = store.tasks.get(workspaceId);
    const admission = resources.admissionFor(workspaceId);
    if (!task || task.phase !== "queued" || !admission) return;
    if (admission.confirmedAt !== task.confirmedAt || resources.holderOf(admission.reservationId))
      return;
    await workerAdmitted(admission).catch((error) => log("执行准入重试失败", error));
  }
  const STEP_TITLES: Record<string, string> = {
    scout: "探路结论",
    plan_review: "方案复核",
    delivery: "执行交付",
    review: "代码复核",
    verification: "验证结果",
    git: "Git 收尾",
  };
  function artifactDetail(value: Record<string, unknown> | null): string | null {
    if (!value) return null;
    const raw = typeof value.text === "string" ? value.text : JSON.stringify(value, null, 2);
    return raw.length > 8_000 ? raw.slice(0, 8_000) + "\n…" : raw;
  }
  /** Return the complete flow immediately while missing native tabs recover in the background. */
  async function panel(workspaceId: string) {
    const task = store.tasks.get(workspaceId);
    if (!task)
      return {
        isTask: false,
        task: null,
        phaseLabel: "",
        blockingReason: null,
        tabs: [],
        steps: [],
      };
    if (needsProvision(task))
      void provisionTabs(workspaceId).catch((error) => log("流程 tab 预建失败", error));
    const views = await tabs.tabsFor(task, true);
    const steps: Array<{
      kind: string;
      title: string;
      summary: string;
      detail: string | null;
      createdAt: string | null;
    }> = [];
    if (task.plan) {
      const detail = JSON.stringify(task.plan, null, 2);
      steps.push({
        kind: "plan",
        title: task.control?.directInstruction ? "用户指示（无方案）" : "方案",
        summary: task.plan.goal,
        detail: detail.length > 8_000 ? detail.slice(0, 8_000) + "\n…" : detail,
        createdAt: task.confirmedAt,
      });
    }
    const latest = new Map<string, TaskArtifact>();
    for (const artifact of store.taskArtifacts.list(workspaceId))
      latest.set(artifact.kind, artifact);
    const reviewStep = review.panelStep(task);
    if (reviewStep) steps.push(reviewStep);
    for (const kind of ["scout", "plan_review", "delivery", "review", "verification", "git"]) {
      // The review cycle has its own step; plan_review artifacts are its drafts and opinions.
      if (kind === "plan_review" && reviewStep) continue;
      const artifact = latest.get(kind);
      if (!artifact) continue;
      steps.push({
        kind,
        title: STEP_TITLES[kind] ?? kind,
        summary: artifact.summary,
        detail: artifactDetail(artifact.data),
        createdAt: artifact.createdAt,
      });
    }
    const blockingReason =
      typeof task.control?.blockingReason === "string" ? task.control.blockingReason : null;
    return {
      isTask: true,
      task,
      phaseLabel: TASK_PHASE_LABELS[task.phase],
      blockingReason,
      tabs: views,
      steps,
    };
  }
  function registerPrompts() {
    store.prompts.register(
      [
        PROJECT_AGENT_PROMPT,
        PROJECT_COMPLETION_PROMPT,
        TASK_PLAN_PROMPT,
        ...TASK_HOST_PROMPTS,
        ...TASK_FLOW_PROMPTS,
        TASK_TAB_GUIDE_PROMPT,
        HISTORY_NOTICE_PROMPT,
        PLAN_REVIEW_REQUEST_PROMPT,
        PLAN_REVIEW_REVISE_PROMPT,
        SCOUT_ASK_PROMPT,
      ],
      {
        pruneMissing: true,
        // WP-122 merges these scenario templates into their replacement keys.
        aliases: {
          "board.task.plan": "task.role.planner",
          "board.task.scout": "task.role.scout",
          "board.task.plan_review": "task.role.plan_reviewer",
          "task.role.worker": "board.task.work",
          "board.task.subtask": "task.role.subagent",
        },
      },
    );
  }
  return {
    registerPrompts,
    execute,
    accept,
    stop,
    handoff,
    continuation,
    status,
    panel,
    provisionTabs,
    provisionMissing,
    ensureRoleTab,
    workerAdmitted,
    turnStarted,
    turnEnded,
    rereview,
    recoverReviews,
    reviewerGone,
    releaseAgent: resources.releaseAgent,
    close: async () => {
      for (const active of accepting.values()) active.cancelled = true;
      await Promise.allSettled(serial.values());
    },
    resources,
    runtime,
    review,
  };
}
export type TaskFlow = ReturnType<typeof createTaskFlow>;
