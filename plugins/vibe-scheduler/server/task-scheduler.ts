// Task resource leases. Only the scheduler owns admission; native conversations stay in Paseo.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  MODEL_ROLES,
  TaskSchema,
  validateTaskSubtaskPresets,
  presetModels,
  TaskPresetSnapshotSchema,
  findTaskActualPreset,
  type ModelRole,
  type Project,
  type TaskPresetSnapshot,
  type Task,
  type ProviderQuota,
} from "./vibe/contract";
import { createTaskRuntimeCommands, readResourceMeta, writeResourceMeta, type DeviceLeases, type createVibeStore } from "./vibe/db";
import { type PortAllocator } from "./ports";
import { findOverlap } from "./overlap";
import { deviceKindFor, type SchedulerConfig } from "./scheduler";
import { quotaFor } from "./quota";

type Store = ReturnType<typeof createVibeStore>;
export type ResourceRole = ModelRole | "master";
export interface NativeAgentState {
  id: string;
  workspaceId?: string;
  cwd: string;
  provider: string;
  model: string | null;
  status: string;
  activeTurn?: unknown;
  archivedAt?: string | null;
  labels?: Record<string, string>;
}
export interface NativeTaskWorkspace {
  workspaceId: string;
  projectId: string;
  directory: string;
  archived: boolean;
  agents: NativeAgentState[];
}
export interface TaskResourceRequest {
  requestId: string;
  workspaceId: string;
  action: "acquire" | "bind" | "yield" | "release" | "freeze" | "reconcile";
  role?: ResourceRole;
  subtaskId?: string;
  agentId?: string;
  reservationId?: string;
  candidateIndex?: number;
  presetId?: string;
  provider?: string;
  model?: string;
  files?: string[];
  hostLease?: boolean;
  operation?: "send" | "compact" | "create";
}
const LeaseSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  confirmedAt: z.string().nullable(),
  projectId: z.string().nullable(),
  repo: z.string(),
  directory: z.string(),
  role: z.enum([...MODEL_ROLES, "master"]),
  subtaskId: z.string().nullable(),
  agentId: z.string().nullable(),
  presetId: z.string(),
  provider: z.string(),
  model: z.string(),
  files: z.array(z.string()),
  access: z.enum(["write", "read", "verify"]),
  slot: z.boolean(),
  frozen: z.boolean(),
  hostOperation: z.boolean().default(false),
  pendingCreate: z.boolean().optional(),
  port: z.number(),
  deviceIds: z.array(z.string()),
});
export type TaskResourceLease = z.infer<typeof LeaseSchema>;
export interface TaskResourceResult {
  requestId: string;
  workspaceId: string;
  ok: boolean;
  reason: string;
  retryable?: boolean;
  reservationId?: string;
  presetId?: string;
  provider?: string;
  model?: string;
  port?: number;
  deviceIds?: string[];
}
export interface TaskSchedulerDeps {
  store: Store;
  leases: DeviceLeases;
  ports: PortAllocator;
  file?: string;
  config: () => SchedulerConfig;
  now: () => Date;
  memory: () => number | null;
  quota: () => Record<string, ProviderQuota>;
  /** null means a successful host query confirmed absence; unavailable hosts must throw. */
  native: (workspaceId: string) => Promise<NativeTaskWorkspace | null>;
  log?: (message: string) => void;
  identity?: (directory: string) => Promise<{ repo: string; directory: string }>;
  emit: (type: string, payload: Record<string, unknown>) => void;
}
const canonical = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
export async function repositoryIdentity(directory: string) {
  const root = canonical(await realpath(directory));
  const common = await new Promise<string>((done, fail) => {
    execFile(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: root },
      (error, stdout) => {
        if (error) fail(error);
        else done(stdout.trim());
      },
    );
  });
  return { repo: canonical(await realpath(resolve(root, common))), directory: root };
}
/** Invalid/unknown or external symlink ranges take the entire repository. */
export async function normalizeTaskFiles(
  files: readonly string[],
  directory: string,
): Promise<string[]> {
  if (!files.length) return ["**"];
  const output: string[] = [];
  for (const raw of files) {
    const value = raw.trim().replace(/\\/g, "/");
    if (!value || isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.split("/").includes(".."))
      return ["**"];
    const parts = value.split("/").filter((part) => part && part !== ".");
    const wildcard = parts.findIndex((part) => /[*?[{!]/.test(part));
    // Complex glob syntax is conservative; the shared overlap matcher handles *, ** and ?.
    if (parts.some((part) => /[{}!]/.test(part) || part.includes("[") || part.includes("]")))
      return ["**"];
    let count = wildcard < 0 ? parts.length : wildcard;
    let prefix = "";
    while (count > 0) {
      try {
        prefix = await realpath(resolve(directory, ...parts.slice(0, count)));
        break;
      } catch {
        count--;
      }
    }
    const rel = relative(directory, prefix || directory).replace(/\\/g, "/");
    if (isAbsolute(rel) || rel === ".." || rel.startsWith("../")) return ["**"];
    output.push([rel, ...parts.slice(count)].filter(Boolean).join("/") || "**");
  }
  return [...new Set(output)];
}
export const nativeStopped = (agent: NativeAgentState) =>
  ["idle", "closed", "error"].includes(agent.status) && !agent.activeTurn;

const PARENT_AGENT_LABEL = "paseo.parent-agent-id";
/** Numbered task tabs are ordinary agents; their user/agent turns stay advisory, while
 * flow-owned worker/reviewer/verifier turns still bind an explicit lease. */
function advisoryTab(task: Task, agent: NativeAgentState) {
  if (agent.labels?.[PARENT_AGENT_LABEL]) return true;
  return task.tabs.some((tab) => tab.agentId === agent.id);
}

export function createTaskScheduler(deps: TaskSchedulerDeps) {
  const held = new Map<string, TaskResourceLease>();
  const identity = deps.identity ?? repositoryIdentity;
  let recoveryError: string | null = null;
  let restored = false;
  let startup = true;
  const recoveryLogs = new Map<string, number>();
  let startupDeferred: Record<string, string> = {};
  let serial = Promise.resolve();
  let lastDeferred: Record<string, string> = {};
  let paused = false;
  if (deps.file && existsSync(deps.file)) {
    try {
      const rows = z.array(LeaseSchema).parse(JSON.parse(readFileSync(deps.file, "utf8")));
      for (const row of rows) held.set(row.id, { ...row, frozen: true });
      restored = rows.length > 0;
    } catch {
      recoveryError = "资源租约文件不可读，暂停新派发，需核对原生运行状态";
    }
  }
  const save = () => {
    if (!deps.file) return;
    mkdirSync(dirname(deps.file), { recursive: true });
    const temp = deps.file + ".tmp";
    writeFileSync(temp, JSON.stringify([...held.values()], null, 2));
    try {
      renameSync(temp, deps.file);
    } catch (error) {
      recoveryError = "资源租约保存失败，暂停新派发";
      throw error;
    }
  };
  const exclusive = <T>(run: () => Promise<T>): Promise<T> => {
    const result = serial.then(run);
    serial = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const updateMemory = () => {
    const memory = deps.memory();
    const wasPaused = paused;
    if (memory !== null) {
      if (memory >= deps.config().memoryThreshold) paused = true;
      else if (memory < deps.config().memoryThreshold - 0.05) paused = false;
    }
    if (paused !== wasPaused) {
      if (paused) deps.emit("scheduler.paused", { reason: "memory", mem: memory, top: [] });
      else deps.emit("scheduler.resumed", { reason: "memory" });
    }
  };
  function runningCounts() {
    const byProvider: Record<string, number> = {};
    const byProject: Record<string, number> = {};
    let total = 0;
    for (const row of held.values())
      if (row.slot) {
        total++;
        byProvider[row.provider] = (byProvider[row.provider] ?? 0) + 1;
        if (row.projectId) byProject[row.projectId] = (byProject[row.projectId] ?? 0) + 1;
      }
    // The bots migration can run after the scheduler starts. Count durable routine runs
    // once its tables exist, so task admission shares the same capacity.
    if (deps.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='bot_routine_run'").get()) {
      const routines = deps.store.db.prepare<{ provider: string | null; project_id: string | null }>(
        "SELECT r.provider, b.project_id FROM bot_routine_run r JOIN bot_routine t ON t.id=r.routine_id JOIN bot b ON b.id=t.bot_id WHERE r.status='running'",
      ).all();
      for (const routine of routines) {
        total++;
        if (routine.provider) byProvider[routine.provider] = (byProvider[routine.provider] ?? 0) + 1;
        if (routine.project_id) byProject[routine.project_id] = (byProject[routine.project_id] ?? 0) + 1;
      }
    }
    return { total, byProvider, byProject };
  }
  const result = (
    request: TaskResourceRequest,
    ok: boolean,
    reason: string,
    row?: TaskResourceLease,
    retryable = false,
  ): TaskResourceResult => ({
    requestId: request.requestId,
    workspaceId: request.workspaceId,
    ok,
    reason,
    retryable,
    ...(row
      ? {
          reservationId: row.id,
          presetId: row.presetId,
          provider: row.provider,
          model: row.model,
          port: row.port,
          deviceIds: row.deviceIds,
        }
      : {}),
  });
  function release(row: TaskResourceLease) {
    held.delete(row.id);
    deps.ports.release(row.id);
    for (const lease of deps.leases.activeLeases()) {
      const owned =
        lease.session_id === "scheduler-task:" + row.id ||
        lease.session_id?.startsWith("scheduler-task-device:" + row.workspaceId + ":");
      if (owned && ![...held.values()].some((other) => other.deviceIds.includes(lease.device_id)))
        deps.leases.release(lease.id);
    }
    save();
  }
  const validTask = (task: Task | undefined) =>
    task &&
    TaskSchema.safeParse(task).success &&
    task.confirmedAt &&
    task.plan &&
    task.rolesSnapshot;
  async function nativeFor(workspaceId: string) {
    const workspace = await deps.native(workspaceId);
    if (!workspace || workspace.archived)
      throw new Error("原生 workspace 不可用或已归档，请先恢复原生 workspace");
    return workspace;
  }
  async function freeze(workspaceId: string, reason: string) {
    for (const row of held.values()) if (row.workspaceId === workspaceId) row.frozen = true;
    const task = deps.store.tasks.get(workspaceId);
    if (task && !["completed", "failed"].includes(task.phase)) {
      deps.store.tasks.setPhase(workspaceId, "paused");
      deps.store.tasks.setSummary(workspaceId, reason);
    }
    save();
  }
  function abandonWorkspace(workspaceId: string) {
    const task = deps.store.tasks.get(workspaceId);
    if (task && !["completed", "failed"].includes(task.phase)) {
      // Match vibe-board's archived workspace marker and its abandoned plan status.
      deps.store.tasks.updateControl(workspaceId, { archivedAt: deps.now().toISOString() });
      deps.store.tasks.setPhase(workspaceId, "failed");
      deps.store.tasks.setSummary(workspaceId, "原生工作区不存在或已归档，任务已放弃");
      deps.log?.("原生工作区不存在或已归档，任务已放弃并释放资源：" + workspaceId);
    }
    for (const row of held.values()) if (row.workspaceId === workspaceId) release(row);
    recoveryLogs.delete(workspaceId);
  }
  async function reconcile(workspaceId?: string) {
    const targets = new Set(
      [...held.values()]
        .filter((row) => !workspaceId || row.workspaceId === workspaceId)
        .map((row) => row.workspaceId),
    );
    if (workspaceId) targets.add(workspaceId);
    for (const id of targets) {
      const workspace = await deps.native(id);
      if (!workspace || workspace.archived) {
        abandonWorkspace(id);
        continue;
      }
      const rows = [...held.values()].filter((row) => row.workspaceId === id);
      for (const row of rows) {
        const agent = row.agentId
          ? workspace.agents.find((entry) => entry.id === row.agentId)
          : null;
        if (
          (row.frozen && agent && nativeStopped(agent)) ||
          (row.frozen && !agent && row.pendingCreate) ||
          (!row.agentId && !(row.hostOperation && row.access === "verify") && workspace.agents.every(nativeStopped))
        )
          release(row);
      }
      if (rows.some((row) => row.frozen))
        await freeze(
          id,
          "重启或停止后已核对原生会话；请确认资源状态后重新执行，未确认停止的资源继续保留",
        );
    }
    restored = false;
  }
  class ResourceDenied extends Error {
    constructor(
      message: string,
      readonly retryable = false,
    ) {
      super(message);
    }
  }
  const block = (reason: string, retryable = false): never => {
    throw new ResourceDenied(reason, retryable);
  };
  const planningRole = (role: ResourceRole) => ["planner", "scout", "plan_reviewer"].includes(role);
  function taskFor(request: TaskResourceRequest, role: ResourceRole) {
    const task = deps.store.tasks.get(request.workspaceId);
    if (role === "master") return { task, planning: false };
    if (request.operation === "compact") {
      const session = request.agentId
        ? createTaskRuntimeCommands(deps.store.db).findSessionByAgent(request.agentId)
        : null;
      if (
        !task ||
        !session ||
        session.workspaceId !== request.workspaceId ||
        session.role !== role ||
        session.currentProvider !== request.provider ||
        session.model !== request.model
      )
        block("压缩成员与已登记任务模型不一致");
      return { task, planning: true };
    }
    const planning =
      !!task && ["planning", "awaiting_confirmation"].includes(task.phase) && planningRole(role);
    if (planning) return { task, planning };
    if (!validTask(task)) block("任务没有有效确认快照");
    validateTaskSubtaskPresets(task!.plan!, task!.rolesSnapshot!);
    if (!["queued", "executing", "reviewing", "verifying"].includes(task!.phase))
      block("当前阶段不能执行");
    return { task, planning };
  }
  function subtaskPreset(task: Task, subtaskId: string | undefined) {
    const base = task.rolesSnapshot!.subagent;
    const item = task.plan!.subtasks.find((entry) => entry.id === subtaskId);
    if (!item) block("方案里没有该子任务");
    if (!item!.presetId) return base;
    const frozen = task.rolesSnapshot!.subtaskPresets?.[item!.id];
    if (frozen) {
      if (frozen.presetId !== item!.presetId) block("子任务冻结预设与确认方案不一致，请重新确认");
      return frozen;
    }
    if (item!.presetId !== base.presetId)
      block("子任务自定义预设缺少确认时快照，请重新确认，不能使用实时预设");
    return base;
  }
  function modelFor(
    request: TaskResourceRequest,
    role: ResourceRole,
    task: Task | undefined,
    planning: boolean,
  ) {
    let preset: TaskPresetSnapshot | null = null;
    const actual =
      task && request.agentId && role !== "master" && request.operation !== "compact"
        ? findTaskActualPreset(task, { agentId: request.agentId, role })
        : undefined;
    if (actual) preset = actual;
    else if (role !== "master" && !planning) {
      preset =
        role === "subagent" ? subtaskPreset(task!, request.subtaskId) : task!.rolesSnapshot![role];
      if (!preset) block("此角色未启用");
      // Explicit handover changes the next member's model, never the confirmed scope.
      if (request.presetId && request.presetId !== preset!.presetId) {
        const override = deps.store.presets.get(request.presetId);
        if (!override) block("接手预设不存在或不可用");
        preset = TaskPresetSnapshotSchema.parse({
          presetId: override!.id,
          source: "task",
          models: presetModels(override!),
          environmentKind: override!.environmentKind,
          runtimeEnv: override!.runtimeEnv,
          instructions: override!.instructions,
        });
      }
    }
    let model: { provider: string; model: string };
    if (preset) {
      const index =
        request.candidateIndex ??
        preset.models.findIndex(
          (candidate) => quotaFor(deps.quota(), candidate.provider).level !== "exhausted",
        );
      const selected = preset.models[index];
      if (!selected) block("模型候选不存在或已耗尽");
      model = selected;
    } else {
      if (!request.provider || request.model === undefined) block("缺少实际模型");
      model = { provider: request.provider!, model: request.model! };
    }
    return { preset, model };
  }
  function filesFor(
    request: TaskResourceRequest,
    role: ResourceRole,
    task: Task | undefined,
    planning: boolean,
  ) {
    if (role === "master") return request.files ?? [];
    if (planning) return [];
    if (role !== "subagent") return task!.plan!.files;
    const item = task!.plan!.subtasks.find((entry) => entry.id === request.subtaskId);
    if (!item) block("方案里没有该子任务");
    const runs = new Map(task!.subtaskRuns.map((run) => [run.subtaskId, run.state]));
    if (item!.dependsOn.some((id) => runs.get(id) !== "completed")) block("子任务依赖尚未完成");
    return item!.files;
  }
  function checkCapacity(provider: string, projectId: string | null) {
    const counts = runningCounts();
    const config = deps.config();
    if (counts.total >= config.globalLimit) block("已达全局并发上限 " + config.globalLimit, true);
    const limit = config.providerLimits[provider];
    if (limit !== undefined && (counts.byProvider[provider] ?? 0) >= limit)
      block(provider + " 已达并发上限 " + limit, true);
    if (projectId) {
      const project = deps.store.projectConfigs.get(projectId);
      if (
        project?.concurrencyLimit != null &&
        (counts.byProject[projectId] ?? 0) >= project.concurrencyLimit
      )
        block("已达项目并发上限 " + project.concurrencyLimit, true);
    }
    if (quotaFor(deps.quota(), provider).level === "exhausted")
      block(provider + " 额度已用完", true);
  }
  function checkFiles(
    repo: string,
    files: string[],
    access: TaskResourceLease["access"],
    ownId?: string,
  ) {
    for (const other of held.values()) {
      if (other.id === ownId || !other.slot || other.repo !== repo) continue;
      let conflict = access === "verify" && other.access === "write";
      if (access === "write")
        conflict =
          other.access === "verify" ||
          (other.access === "write" && !!findOverlap(files, other.files));
      if (conflict) block("文件范围与运行会话冲突：" + other.workspaceId + "/" + other.role, true);
    }
  }
  function accessFor(role: ResourceRole, hostOperation: boolean): TaskResourceLease["access"] {
    if (hostOperation) return "write";
    if (role === "verifier") return "verify";
    return ["worker", "subagent"].includes(role) ? "write" : "read";
  }
  function checkExisting(
    request: TaskResourceRequest,
    role: ResourceRole,
    model: { provider: string; model: string },
  ) {
    const existing = [...held.values()].find(
      (entry) =>
        entry.workspaceId === request.workspaceId &&
        entry.role === role &&
        entry.subtaskId === (request.subtaskId ?? null),
    );
    if (!existing) return;
    if (existing.frozen) block("旧会话停止尚未确认，保留资源并暂停派发");
    if (existing.slot) block("同一角色/子任务已有准入，请使用原 reservationId，不可重复派发");
    if (existing.provider !== model.provider || existing.model !== model.model)
      block("切换模型前须停止并释放旧会话");
    return existing;
  }
  async function acquireDevice(
    row: TaskResourceLease,
    kind: ReturnType<typeof deviceKindFor>,
    project: Project | undefined,
  ) {
    if (!kind || row.deviceIds.length) return;
    const owner = "scheduler-task-device:" + row.workspaceId + ":" + kind;
    const mine = deps.leases.activeLeases().find((lease) => lease.session_id === owner);
    if (mine) {
      row.deviceIds.push(mine.device_id);
      return;
    }
    const preferred = project?.devices.length ? project.devices : [undefined];
    try {
      for (const device of preferred) {
        const lease = deps.leases.tryAcquire({
          kind,
          sessionId: owner,
          preferredDeviceId: device,
          ttlMs: 0,
        });
        if (lease) {
          row.deviceIds.push(lease.deviceId);
          return;
        }
      }
    } catch {
      block("未登记可用的 " + kind + " 设备");
    }
    block("没有空闲的 " + kind + " 设备", true);
  }
  async function admissionWorkspace(
    request: TaskResourceRequest,
    master: boolean,
    hostOperation: boolean,
  ) {
    const workspace = await nativeFor(request.workspaceId);
    const workspacePaths = await identity(workspace.directory);
    const project = deps.store.projectConfigs.get(workspace.projectId);
    const paths = hostOperation && project ? await identity(project.repoPath) : workspacePaths;
    if (paths.repo !== workspacePaths.repo) block("项目主检出与任务的仓库身份不一致");
    if (!master) {
      const registered = new Set(
        [...held.values()].filter((row) => row.slot).map((row) => row.agentId),
      );
      const task = deps.store.tasks.get(request.workspaceId);
      if (
        workspace.agents.some(
          (agent) =>
            !nativeStopped(agent) &&
            !registered.has(agent.id) &&
            (!task || !advisoryTab(task, agent)),
        )
      ) {
        await freeze(
          request.workspaceId,
          "发现未经资源准入的原生回合，已暂停派发；先停止并核对该会话",
        );
        block("发现未经准入的原生回合");
      }
    }
    return { workspace, paths, project };
  }
  function newResourceLease(input: {
    request: TaskResourceRequest;
    task: Task | undefined;
    projectId: string | null;
    paths: { repo: string; directory: string };
    role: ResourceRole;
    preset: TaskPresetSnapshot | null;
    model: { provider: string; model: string };
    ranges: string[];
    access: TaskResourceLease["access"];
    hostOperation: boolean;
  }): TaskResourceLease {
    const { request, task, projectId, paths, role, preset, model, ranges, access, hostOperation } =
      input;
    return {
      id: randomUUID(),
      workspaceId: request.workspaceId,
      confirmedAt: task?.confirmedAt ?? null,
      projectId,
      ...paths,
      role,
      subtaskId: request.subtaskId ?? null,
      agentId: null,
      presetId: preset?.presetId ?? request.presetId ?? role,
      provider: model.provider,
      model: model.model,
      files: ranges,
      access,
      slot: true,
      frozen: false,
      hostOperation,
      port: 0,
      deviceIds: [],
    };
  }
  function requestKind(request: TaskResourceRequest, role: ResourceRole) {
    const master = role === "master";
    const hostOperation = (master || role === "verifier") && request.hostLease === true;
    if (request.files?.length && !hostOperation)
      block("只有显式 master hostLease 可申请插件文件写锁");
    if (hostOperation && master && !request.files?.length) block("插件文件写锁必须声明文件范围");
    if (hostOperation && role === "verifier" && request.files?.length) block("验证写屏障覆盖整个仓库");
    if (
      request.subtaskId &&
      role !== "subagent" &&
      !["scout", "plan_reviewer", "reviewer"].includes(role)
    )
      block("该角色不支持多个并行资源身份");
    return { master, hostOperation };
  }
  async function activateLease(row: TaskResourceLease, validateTask: boolean) {
    row.slot = true;
    held.set(row.id, row);
    try {
      row.port = await deps.ports.allocate(row.id);
      if (validateTask) {
        const currentTask = deps.store.tasks.get(row.workspaceId);
        if (
          currentTask?.confirmedAt !== row.confirmedAt ||
          !["queued", "executing", "reviewing", "verifying"].includes(currentTask.phase)
        ) {
          row.frozen = true;
          save();
          block("准入期间任务确认或阶段已变化，保留资源等待核对");
        }
      }
      save();
    } catch (error) {
      if (!row.frozen) release(row);
      if (error instanceof ResourceDenied) throw error;
      block(error instanceof Error ? error.message : String(error), !recoveryError);
    }
  }
  async function acquire(request: TaskResourceRequest): Promise<TaskResourceResult> {
    updateMemory();
    if (recoveryError) block(recoveryError);
    if (restored) await reconcile();
    if (paused) block("内存超过阈值，暂停放行", true);
    if (!request.role) block("缺少角色");
    const role = request.role!;
    const { master, hostOperation } = requestKind(request, role);
    const { task, planning } = taskFor(request, role);
    const hostVerification = hostOperation && role === "verifier";
    if (hostVerification && (task?.flowLevel !== "simple" || task.phase !== "executing"))
      block("宿主自测写屏障仅用于执行中的简单流程");
    const { preset, model } = hostVerification
      ? { preset: null, model: { provider: "host", model: "verification" } }
      : modelFor(request, role, task, planning);
    const existing = checkExisting(request, role, model);
    const { workspace, paths, project } = await admissionWorkspace(request, master, hostOperation && !hostVerification);
    const projectId = master ? null : workspace.projectId;
    checkCapacity(model.provider, projectId);
    const access = hostVerification ? "verify" : request.operation === "compact" ? "read" : accessFor(role, hostOperation);
    const files = filesFor(request, role, task, planning);
    const ranges = master && !hostOperation ? [] : await normalizeTaskFiles(files, paths.directory);
    checkFiles(paths.repo, ranges, access, existing?.id);
    const row =
      existing ??
      newResourceLease({
        request,
        task,
        projectId,
        paths,
        role,
        preset,
        model,
        ranges,
        access,
        hostOperation,
      });
    const kind = role === "verifier" ? null : deviceKindFor(preset?.runtimeEnv);
    await acquireDevice(row, kind, project);
    const deviceBusy = row.deviceIds.some((id) =>
      [...held.values()].some(
        (other) => other.id !== row.id && other.slot && other.deviceIds.includes(id),
      ),
    );
    if (deviceBusy) block("本任务设备仍被其它会话使用，等待它让出资源", true);
    await activateLease(row, !master && !planning);
    return result(request, true, "已准入", row);
  }
  async function boundMatches(row: TaskResourceLease, agent: NativeAgentState, task: Task) {
    if (!row.slot || row.frozen || row.provider !== agent.provider) return false;
    if (row.model && agent.model && row.model !== agent.model) return false;
    if (canonical(await realpath(agent.cwd)) !== row.directory) return false;
    return planningRole(row.role) || row.confirmedAt === task.confirmedAt;
  }
  async function adoptNativeTurn(
    workspace: NativeTaskWorkspace,
    task: Task,
    agent: NativeAgentState,
  ) {
    const paths = await identity(workspace.directory);
    const planner =
      agent.id === task.anchorAgentId && ["planning", "awaiting_confirmation"].includes(task.phase);
    let permitted = false;
    if (planner && !paused) {
      try {
        checkCapacity(agent.provider, workspace.projectId);
        checkFiles(paths.repo, ["**"], "write");
        permitted = true;
      } catch (error) {
        if (!(error instanceof ResourceDenied)) throw error;
      }
    }
    const emergency: TaskResourceLease = {
      id: randomUUID(),
      workspaceId: workspace.workspaceId,
      confirmedAt: task.confirmedAt,
      projectId: workspace.projectId,
      ...paths,
      role: planner ? "planner" : "worker",
      subtaskId: null,
      agentId: agent.id,
      presetId: permitted ? "native-planner" : "unregistered",
      provider: agent.provider,
      model: agent.model ?? "",
      files: ["**"],
      access: "write",
      slot: true,
      frozen: !permitted,
      hostOperation: false,
      port: 0,
      deviceIds: [],
    };
    held.set(emergency.id, emergency);
    save();
    return permitted;
  }
  async function observeAgent(workspaceId: string, agentId: string): Promise<boolean> {
    const task = deps.store.tasks.get(workspaceId);
    if (!task) return true;
    const row = [...held.values()].find(
      (entry) => entry.workspaceId === workspaceId && entry.agentId === agentId,
    );
    const workspace = await deps.native(workspaceId);
    const agent = workspace?.agents.find((entry) => entry.id === agentId);
    if (!workspace || !agent) {
      await freeze(workspaceId, "原生回合状态不可读，冻结新派发并保留资源");
      return false;
    }
    if (row?.pendingCreate) {
      row.pendingCreate = false;
      save();
    }
    if (row && (await boundMatches(row, agent, task))) return true;
    if (nativeStopped(agent)) return false;
    if (!row && advisoryTab(task, agent)) return true;
    if (row) {
      row.slot = true;
      row.frozen = true;
    } else if (await adoptNativeTurn(workspace, task, agent)) return true;
    await freeze(
      workspaceId,
      "检测到未经准入或已让出名额的原生回合，已冻结新派发并请求停止；停止确认前保留资源",
    );
    return false;
  }
  async function recoverNativeTasks() {
    if (!startup) return true;
    const deferred: Record<string, string> = {};
    const reconcileRestored = restored;
    const targets = new Set([...held.values()].map((row) => row.workspaceId));
    for (const task of deps.store.tasks.list())
      if (task.confirmedAt && !["completed", "failed"].includes(task.phase))
        targets.add(task.workspaceId);
    // Unconfirmed drafts without leases cannot own a dispatch slot.
    for (const workspaceId of targets) {
      try {
        const workspace = await deps.native(workspaceId);
        if (!workspace || workspace.archived) {
          abandonWorkspace(workspaceId);
          continue;
        }
        for (const agent of workspace.agents)
          if (!nativeStopped(agent)) await observeAgent(workspaceId, agent.id);
        if (reconcileRestored) await reconcile(workspaceId);
        recoveryLogs.delete(workspaceId);
      } catch (error) {
        const reason = "无法核对原生任务状态，等待宿主恢复：" + workspaceId;
        deferred[workspaceId] = reason;
        const now = deps.now().getTime();
        const previous = recoveryLogs.get(workspaceId);
        if (previous === undefined || now - previous >= 60_000) {
          recoveryLogs.set(workspaceId, now);
          deps.log?.(reason + "；" + (error instanceof Error ? error.message : String(error)));
        }
      }
    }
    startupDeferred = deferred;
    if (Object.keys(deferred).length) {
      restored = reconcileRestored;
      return false;
    }
    startup = false;
    return true;
  }
  function bindPlannedLease(request: TaskResourceRequest, row: TaskResourceLease) {
    const planned = request.agentId
      ? createTaskRuntimeCommands(deps.store.db).findSessionByAgent(request.agentId)
      : null;
    if (
      !planned ||
      planned.workspaceId !== row.workspaceId ||
      planned.role !== row.role ||
      planned.currentProvider !== row.provider ||
      planned.model !== row.model
    )
      block("待创建成员与资源登记不一致");
    if (row.agentId && row.agentId !== request.agentId) block("旧原生 agent 尚未释放");
    row.agentId = request.agentId!;
    row.pendingCreate = true;
    save();
    return result(request, true, "已登记待创建的原生成员", row);
  }
  async function bindLease(
    request: TaskResourceRequest,
    row: TaskResourceLease,
    workspace: NativeTaskWorkspace,
  ) {
    if (row.frozen || !row.slot) block("资源未准入或已冻结");
    const agent = workspace.agents.find((entry) => entry.id === request.agentId);
    if (!agent && request.agentId) {
      // Admission runs before host member creation. Only the owner command's exact registration
      // may bind that reserved identity; no provider request has started at this point.
      return bindPlannedLease(request, row);
    }
    if (agent?.archivedAt) block("原生 agent 已归档，请先通过原生恢复再绑定");
    if (!agent || agent.workspaceId !== row.workspaceId)
      block("原生 agent 的 workspace 与准入不一致");
    if (canonical(await realpath(agent!.cwd)) !== row.directory || agent!.provider !== row.provider)
      block("原生 agent 的目录或 provider 与准入不一致");
    if (row.model && agent!.model && agent!.model !== row.model)
      block("原生 agent 的模型与准入不一致");
    if (row.agentId && row.agentId !== agent!.id) block("旧原生 agent 尚未释放");
    row.agentId = agent!.id;
    row.pendingCreate = false;
    save();
    return result(request, true, "已登记原生 agent", row);
  }
  async function finishLease(
    request: TaskResourceRequest,
    row: TaskResourceLease,
    workspace: NativeTaskWorkspace,
  ) {
    if (row.hostOperation && request.action === "release" && (!row.frozen || row.access === "verify")) {
      release(row);
      return result(request, true, "插件文件操作已完成，写锁已释放");
    }
    if (request.action === "release" && !row.agentId && workspace.agents.every(nativeStopped)) {
      release(row);
      return result(request, true, "未绑定资源且原生任务成员均已停止，资源已释放");
    }
    const agent = workspace.agents.find((entry) => entry.id === row.agentId);
    if (!agent && row.pendingCreate && request.action === "release") {
      release(row);
      return result(request, true, "预创建成员未产生原生agent，资源已释放");
    }
    if (!agent || !nativeStopped(agent)) {
      row.frozen = true;
      await freeze(row.workspaceId, "停止未确认，继续保留文件锁、并发、设备与端口");
      return result(request, false, "停止未确认，资源继续保留", row);
    }
    if (request.action === "yield") {
      row.slot = false;
      save();
      return result(request, true, "已让出计算名额和写锁，重新工作须再次准入", row);
    }
    release(row);
    return result(request, true, "原生停止已确认，资源已释放");
  }
  async function resourceAction(request: TaskResourceRequest): Promise<TaskResourceResult> {
    if (!(await recoverNativeTasks())) block(Object.values(startupDeferred)[0]!, true);
    if (request.action === "acquire") return acquire(request);
    if (request.action === "freeze") {
      await freeze(request.workspaceId, "已撤销排队和新派发；等待原生停止确认，资源继续保留");
      return result(request, true, "已冻结派发，未提前释放资源");
    }
    if (request.action === "reconcile") {
      await reconcile(request.workspaceId);
      const remains = [...held.values()].some(
        (entry) => entry.workspaceId === request.workspaceId && entry.frozen,
      );
      if (remains) return result(request, false, "仍有未确认停止的会话，保留资源");
      return result(request, !recoveryError, recoveryError ?? "原生状态已核对");
    }
    const row = request.reservationId ? held.get(request.reservationId) : undefined;
    if (!row || row.workspaceId !== request.workspaceId) block("资源租约不存在");
    const workspace = await nativeFor(row!.workspaceId);
    if (request.action === "bind") return bindLease(request, row!, workspace);
    return finishLease(request, row!, workspace);
  }
  async function requestResource(request: TaskResourceRequest): Promise<TaskResourceResult> {
    return exclusive(async () => {
      try {
        return await resourceAction(request);
      } catch (error) {
        return result(
          request,
          false,
          error instanceof Error ? error.message : String(error),
          undefined,
          error instanceof ResourceDenied && error.retryable,
        );
      }
    });
  }
  function waitingTasks(): Task[] {
    const waiting = deps.store.tasks.list({ phase: "queued" }).filter(
      (task) => ![...held.values()].some(
        (row) => row.workspaceId === task.workspaceId && row.role === "worker",
      ),
    );
    const order = z.array(z.string()).parse(
      readResourceMeta(deps.store.db, "scheduler.queue_order", []),
    );
    const positions = new Map(order.map((id, index) => [id, index]));
    return waiting.sort((a, b) =>
      (positions.get(a.workspaceId) ?? Number.MAX_SAFE_INTEGER) -
      (positions.get(b.workspaceId) ?? Number.MAX_SAFE_INTEGER) ||
      (a.confirmedAt ?? "").localeCompare(b.confirmedAt ?? "") ||
      a.workspaceId.localeCompare(b.workspaceId),
    );
  }
  async function setQueueOrder(workspaceIds: string[], reason: string) {
    return exclusive(async () => {
      const ids = [...new Set(workspaceIds)];
      if (ids.length !== workspaceIds.length) throw new Error("队列中不能重复指定任务");
      const waiting = waitingTasks();
      for (const id of ids) {
        const task = waiting.find((entry) => entry.workspaceId === id);
        if (!task || !validTask(task)) throw new Error("只能调整已确认且等待派发的任务：" + id);
      }
      // Explicit user priorities precede all unspecified tasks, which retain FIFO order.
      writeResourceMeta(deps.store.db, "scheduler.queue_order", ids);
      writeResourceMeta(deps.store.db, "scheduler.queue_order_reason", reason);
      return { workspaceIds: waitingTasks().map((task) => task.workspaceId), reason };
    });
  }
  async function tick() {
    return exclusive(async () => {
      if (!(await recoverNativeTasks())) {
        lastDeferred = startupDeferred;
        return { admitted: [], deferred: startupDeferred, paused };
      }
      updateMemory();
      const admitted: Array<TaskResourceResult & { confirmedAt: string }> = [];
      const deferred: Record<string, string> = {};
      const waiting = waitingTasks();
      const valid = waiting.filter((task) => {
        if (validTask(task)) return true;
        deferred[task.workspaceId] = "任务没有有效确认快照";
        return false;
      });
      for (const task of valid) {
        const input: TaskResourceRequest = {
          requestId: "admit:" + task.workspaceId,
          workspaceId: task.workspaceId,
          action: "acquire",
          role: "worker",
        };
        let output: TaskResourceResult;
        try {
          output = await acquire(input);
        } catch (error) {
          output = result(
            input,
            false,
            error instanceof Error ? error.message : String(error),
            undefined,
            error instanceof ResourceDenied && error.retryable,
          );
        }
        if (!output.ok) {
          deferred[task.workspaceId] = output.reason;
          continue;
        }
        admitted.push({ ...output, confirmedAt: task.confirmedAt! });
        deps.emit("scheduler.task_admitted", {
          workspaceId: task.workspaceId,
          confirmedAt: task.confirmedAt,
          role: "worker",
          reservationId: output.reservationId,
          presetId: output.presetId,
          provider: output.provider,
          model: output.model,
          port: output.port,
          deviceIds: output.deviceIds,
        });
      }
      lastDeferred = deferred;
      return { admitted, deferred, paused };
    });
  }
  return {
    tick,
    withAdmissionLock: <T>(run: () => Promise<T>) => exclusive(run),
    requestResource,
    setQueueOrder,
    runningCounts,
    async endNativePlanner(workspaceId: string, agentId: string) {
      const row = [...held.values()].find(
        (entry) =>
          entry.workspaceId === workspaceId &&
          entry.agentId === agentId &&
          entry.presetId === "native-planner",
      );
      if (row)
        return requestResource({
          requestId: "planner-ended:" + agentId,
          workspaceId,
          action: "release",
          reservationId: row.id,
        });
      return null;
    },
    observeAgent: (workspaceId: string, agentId: string) =>
      exclusive(() => observeAgent(workspaceId, agentId)),
    status: () => ({
      paused,
      recovering: startup,
      pending: [...held.values()],
      deferred: lastDeferred,
      running: runningCounts(),
      recoveryError,
      queue: waitingTasks().filter(validTask).map((task) => ({
        workspaceId: task.workspaceId,
        goal: task.plan?.goal ?? "",
        confirmedAt: task.confirmedAt,
      })),
      queueOrderReason: readResourceMeta(deps.store.db, "scheduler.queue_order_reason", ""),
    }),
    targets: () =>
      [...held.values()].map((row) => ({
        sessionId: row.agentId ?? row.id,
        workspaceId: row.workspaceId,
        path: row.directory,
      })),
    isPaused: () => paused,
    canStartEmulator: () => !paused,
  };
}
