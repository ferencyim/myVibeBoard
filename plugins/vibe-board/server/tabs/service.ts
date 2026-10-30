import { randomUUID } from "node:crypto";
import type { PaseoAgent, PaseoApi, PaseoAgentHandle } from "@getpaseo/client";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { PluginBeforeRequests } from "@getpaseo/plugin/server";
import type { VibeStore } from "../vibe/db";
import {
  OPTIONAL_TASK_ROLES,
  MAIN_FALLBACK_PRESET_ID,
  mainFallbackSnapshot,
  type MainTabModel,
  TASK_PHASE_LABELS,
  TASK_TAB_ROLE_LABEL,
  TASK_TAB_ROLE_LABELS,
  TASK_TAB_PRESET_LABEL,
  TaskPresetSnapshotSchema,
  UNRESOLVED_TAB_MODEL,
  presetModels,
  providerModelLabel,
  resolvePlannerIds,
  tabTitle,
  type ModelRole,
  type Task,
  type TaskPresetSnapshot,
  type TaskRoleSelections,
  type TaskTab,
  type TaskTabRole,
} from "../vibe/contract";
import { assertTaskWorkspace } from "../task-host/workspace";
import type { TaskRuntimeCommands } from "../vibe/db";
import type { SessionRole } from "../vibe/contract";
import { TASK_TAB_GUIDE_PROMPT } from "./prompts";
import { boardProgress } from "./board";
import { resolveMainConfig } from "../main-model";

export { tabTitle };

export class TaskWorkspaceUnavailableError extends Error {
  constructor(readonly reason: "missing" | "archived" | "not-worktree") {
    const messages = {
      "not-worktree": "任务必须绑定独立的附加 Git worktree，不能使用项目主检出或普通目录。",
      archived: "任务 workspace 已归档",
      missing: "任务 workspace 不存在",
    };
    super(messages[reason]);
  }
}

export interface TaskTabView {
  number: number;
  agentId: string;
  role: TaskTabRole;
  roleLabel: string;
  provider: string;
  model: string;
  status: string;
  title: string | null;
  busy: boolean;
  thinking?: string;
  modelId?: string;
  source?: string;
}

/** The whole message must be one of the two user-native handoff forms. */
export const HANDOFF_PATTERN = /^\s*(?:[/／]?\s*接手\s*#?(\d+)|继续\s*#(\d+)\s*的工作)\s*$/;

/** The app keeps agents carrying this label in label order (TAB_ORDER_LABEL in the app's
 *  workspace-tabs/agent-visibility.ts): task tabs show as #1, #2, … */
const TAB_ORDER_LABEL = "paseo.tab-order";

function isSubagent(agent: Pick<PaseoAgent, "labels">): boolean {
  return !!agent.labels?.[PARENT_AGENT_ID_LABEL];
}
function statusOf(agent: PaseoAgent): string {
  if (agent.archivedAt) return "已归档";
  if ((agent.pendingPermissions?.length ?? 0) > 0) return "待审批";
  if (agent.activeTurn) return "运行中";
  if (agent.status === "idle") return "空闲";
  if (agent.status === "error") return "错误";
  if (agent.status === "closed") return "已关闭";
  return agent.status;
}
export function formatTabs(
  tabs: readonly (Pick<TaskTabView, "number" | "roleLabel" | "model"> & { status?: string })[],
) {
  if (!tabs.length) return "（尚无）";
  return tabs
    .map(
      (tab) =>
        `#${tab.number} ${tab.roleLabel} · ${tab.model}${tab.status ? `（${tab.status}）` : ""}`,
    )
    .join("\n");
}

/** Pre-created role tabs follow the flow order (round 8: #2 方案、#3 探路、#4 执行、#5 复核、
 *  #6 验证); numbering matches sequential provisioning. */
export type FlowRole = Extract<TaskTabRole, ModelRole>;
export const FLOW_ROLE_ORDER: readonly FlowRole[] = [
  "planner",
  "scout",
  "worker",
  "reviewer",
  "verifier",
];
/** Label of a plan reviewer sub-agent of #2; its value is the review cycle id. */
export const PLAN_REVIEW_LABEL = "vibe.plan_review";

type DefaultsStore = Pick<VibeStore, "projectConfigs" | "modelDefaults" | "presets">;

function snapshotOf(
  store: DefaultsStore,
  role: ModelRole,
  id: string,
  source: TaskPresetSnapshot["source"],
): TaskPresetSnapshot {
  const preset = store.presets.get(id);
  if (!preset) throw new Error("角色 " + role + " 的预设不存在或不可用：" + id);
  return TaskPresetSnapshotSchema.parse({
    presetId: id,
    source,
    models: presetModels(preset),
    environmentKind: preset.environmentKind,
    runtimeEnv: preset.runtimeEnv,
    instructions: preset.instructions,
    ...(preset.fastMode ? { fastMode: true } : {}),
  });
}

/** The #2 方案 model list (writer first, then reviewers in order), resolved live: reviews run
 *  before confirmation freezes anything; an unconfigured writer inherits the main tab. */
export function resolvePlannerPresets(
  store: DefaultsStore,
  input: {
    selections?: TaskRoleSelections | null;
    projectId?: string | null;
    main?: MainTabModel;
  } = {},
): TaskPresetSnapshot[] {
  const project = input.projectId
    ? store.projectConfigs.get(input.projectId)?.defaultPresets
    : undefined;
  const { ids, source } = resolvePlannerIds(
    input.selections,
    project,
    store.modelDefaults.global(),
  );
  if (!ids.length && input.main) return [mainFallbackSnapshot(input.main)];
  return ids.map((id, index) =>
    snapshotOf(store, index === 0 ? "planner" : "plan_reviewer", id, source),
  );
}

/** Resolve one role preset (task selection > project default > global default) without requiring
 *  the other roles to be configured; only explicit optional-role disables resolve to null. */
export function resolveRolePreset(
  store: DefaultsStore,
  role: ModelRole,
  input: {
    selections?: TaskRoleSelections | null;
    projectId?: string | null;
    main?: MainTabModel;
  } = {},
): TaskPresetSnapshot | null {
  if (role === "planner") {
    const writer = resolvePlannerPresets(store, input)[0];
    if (!writer) throw new Error("角色 planner 未配置可用预设");
    return writer;
  }
  const own = input.selections?.[role];
  let id: string | null | undefined;
  let source: TaskPresetSnapshot["source"] = "task";
  if (own?.mode === "disabled") id = null;
  else if (own?.mode === "preset") id = own.presetId;
  else {
    const project = input.projectId
      ? store.projectConfigs.get(input.projectId)?.defaultPresets
      : undefined;
    if (project?.[role] !== undefined) {
      id = project[role];
      source = "project";
    } else {
      id = store.modelDefaults.global()[role];
      source = "global";
    }
  }
  if (id === undefined && input.main && role !== "plan_reviewer")
    return mainFallbackSnapshot(input.main);
  if (!id) {
    if (OPTIONAL_TASK_ROLES.includes(role)) return null;
    throw new Error("角色 " + role + " 未配置可用预设");
  }
  return snapshotOf(store, role, id, source);
}

export interface PlannedTabView {
  number: number;
  role: TaskTabRole;
  roleLabel: string;
  provider: string;
  model: string;
  status?: string;
}

/** The preset a flow role tab is (or will be) created with: the confirmed snapshot once the task
 *  has one, otherwise the current default. A broken default skips the role (reported through
 *  `onError`) instead of failing the whole roster. */
export function roleTabPreset(
  store: Pick<VibeStore, "projectConfigs" | "modelDefaults" | "presets">,
  role: FlowRole,
  input: { task?: Task; projectId?: string | null; main?: MainTabModel },
  onError?: (error: unknown) => void,
): { snapshot: TaskPresetSnapshot; model: TaskPresetSnapshot["models"][number] } | null {
  let snapshot: TaskPresetSnapshot | null;
  try {
    const enabled = input.task?.control?.enabledRoles;
    const main = input.task?.tabs.find((tab) => tab.role === "main");
    if (main && Array.isArray(enabled) && enabled.includes(role)) {
      const fallback = mainFallbackSnapshot(main);
      return { snapshot: fallback, model: fallback.models[0]! };
    }
    snapshot = input.task?.rolesSnapshot
      ? (input.task.rolesSnapshot[role] ?? null)
      : resolveRolePreset(store, role, {
          selections: input.task?.roleSelections,
          projectId: input.projectId,
          main: input.task?.tabs.find((tab) => tab.role === "main") ?? input.main,
        });
  } catch (error) {
    onError?.(error);
    return null;
  }
  const model = snapshot?.models[0];
  return snapshot && model ? { snapshot, model } : null;
}

export function roleTabDisabled(
  store: DefaultsStore,
  role: FlowRole,
  input: { task?: Task; projectId?: string | null; main?: MainTabModel },
): boolean {
  const task = input.task;
  if (Array.isArray(task?.control?.enabledRoles) && task.control.enabledRoles.includes(role))
    return false;
  if (task?.flowLevel === "simple" && role !== "worker") return true;
  if (task?.flowLevel === "medium" && (role === "scout" || role === "reviewer")) return true;
  if (task?.rolesSnapshot && OPTIONAL_TASK_ROLES.includes(role))
    return task.rolesSnapshot[role] === null;
  try {
    return (
      resolveRolePreset(store, role, {
        selections: task?.roleSelections,
        projectId: input.projectId,
        main: task?.tabs.find((tab) => tab.role === "main") ?? input.main,
      }) === null
    );
  } catch {
    return false;
  }
}

/** The roster a new tab should see: live tabs plus the role tabs the plugin is about to create.
 *  The current tab is never part of the roster; `selfNumber` is the number it will receive. */
export function plannedTaskTabs(input: {
  store: Pick<VibeStore, "projectConfigs" | "modelDefaults" | "presets">;
  task?: Task;
  projectId?: string | null;
  selfRole: TaskTabRole;
  main?: MainTabModel;
}): { tabs: PlannedTabView[]; selfNumber: number } {
  const existing = [...(input.task?.tabs ?? [])].sort((a, b) => a.number - b.number);
  const tabs: PlannedTabView[] = existing.map((tab) => ({
    number: tab.number,
    role: tab.role,
    roleLabel: TASK_TAB_ROLE_LABELS[tab.role],
    provider: tab.provider,
    model: tab.modelLabel || tab.model,
  }));
  const fixed = ["main", ...FLOW_ROLE_ORDER].indexOf(input.selfRole);
  const selfNumber = fixed >= 0 ? fixed + 1 : Math.max(7, input.task?.nextTabNumber ?? 7);
  if (input.selfRole !== "main" && !existing.some((tab) => tab.role === "main"))
    tabs.push({
      number: 1,
      role: "main",
      roleLabel: TASK_TAB_ROLE_LABELS.main,
      provider: input.main?.provider ?? "",
      model: input.main?.model ?? "沿用 #1 模型",
      status: "未启动",
    });
  for (const role of FLOW_ROLE_ORDER) {
    if (role === input.selfRole || existing.some((tab) => tab.role === role)) continue;
    const preset = roleTabPreset(input.store, role, input);
    tabs.push({
      number: FLOW_ROLE_ORDER.indexOf(role) + 2,
      role,
      roleLabel: TASK_TAB_ROLE_LABELS[role],
      provider: preset?.model.provider ?? "",
      model: preset?.model.model || "沿用 #1 模型",
      status: roleTabDisabled(input.store, role, input) ? "未启用" : "未启动",
    });
  }
  return { tabs: tabs.sort((a, b) => a.number - b.number), selfNumber };
}

/** The roles task prompts name through `{{main}}`, `{{planner}}` … placeholders. */
export const ROLE_VAR_NAMES = [
  "main",
  "planner",
  "scout",
  "worker",
  "reviewer",
  "verifier",
] as const;
export type RoleVarName = (typeof ROLE_VAR_NAMES)[number];

/** `#n 标签` of the latest tab of each role, or `标签（未启用）` when the task has none. Shared by the
 *  position line and the role prompts' placeholders, so both always name the same tabs. */
export function roleVars(
  tabs: readonly { number: number; role: TaskTabRole }[],
): Record<RoleVarName, string> {
  const out = {} as Record<RoleVarName, string>;
  for (const role of ROLE_VAR_NAMES) {
    const tab = [...tabs].reverse().find((candidate) => candidate.role === role);
    out[role] = tab
      ? `#${tab.number} ${TASK_TAB_ROLE_LABELS[role]}`
      : `${TASK_TAB_ROLE_LABELS[role]}（未启用）`;
  }
  return out;
}

/** Position line injected into the tab's system prompt (upstream/downstream). */
export function rolePosition(
  role: TaskTabRole,
  selfNumber: number,
  tabs: readonly PlannedTabView[],
): string {
  const { main, planner, scout, worker, reviewer, verifier } = roleVars(tabs);
  if (role === "main")
    return `你是 #${selfNumber} 主会话（群主）。需求交给 ${planner} 出方案，调查交给 ${scout}，用户授权后由 ${worker} 执行；之后为 ${reviewer}、${verifier}。`;
  if (role === "planner")
    return `你是 #${selfNumber} 方案。上游：${main} 转达需求，用户也可以直接和你对话；调查可请 ${scout}；下游：用户确认后由 ${worker} 执行。`;
  if (role === "scout")
    return `你是 #${selfNumber} 探路（共享、只读调研）。任何 tab 都可以向你提问；结论发回提问的 tab，并给 ${main} 留摘要，不修改项目文件。`;
  if (role === "plan_reviewer")
    return `你是 #${selfNumber} 方案复核（只读审查）。上游：${planner}；审查意见交回 ${planner}，不修改项目文件。`;
  if (role === "worker")
    return `你是 #${selfNumber} 执行。上游：${planner}（方案，经用户确认）；下游：${reviewer}、${verifier}。交付后由插件启动复核与验证。`;
  if (role === "reviewer")
    return `你是 #${selfNumber} 复核（只读检查代码）。上游：${worker}；下游：${verifier}。`;
  if (role === "verifier")
    return `你是 #${selfNumber} 验证（只读核对证据）。上游：${worker}、${reviewer}；下游：用户确认「通过」后的 Git 收尾。`;
  return `你是 #${selfNumber} 会话。上游与下游按用户要求确定；用户说「继续 #n 的工作」时先用 vibe_tabs 找到对应 tab。`;
}

/** Task tabs that vibe-context should track (worker registers at admission instead). */
const SESSION_ROLE_BY_TAB: Partial<Record<TaskTabRole, SessionRole>> = {
  main: "planner",
  planner: "planner",
  scout: "scout",
};

/** Task tabs are ordinary agents; this registry only adds immutable numbers and titles. */
export function createTaskTabs(options: {
  store: VibeStore;
  getPaseo(): PaseoApi | null;
  sessions?: Pick<TaskRuntimeCommands, "registerSession" | "findSessionByAgent">;
  now?: () => number;
  log?: (message: string, error?: unknown) => void;
}) {
  const { store } = options;
  const now = options.now ?? (() => Date.now());
  const log =
    options.log ?? ((message, error) => console.error("[vibe-board]", message, error ?? ""));
  function paseo(): PaseoApi {
    const api = options.getPaseo();
    if (!api) throw new Error("任务宿主尚未连接");
    return api;
  }
  async function refreshAgent(
    agentId: string,
  ): Promise<{ handle: PaseoAgentHandle; agent: PaseoAgent }> {
    const handle = paseo().agents.ref(agentId);
    await handle.refresh();
    const agent = handle.current();
    if (!agent) throw new Error("找不到原生 agent：" + agentId);
    return { handle, agent };
  }
  const workspaces = new Map<string, Promise<ReturnType<PaseoApi["workspaces"]["ref"]>>>();
  function taskWorkspace(workspaceId: string) {
    const pending = workspaces.get(workspaceId);
    if (pending) return pending;
    // SDK workspace refresh scans the directory; concurrent readers share that scan.
    const run = (async () => {
      const placement = paseo().workspaces.ref(workspaceId);
      await placement.refresh();
      const current = placement.current();
      if (!current) throw new TaskWorkspaceUnavailableError("missing");
      if (current.archivingAt) throw new TaskWorkspaceUnavailableError("archived");
      try {
        assertTaskWorkspace(current);
      } catch {
        throw new TaskWorkspaceUnavailableError("not-worktree");
      }
      return placement;
    })().finally(() => {
      if (workspaces.get(workspaceId) === run) workspaces.delete(workspaceId);
    });
    workspaces.set(workspaceId, run);
    return run;
  }
  /** Opaque provider ids (`dfmodel`) get their catalog label (`DeepSeek-Flash`) in titles. */
  async function labelFor(provider: string, model: string): Promise<string | undefined> {
    try {
      const label = await providerModelLabel(paseo(), provider, model);
      return label && label !== model ? label : undefined;
    } catch {
      return undefined;
    }
  }
  /** Planner/scout sessions let vibe-context freeze and continue these tabs like a worker. */
  async function registerTabSession(
    workspaceId: string,
    tab: TaskTab,
    agent: PaseoAgent,
    projectId: string | null,
  ) {
    const sessions = options.sessions;
    const role = SESSION_ROLE_BY_TAB[tab.role];
    const model = agent.model?.trim() || (tab.model === UNRESOLVED_TAB_MODEL ? "" : tab.model);
    if (!sessions || !role || !model) return;
    try {
      if (sessions.findSessionByAgent(agent.id)) return;
      const task = store.tasks.get(workspaceId);
      if (!task) return;
      sessions.registerSession({
        workspaceId,
        projectId,
        agentId: agent.id,
        role,
        provider: agent.provider,
        model,
        thinking: agent.thinkingOptionId ?? tab.thinking,
        candidateIndex: 0,
        confirmedAt: task.confirmedAt ?? null,
      });
    } catch (error) {
      log("任务 tab 会话登记失败", error);
    }
  }
  /** Records a UI-created worktree so its first agent becomes tab #1; agent-created worktrees stay out. */
  const PENDING_WORKSPACE_TTL_MS = 5 * 60_000;
  const pendingWorktreeCreates = new Map<string, {
    at: number;
    flowLevel?: "simple" | "medium" | "full";
    source?: "user" | "bot";
    reason?: string;
  }>();
  function prunePending(nowMs: number): void {
    for (const [workspaceId, pending] of pendingWorktreeCreates) {
      if (nowMs - pending.at > PENDING_WORKSPACE_TTL_MS) pendingWorktreeCreates.delete(workspaceId);
    }
  }
  function trackWorkspaceCreate(request: PluginBeforeRequests["workspace.create"]): void {
    const source = request.source;
    if (source.kind !== "worktree" || request.callerAgentId) return;
    // Only the conversation-list "new workspace" form ships the first agent with the creation
    // request; `paseo workspace create` / `paseo agent run` create the workspace without one.
    if (!request.agent && !request.firstAgentContext) return;
    // Core hands the pre-allocated id to the hook; claiming by id avoids confusing concurrent
    // creations in the same project and entries for creations that never complete.
    if (!request.workspaceId) return;
    const nowMs = now();
    prunePending(nowMs);
    pendingWorktreeCreates.set(request.workspaceId, { at: nowMs, flowLevel: request.firstAgentContext?.flowLevel, source: "user" });
  }
  function setInitialFlow(workspaceId: string, input: { level: "simple" | "medium" | "full"; reason: string }): void {
    if (store.tasks.get(workspaceId)) {
      store.tasks.setFlow(workspaceId, { level: input.level, source: "bot", reason: input.reason });
      return;
    }
    prunePending(now());
    pendingWorktreeCreates.set(workspaceId, { at: now(), flowLevel: input.level, source: "bot", reason: input.reason });
  }
  function claimCreatedWorkspace(workspaceId: string): void {
    prunePending(now());
    if (!pendingWorktreeCreates.has(workspaceId)) return;
    store.tasks.markTaskWorkspace(workspaceId);
  }
  /** Old tasks predate the marker; the task row itself is the durable proof. */
  function isTaskWorkspace(workspaceId: string): boolean {
    if (store.tasks.isTaskWorkspace(workspaceId)) return true;
    if (!store.tasks.get(workspaceId)) return false;
    store.tasks.markTaskWorkspace(workspaceId);
    return true;
  }
  /** The tab's number as its tab-order key, so the workspace shows #1, #2 … in order. Hosts
   *  without label updates keep their default order. */
  async function syncTabOrder(handle: PaseoAgentHandle, agent: PaseoAgent, tab: TaskTab) {
    const order = String(tab.number);
    if (agent.labels?.[TAB_ORDER_LABEL] === order || !handle.setLabels) return;
    await handle.setLabels({ [TAB_ORDER_LABEL]: order }).catch((error) => {
      log("任务 tab 排序标签更新失败", error);
    });
  }
  async function syncResolvedModel(
    workspaceId: string,
    tab: TaskTab,
    agent: PaseoAgent,
    handle: PaseoAgentHandle,
  ) {
    const model = agent.model?.trim();
    if (!model || (model === tab.model && tab.modelLabel)) return tab;
    const modelLabel = await labelFor(agent.provider, model);
    if (model === tab.model && !modelLabel) return tab;
    const updated = store.tasks.updateTab(workspaceId, tab.agentId, {
      model,
      provider: agent.provider,
      modelLabel: modelLabel ?? null,
    });
    await handle.setTitle(tabTitle(updated)).catch((error) => {
      log("任务 tab 标题更新失败", error);
    });
    try {
      const placement = await taskWorkspace(workspaceId);
      await registerTabSession(workspaceId, updated, agent, placement.current()?.projectId ?? null);
    } catch {
      // A workspace that vanished keeps the tab row; session tracking is best effort.
    }
    return updated;
  }
  /** Allocates a number once per agent; subagents and archived agents stay out of the tab list.
   *  A role claim is accepted only from plugin code, never from agent-supplied labels. */
  function normalizeNumbers(task: Task): Task {
    const fixedRoles: readonly TaskTabRole[] = ["main", ...FLOW_ROLE_ORDER];
    const seen = new Set<TaskTabRole>();
    const used = new Set<number>();
    let extra = 7;
    for (const tab of [...task.tabs].sort((a, b) => a.number - b.number)) {
      const fixed = fixedRoles.indexOf(tab.role);
      let number = fixed >= 0 && !seen.has(tab.role) ? fixed + 1 : Math.max(7, tab.number);
      if (used.has(number)) {
        while (used.has(extra)) extra++;
        number = extra++;
      }
      seen.add(tab.role);
      used.add(number);
      if (tab.number !== number) store.tasks.updateTab(task.workspaceId, tab.agentId, { number });
    }
    return store.tasks.get(task.workspaceId)!;
  }
  async function ensureTab(
    agentId: string,
    claim: { role?: TaskTabRole; presetId?: string } = {},
  ): Promise<TaskTab | null> {
    const { handle, agent } = await refreshAgent(agentId);
    const workspaceId = agent.workspaceId;
    if (!workspaceId || agent.internal || agent.archivedAt || isSubagent(agent)) return null;
    let placement;
    try {
      placement = await taskWorkspace(workspaceId);
    } catch {
      return null;
    }
    if (!isTaskWorkspace(workspaceId)) return null;
    let task = store.tasks.get(workspaceId);
    if (!task) {
      task = store.tasks.create({ workspaceId, anchorAgentId: agentId });
      const pending = pendingWorktreeCreates.get(workspaceId);
      pendingWorktreeCreates.delete(workspaceId);
      if (pending?.flowLevel) {
        task = store.tasks.setFlow(workspaceId, { level: pending.flowLevel, source: pending.source ?? "user", reason: pending.reason ?? "用户新建任务时选择" });
        if (pending.flowLevel === "simple" && pending.source === "user") task = store.tasks.updateControl(workspaceId, { simpleAutoExecute: true });
      } else if (pending?.source === "user") {
        task = store.tasks.updateControl(workspaceId, { flowEvaluationPending: true, flowEvaluationAt: now() });
      }
    }
    // The native project of every task, so the cross-task plan list still finds it later.
    if (placement.projectId && task.control?.projectId !== placement.projectId)
      task = store.tasks.updateControl(workspaceId, { projectId: placement.projectId });
    if (task.tabs.length === 0 && task.anchorAgentId !== agentId) {
      // Backfill tasks created before tab numbering: the anchor is always #1.
      await ensureTab(task.anchorAgentId, { role: "main" }).catch((error) => {
        log("旧任务 #1 登记失败", error);
      });
      task = store.tasks.get(workspaceId)!;
    }
    task = normalizeNumbers(task);
    const existing = task.tabs.find((tab) => tab.agentId === agentId);
    if (existing) {
      const updates: {
        number?: number;
        role?: TaskTabRole;
        presetId?: string;
        model?: string;
        modelLabel?: string | null;
        provider?: string;
      } = {};
      if (claim.role && claim.role !== existing.role) {
        updates.role = claim.role;
        const fixed = ["main", ...FLOW_ROLE_ORDER].indexOf(claim.role);
        if (fixed >= 0) updates.number = fixed + 1;
      }
      if (claim.presetId && claim.presetId !== existing.presetId) updates.presetId = claim.presetId;
      const resolved = agent.model?.trim();
      if (resolved) {
        const modelLabel = await labelFor(agent.provider, resolved);
        if (resolved !== existing.model || modelLabel !== existing.modelLabel) {
          updates.model = resolved;
          updates.provider = agent.provider;
          updates.modelLabel = modelLabel ?? null;
        }
      }
      await syncTabOrder(handle, agent, existing);
      if (Object.keys(updates).length === 0) {
        await registerTabSession(
          workspaceId,
          existing,
          agent,
          placement.current()?.projectId ?? null,
        );
        return existing;
      }
      const updated = store.tasks.updateTab(workspaceId, agentId, updates);
      await syncTabOrder(handle, agent, updated);
      await handle.setTitle(tabTitle(updated)).catch((error) => {
        log("任务 tab 标题更新失败", error);
      });
      await registerTabSession(workspaceId, updated, agent, placement.current()?.projectId ?? null);
      return updated;
    }
    const role = claim.role ?? (agentId === task.anchorAgentId ? "main" : "session");
    const model = agent.model?.trim() || UNRESOLVED_TAB_MODEL;
    const fixed = ["main", ...FLOW_ROLE_ORDER].indexOf(role);
    const number =
      fixed >= 0 && !task.tabs.some((tab) => tab.role === role)
        ? fixed + 1
        : Math.max(7, task.nextTabNumber);
    const { tab } = store.tasks.allocateTab(workspaceId, {
      number,
      agentId,
      role,
      provider: agent.provider,
      model,
      thinking: agent.thinkingOptionId ?? undefined,
      ...(claim.presetId ? { presetId: claim.presetId } : {}),
    });
    await handle.setTitle(tabTitle(tab)).catch((error) => {
      log("任务 tab 标题设置失败（编号已保留）", error);
    });
    await syncTabOrder(handle, agent, tab);
    // The catalog lookup may be a cold provider discovery. Allocate first so a fast first turn
    // still finds its tab; the readable label lands in a second title update.
    let resolved = tab;
    const modelLabel = await labelFor(agent.provider, model);
    if (modelLabel) {
      resolved = store.tasks.updateTab(workspaceId, agentId, { modelLabel });
      await handle.setTitle(tabTitle(resolved)).catch((error) => {
        log("任务 tab 标题更新失败", error);
      });
    }
    await registerTabSession(workspaceId, resolved, agent, placement.current()?.projectId ?? null);
    return resolved;
  }
  async function tabsFor(task: Task, refresh: boolean): Promise<TaskTabView[]> {
    if (refresh && !task.tabs.some((tab) => tab.role === "main")) {
      try {
        await ensureTab(task.anchorAgentId, { role: "main" });
        task = store.tasks.get(task.workspaceId) ?? task;
      } catch (error) {
        log("旧任务主会话登记失败，保留完整流程占位", error);
      }
    }
    task = normalizeNumbers(task);
    const projectId = typeof task.control?.projectId === "string" ? task.control.projectId : null;
    const views: TaskTabView[] = await Promise.all(
      task.tabs.map(async (tab) => {
        if (tab.role !== "main" && FLOW_ROLE_ORDER.includes(tab.role as FlowRole) &&
            roleTabDisabled(store, tab.role as FlowRole, { task, projectId })) {
          return {
            number: tab.number, agentId: "", role: tab.role,
            roleLabel: TASK_TAB_ROLE_LABELS[tab.role], provider: tab.provider, model: tab.model,
            status: "未启用", title: tabTitle(tab), busy: false,
          };
        }
        let agent: PaseoAgent | undefined;
        let handle: PaseoAgentHandle | undefined;
        let current = tab;
        if (refresh) {
          try {
            const result = await refreshAgent(tab.agentId);
            agent = result.agent;
            handle = result.handle;
            current = await syncResolvedModel(task.workspaceId, tab, agent, handle);
            await syncTabOrder(handle, agent, current);
          } catch {
            agent = undefined;
          }
        }
        return {
          number: current.number,
          agentId: current.agentId,
          role: current.role,
          roleLabel:
            TASK_TAB_ROLE_LABELS[current.role] +
            (current.presetId === MAIN_FALLBACK_PRESET_ID ? " · 沿用 #1 模型" : ""),
          provider: agent?.provider ?? current.provider,
          model: agent?.model ?? current.model,
          modelId: agent?.model ?? current.model,
          status: agent ? statusOf(agent) : !refresh && task.phase === "queued" && current.role === "worker" ? "排队" : "已关闭",
          title: agent?.title ?? tabTitle(current),
          busy: !!agent?.activeTurn,
          thinking: current.thinking,
        };
      }),
    );
    if (!views.some((view) => view.role === "main")) views.push(missingMainTab(task, projectId));
    const main = views.find((view) => view.role === "main");
    for (const role of FLOW_ROLE_ORDER) {
      if (views.some((view) => view.role === role)) continue;
      const preset = roleTabPreset(store, role, { task, projectId, main });
      const disabled = roleTabDisabled(store, role, { task, projectId, main });
      const source = preset?.snapshot.source;
      const roleLabel =
        TASK_TAB_ROLE_LABELS[role] + (source === "main-fallback" ? " · 沿用 #1 模型" : "");
      const model = preset?.model.model || "沿用 #1 模型";
      views.push({
        number: FLOW_ROLE_ORDER.indexOf(role) + 2,
        agentId: "",
        role,
        roleLabel,
        provider: preset?.model.provider ?? "",
        model,
        modelId: preset?.model.model,
        thinking: preset?.model.thinking,
        source,
        status: disabled ? "未启用" : "未启动",
        title: `#${FLOW_ROLE_ORDER.indexOf(role) + 2} ${roleLabel} · ${model}`,
        busy: false,
      });
    }
    return views.sort((a, b) => a.number - b.number);
  }
  function missingMainTab(task: Task, projectId: string | null): TaskTabView {
    let config: { provider?: string; model?: string; thinkingOptionId?: string } = {};
    try {
      config = resolveMainConfig(store, projectId).config ?? {};
    } catch (error) {
      log("旧任务主会话默认模型解析失败", error);
    }
    const model = config.model ?? "默认模型";
    return {
      number: 1,
      agentId: task.anchorAgentId,
      role: "main",
      roleLabel: TASK_TAB_ROLE_LABELS.main,
      provider: config.provider ?? "",
      model,
      modelId: config.model,
      thinking: config.thinkingOptionId,
      status: "未启动",
      title: `#1 主会话 · ${model}`,
      busy: false,
    };
  }
  function rolePromptKey(role: TaskTabRole): string | undefined {
    if (role === "main" || role === "planner" || role === "scout" || role === "plan_reviewer")
      return "task.role." + role;
    if (role === "worker") return "board.task.work";
    if (role === "reviewer") return "verify.reviewer_system";
    if (role === "verifier") return "verify.verifier_system";
    return undefined;
  }
  function safeResolve(
    key: string,
    options: { projectId?: string | null; vars?: Record<string, string> },
  ): string {
    try {
      return store.prompts.resolve(key, options);
    } catch {
      return "";
    }
  }
  async function injectGuide(
    request: PluginBeforeRequests["agent.create"],
  ): Promise<PluginBeforeRequests["agent.create"]> {
    const workspaceId = request.workspaceId;
    if (!workspaceId) return request;
    const subagent = !!(request.labels?.[PARENT_AGENT_ID_LABEL] || request.parentAgentId);
    let placement;
    try {
      placement = await taskWorkspace(workspaceId);
    } catch {
      return request;
    }
    let task = store.tasks.get(workspaceId);
    if (task) isTaskWorkspace(workspaceId);
    else if (!store.tasks.isTaskWorkspace(workspaceId)) return request;
    task = store.tasks.get(workspaceId);
    const projectId = placement.projectId;
    const supplied = request.config.systemPrompt ?? "";
    if (subagent) {
      // Native subagents are spawned by the worker through create_agent; they are not task tabs,
      // but the task's 子任务 role rules still apply. #2's plan reviewers get the reviewer rules.
      const roleText = store.prompts.resolve(
        request.labels?.[PLAN_REVIEW_LABEL] ? "task.role.plan_reviewer" : "task.role.subagent",
        { projectId, vars: roleVars(task?.tabs ?? []) },
      );
      if (!roleText || supplied.includes(roleText)) return request;
      return {
        ...request,
        config: {
          ...request.config,
          systemPrompt: [roleText, supplied].filter(Boolean).join("\n\n"),
        },
      };
    }
    // A plugin-created tab declares its role through the plugin-owned environment (agent labels
    // alone are not trusted). A tab created by the user gets the planner rules only when it is
    // the task's first tab; later user tabs are plain sessions.
    const envRole = request.env?.VIBE_ROLE as TaskTabRole | undefined;
    const pluginRole =
      envRole && envRole !== "session" && Object.hasOwn(TASK_TAB_ROLE_LABELS, envRole)
        ? envRole
        : undefined;
    const role: TaskTabRole = pluginRole ?? (task?.tabs.length ? "session" : "main");
    const providerSpec = request.config.provider ?? "";
    const slash = providerSpec.indexOf("/");
    const modelId = slash >= 0 ? providerSpec.slice(slash + 1) : providerSpec;
    const { tabs: planned, selfNumber } = plannedTaskTabs({
      store,
      ...(task ? { task } : {}),
      projectId,
      selfRole: role,
      ...(role === "main"
        ? {
            main: {
              provider: slash >= 0 ? providerSpec.slice(0, slash) : providerSpec,
              model: modelId,
              thinking: request.config.thinkingOptionId ?? undefined,
            },
          }
        : {}),
    });
    // The role placeholders see the roster this tab will join, itself included.
    const roles = roleVars([...planned, { number: selfNumber, role }]);
    const guide = store.prompts.resolve(TASK_TAB_GUIDE_PROMPT.key, {
      projectId,
      vars: {
        ...roles,
        self: `#${selfNumber} ${TASK_TAB_ROLE_LABELS[role]}${modelId ? ` · ${modelId}` : ""}`,
        position: rolePosition(role, selfNumber, planned),
        tabs: formatTabs(planned),
      },
    });
    const roleKey = rolePromptKey(role);
    const roleText = roleKey
      ? safeResolve(roleKey, {
          projectId,
          vars: {
            ...roles,
            ...(role === "worker"
              ? {
                  plan: "（尚未收到执行确认。插件发来执行确认（方案与调度准入结果）之前不要修改任何文件；用户发送 /执行、在任务流程面板点「执行」，或直接在本 tab 发消息，插件完成调度准入后会发来执行确认。用户只是提问时先回答，不要改文件。）",
                  reason: "",
                }
              : {}),
          },
        })
      : "";
    const format =
      role === "planner" || role === "main" ? store.prompts.resolve("task.plan_format", { projectId }) : "";
    const parts = [guide, roleText, format].filter(
      (text): text is string => !!text && !supplied.includes(text),
    );
    return {
      ...request,
      config: {
        ...request.config,
        systemPrompt: [...parts, supplied].filter(Boolean).join("\n\n"),
      },
    };
  }
  async function status(workspaceId: string, agentId: string) {
    if (!store.tasks.get(workspaceId)) throw new Error("当前 workspace 不是 Vibe 任务");
    const task = store.tasks.get(workspaceId)!;
    const tabs = await tabsFor(task, true);
    const self = tabs.find((tab) => tab.agentId === agentId);
    const artifacts = store.taskArtifacts.list(workspaceId).slice(-3);
    const lines = [
      `任务阶段：${TASK_PHASE_LABELS[task.phase]}`,
      `方案：${task.plan?.goal ?? "尚未保存完整方案"}`,
      self ? `当前 tab：#${self.number} ${self.roleLabel}` : "当前 tab：未登记",
      "任务 tab：",
      formatTabs(tabs),
    ];
    if (task.control?.directInstruction)
      lines.push("执行依据：无方案，按用户在执行 tab 的指示执行");
    const board = store.taskBoard.list(workspaceId);
    if (board.length) lines.push(boardProgress(board));
    if (task.control?.blockingReason) lines.push(`阻塞：${String(task.control.blockingReason)}`);
    if (task.summary) lines.push(`最新结论：${task.summary}`);
    for (const artifact of artifacts) lines.push(`沉淀（${artifact.kind}）：${artifact.summary}`);
    return { task, tabs, text: lines.join("\n") };
  }
  // Every user-visible status is its own row (unique id): the daemon merges same-id rows at the
  // first row's position, so a reused id would surface a new status above newer history and erase
  // the old one. Repeats are suppressed in memory instead: the same text in the same tab within
  // 30 seconds is skipped. Expired entries are pruned on every append and a closed tab is
  // forgotten, so the map stays bounded.
  const STATUS_DEDUPE_MS = 30_000;
  const lastStatus = new Map<string, { text: string; at: number }>();
  // The id of each tab's latest status row, so a caller can replace that row in place (`replace`)
  // while nothing else was appended after it. Returns the row id, or undefined when deduplicated.
  const lastRow = new Map<string, string>();
  async function appendStatus(
    agentId: string,
    text: string,
    options: { replace?: string } = {},
  ): Promise<string | undefined> {
    const nowMs = now();
    for (const [id, entry] of lastStatus)
      if (nowMs - entry.at >= STATUS_DEDUPE_MS) lastStatus.delete(id);
    const previous = lastStatus.get(agentId);
    if (previous && previous.text === text) return undefined;
    const id = options.replace ?? "task-status:" + randomUUID();
    await paseo().agents.ref(agentId).timeline.append({
      type: "plugin",
      id,
      kind: "task-status",
      version: 1,
      data: { text },
    });
    lastStatus.set(agentId, { text, at: nowMs });
    lastRow.set(agentId, id);
    return id;
  }
  function lastStatusId(agentId: string): string | undefined {
    return lastRow.get(agentId);
  }
  function forgetStatus(agentIds: Iterable<string>) {
    for (const agentId of agentIds) {
      lastStatus.delete(agentId);
      lastRow.delete(agentId);
    }
  }
  async function vibeTabs(callerAgentId: string) {
    const { agent } = await refreshAgent(callerAgentId);
    if (!agent.workspaceId) throw new Error("当前 agent 不属于任务 workspace");
    const { task, tabs } = await status(agent.workspaceId, agent.id);
    return {
      workspaceId: agent.workspaceId,
      phase: task.phase,
      plan: task.plan?.goal ?? null,
      self: tabs.find((tab) => tab.agentId === agent.id)?.number ?? null,
      tabs: tabs.map((tab) => ({
        number: tab.number,
        agentId: tab.agentId,
        role: tab.role,
        roleLabel: tab.roleLabel,
        provider: tab.provider,
        model: tab.model,
        status: tab.status,
      })),
    };
  }
  /** Opens a plugin-owned tab. Agents cannot reach this surface; `vibe_open_tab` enforces the role. */
  async function openTab(
    callerAgentId: string,
    input: {
      role: "scout" | "plan_reviewer" | "session";
      task: string;
      provider?: string;
      presetId?: string;
    },
  ) {
    const { agent: caller } = await refreshAgent(callerAgentId);
    const workspaceId = caller.workspaceId;
    if (!workspaceId) throw new Error("当前 agent 不属于任务 workspace");
    if (!isTaskWorkspace(workspaceId)) throw new Error("当前 workspace 不是 Vibe 任务");
    const task = store.tasks.get(workspaceId);
    if (!task) throw new Error("任务尚未登记主会话");
    const preset = input.presetId ? store.presets.get(input.presetId) : undefined;
    if (input.presetId && !preset) throw new Error("预设不存在或不可用：" + input.presetId);
    const spec =
      input.provider?.trim() ||
      (preset ? `${preset.provider}/${preset.model}` : "") ||
      (caller.model ? `${caller.provider}/${caller.model}` : "");
    if (!/^[^/]+\/[^/]+$/.test(spec))
      throw new Error(
        "无法解析当前 tab 的 provider/model，请在调用时指定 provider（provider/model）",
      );
    const placement = await taskWorkspace(workspaceId);
    const projectId = placement.projectId;
    const roleKey = rolePromptKey(input.role);
    const roleText = roleKey
      ? store.prompts.resolve(roleKey, { projectId, vars: roleVars(task.tabs) })
      : "";
    const prompt = [roleText, preset?.instructions, input.task.trim()].filter(Boolean).join("\n\n");
    const config: Record<string, unknown> = { provider: spec };
    if (preset?.thinking && preset.thinking !== "default")
      config.thinkingOptionId = preset.thinking;
    if (preset?.fastMode) config.featureValues = { fast_mode: true };
    const handle = await paseo()
      .workspaces.ref(workspaceId)
      .agents.create({
        config: config as never,
        env: {
          VIBE_ROLE: input.role,
          VIBE_WORKSPACE_ID: workspaceId,
          ...(preset?.runtimeEnv ? { VIBE_RUNTIME_ENV: preset.runtimeEnv } : {}),
        },
        labels: {
          [TASK_TAB_ROLE_LABEL]: input.role,
          ...(input.presetId ? { [TASK_TAB_PRESET_LABEL]: input.presetId } : {}),
        },
      });
    const tab = await ensureTab(handle.id, { role: input.role, presetId: input.presetId });
    if (!tab) throw new Error("新 tab 未登记到任务");
    // The task text is agent-to-agent context, never a user turn: provenance keeps it out of
    // the user-message lane so it cannot authorise acceptance or handoff.
    await handle.send(prompt, { sourceAgentId: callerAgentId });
    return { agentId: handle.id, number: tab.number, role: tab.role, title: tabTitle(tab) };
  }
  return {
    injectGuide,
    ensureTab,
    openTab,
    tabsFor,
    status,
    appendStatus,
    lastStatusId,
    forgetStatus,
    vibeTabs,
    formatTabs,
    workspace: taskWorkspace,
    trackWorkspaceCreate,
    claimCreatedWorkspace,
    setInitialFlow,
  };
}
export type TaskTabs = ReturnType<typeof createTaskTabs>;
