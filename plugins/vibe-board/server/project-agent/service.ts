import { cacheHostRead, listHostProjects } from "../host-data";
import { reviewActive } from "../tabs/plan-review";
import { createInputPersistence, PROJECT_INPUT_BYTES } from "./inputs";
import { randomUUID } from "node:crypto";
import type {
  PaseoApi,
  PaseoAgent,
  PaseoProject,
  PaseoAgentSendOptions,
  PaseoAgentConfig,
  PaseoProviderSnapshotResult,
} from "@getpaseo/client";
import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import type { VibeDb, VibeStore } from "../vibe/db";
import {
  presetModels,
  presetModeId,
  taskPlanStatus,
  planFiles,
  PLAN_STATUS_LABELS,
  UNRESOLVED_TAB_MODEL,
} from "../vibe/contract";
import { findProjectConfig } from "../vibe/db/project-config";
import type { TaskTabs } from "../tabs/service";
import type { TaskFlow } from "../tabs/flow";
import {
  PROJECT_AGENT_ROLE_LABEL,
  PROJECT_AGENT_PROJECT_LABEL,
  type ProjectAgentState,
} from "../../shared/project-agent";
import { PROJECT_AGENT_PROMPT } from "./prompts";

interface ProjectAgentOptions {
  db: VibeDb;
  store: VibeStore;
  getPaseo(): PaseoApi | null;
  tabs: TaskTabs;
  flow: Pick<TaskFlow, "provisionTabs">;
}
type UserInput = PluginLifecycleEvents["agent.user_prompt_received"];
interface Grant {
  input: UserInput;
  spent: boolean;
  busy: boolean;
  destination?: string;
  workspaceId?: string;
  mainId?: string;
}
interface SelectedModel {
  config: PaseoAgentConfig;
  runtimeEnv?: string;
}

/** Only a successful native user delivery creates authority. Model text never does. */
export function createProjectAgents(options: ProjectAgentOptions) {
  const { store } = options;
  const pending = new Map<string, Promise<ProjectAgentState>>();
  const errors = new Map<string, string>();
  const completed = new Map<string, { state: ProjectAgentState; expiresAt: number }>();
  // Retry the exact request: the host fingerprints keyed creates and may finish
  // after a client timeout. Archiving the known agent starts a new generation.
  const creations = new Map<string, Parameters<PaseoApi["agents"]["create"]>[0]>();
  const grants = new Map<string, Map<string, Grant>>();
  const persistence = createInputPersistence(options.db);
  function inputsFor(agentId: string): Map<string, Grant> {
    let inputs = grants.get(agentId);
    if (!inputs) {
      inputs = new Map(
        persistence
          .read(agentId)
          .map((entry) => [entry.input.messageId, { ...entry, busy: false }]),
      );
      grants.set(agentId, inputs);
    }
    return inputs;
  }
  function persist(agentId: string) {
    persistence.write(agentId, [...inputsFor(agentId).values()]);
  }
  function paseo(): PaseoApi {
    const api = options.getPaseo();
    if (!api) throw new Error("项目宿主尚未连接");
    return api;
  }
  async function project(projectId: string): Promise<PaseoProject> {
    const list = await listHostProjects(paseo());
    const found = list.projects.find((entry) => entry.projectId === projectId);
    if (!found) throw new Error("项目不存在或已归档");
    return found;
  }
  async function agent(agentId: string): Promise<PaseoAgent | null> {
    const handle = paseo().agents.ref(agentId);
    await handle.refresh();
    return handle.current();
  }
  async function projectForAgent(agentId: string): Promise<string | null> {
    const current = await agent(agentId);
    if (!current || current.archivedAt || current.labels[PROJECT_AGENT_ROLE_LABEL] !== "project")
      return null;
    const projectId = current.labels[PROJECT_AGENT_PROJECT_LABEL];
    if (!projectId || !current.workspaceId) return null;
    const workspace = paseo().workspaces.ref(current.workspaceId);
    await workspace.refresh();
    return workspace.projectId === projectId ? projectId : null;
  }
  async function callerProject(agentId: string | undefined): Promise<string> {
    if (!agentId) throw new Error("工具仅供项目 agent 使用");
    const projectId = await projectForAgent(agentId);
    if (!projectId) throw new Error("工具仅供项目 agent 使用，任务 tab 无权调用");
    await project(projectId);
    return projectId;
  }
  const knownAgents = new Map<string, string>();
  const discoveries = new Map<string, () => Promise<PaseoAgent | null>>();
  async function discover(projectId: string): Promise<PaseoAgent | null> {
    let cursor: string | undefined;
    do {
      const page = await paseo().agents.list({
        filter: {
          labels: {
            [PROJECT_AGENT_ROLE_LABEL]: "project",
            [PROJECT_AGENT_PROJECT_LABEL]: projectId,
          },
        },
        includeBackground: true,
        page: { limit: 200, ...(cursor ? { cursor } : {}) },
      });
      const found = page.entries.find(
        ({ agent: item }) =>
          !item.archivedAt &&
          item.labels[PROJECT_AGENT_ROLE_LABEL] === "project" &&
          item.labels[PROJECT_AGENT_PROJECT_LABEL] === projectId,
      );
      if (found) {
        knownAgents.set(projectId, found.agent.id);
        return found.agent;
      }
      cursor = page.pageInfo.nextCursor ?? undefined;
    } while (cursor);
    return null;
  }
  async function find(projectId: string): Promise<PaseoAgent | null> {
    const known = knownAgents.get(projectId);
    if (known) {
      const current = await agent(known);
      if (
        current && !current.archivedAt &&
        current.labels[PROJECT_AGENT_ROLE_LABEL] === "project" &&
        current.labels[PROJECT_AGENT_PROJECT_LABEL] === projectId
      ) return current;
      knownAgents.delete(projectId);
      creations.delete(projectId);
      discoveries.delete(projectId);
    }
    let read = discoveries.get(projectId);
    if (!read) {
      read = cacheHostRead(() => discover(projectId), 15_000);
      discoveries.set(projectId, read);
    }
    return read();
  }
  const stateReads = new Map<string, () => Promise<ProjectAgentState>>();
  function stateOf(projectId: string, current: PaseoAgent | null): ProjectAgentState {
    let status: ProjectAgentState["status"] = current ? "ready" : "idle";
    if (errors.has(projectId)) status = "failed";
    return {
      status,
      agentId: current?.id ?? null,
      workspaceId: current?.workspaceId ?? null,
      error: errors.get(projectId) ?? current?.lastError ?? null,
    };
  }
  function state(projectId: string): Promise<ProjectAgentState> {
    if (pending.has(projectId)) return Promise.resolve(creatingState());
    const finished = completed.get(projectId);
    if (finished && Date.now() < finished.expiresAt) return Promise.resolve(finished.state);
    completed.delete(projectId);
    let read = stateReads.get(projectId);
    if (!read) {
      read = cacheHostRead(async () => {
        await project(projectId);
        return stateOf(projectId, await find(projectId));
      }, 15_000);
      stateReads.set(projectId, read);
    }
    return read();
  }
  async function model(
    projectId: string,
    root: string,
    role: "project" | "main" = "project",
  ): Promise<SelectedModel> {
    const config = findProjectConfig(store.projects.list(true), projectId, root);
    const id = config?.defaultPresets[role] ?? store.modelDefaults.global()[role];
    if (id) {
      const preset = store.presets.get(id);
      if (!preset) throw new Error("项目 agent 的预设不存在：" + id);
      const first = presetModels(preset)[0];
      if (!first) throw new Error("项目 agent 的预设没有模型");
      const modeId =
        role === "project" ? presetModeId(first.provider, first.permissionMode) : undefined;
      return {
        config: {
          provider: first.provider + "/" + first.model,
          ...(first.thinking ? { thinkingOptionId: first.thinking } : {}),
          ...(modeId ? { modeId } : {}),
          ...(preset.instructions ? { systemPrompt: preset.instructions } : {}),
        },
        ...(preset.runtimeEnv ? { runtimeEnv: preset.runtimeEnv } : {}),
      };
    }
    if (role === "project") {
      const tasks = await projectTasks(projectId);
      const latest = tasks.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))[0];
      const main = latest?.tabs.find((tab) => tab.number === 1);
      if (main?.provider && main.model && main.model !== UNRESOLVED_TAB_MODEL)
        return {
          config: {
            provider: main.provider + "/" + main.model,
            ...(main.thinking ? { thinkingOptionId: main.thinking } : {}),
          },
        };
    }
    return defaultProviderModel(root);
  }
  async function cachedSnapshot(cwd?: string): Promise<PaseoProviderSnapshotResult | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        paseo().providers.snapshot({ ...(cwd ? { cwd } : {}), cachedOnly: true }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("缓存模型目录查询超时")), 1_500);
        }),
      ]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  async function defaultProviderModel(root: string): Promise<SelectedModel> {
    // Neither read starts provider discovery. An initializing provider must not hide
    // the usable cached catalog of another provider or the global scope.
    const snapshots = await Promise.all([cachedSnapshot(root), cachedSnapshot()]);
    const entries = new Map((snapshots[1]?.entries ?? []).map((entry) => [entry.provider, entry]));
    for (const entry of snapshots[0]?.entries ?? []) {
      const usable = entry.enabled && (entry.status === "ready" || entry.status === "loading") &&
        entry.models?.some((candidate) => candidate.isSelectable !== false && candidate.id.trim());
      if (usable || !entries.has(entry.provider)) entries.set(entry.provider, entry);
    }
    for (const entry of entries.values()) {
      if (!entry.enabled || (entry.status !== "ready" && entry.status !== "loading")) continue;
      const models = (entry.models ?? []).filter(
        (candidate) => candidate.isSelectable !== false && candidate.id.trim(),
      );
      const selected = models.find((candidate) => candidate.isDefault) ?? models[0];
      if (selected) return { config: { provider: entry.provider + "/" + selected.id } };
    }
    throw new Error("缓存中没有可用 provider 的模型，请到「任务默认模型」选择具体模型后重试");
  }
  async function openNow(projectId: string): Promise<ProjectAgentState> {
    const native = await project(projectId);
    const existing = await find(projectId);
    if (existing) return stateOf(projectId, existing);
    let request = creations.get(projectId);
    if (!request) {
      const selected = await model(projectId, native.projectRootPath);
      const prompt = store.prompts.resolve(PROJECT_AGENT_PROMPT.key, { projectId });
      request = {
        idempotencyKey: "project-agent:" + projectId + ":" + randomUUID(),
        cwd: native.projectRootPath,
        title: "项目 agent",
        config: {
          ...selected.config,
          systemPrompt: [prompt, selected.config.systemPrompt].filter(Boolean).join("\n\n"),
        },
        env: {
          VIBE_ROLE: "project",
          VIBE_PROJECT_ID: projectId,
          ...(selected.runtimeEnv ? { VIBE_RUNTIME_ENV: selected.runtimeEnv } : {}),
        },
        labels: { [PROJECT_AGENT_ROLE_LABEL]: "project", [PROJECT_AGENT_PROJECT_LABEL]: projectId },
      };
      creations.set(projectId, request);
    }
    const created = await paseo().agents.create(request);
    // Remember creation before any further reads: a slow refresh must never cause
    // retry to create a second native agent.
    errors.delete(projectId);
    knownAgents.set(projectId, created.id);
    discoveries.delete(projectId);
    stateReads.delete(projectId);
    return { status: "ready", agentId: created.id, workspaceId: created.workspaceId, error: null };
  }
  function creatingState(): ProjectAgentState {
    return { status: "creating", agentId: null, workspaceId: null, error: null };
  }
  function startOpen(projectId: string): Promise<ProjectAgentState> {
    const active = pending.get(projectId);
    if (active) return active;
    errors.delete(projectId);
    completed.delete(projectId);
    stateReads.delete(projectId);
    const job = Promise.resolve().then(() => openNow(projectId)).catch((cause: unknown) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      let error = "创建项目 agent 失败，请检查 provider 是否可用后重试";
      if (/^(项目|主机|缓存|无法取得)/.test(message)) error = message;
      if (/timeout|timed out|超时/i.test(message)) error = "创建项目 agent 超时，请稍后重试";
      errors.set(projectId, error);
      return { status: "failed" as const, agentId: null, workspaceId: null, error };
    }).then((result) => {
      completed.set(projectId, {
        state: result,
        expiresAt: result.status === "failed" ? Infinity : Date.now() + 15_000,
      });
      stateReads.delete(projectId);
      return result;
    }).finally(() => {
      if (pending.get(projectId) === job) pending.delete(projectId);
    });
    pending.set(projectId, job);
    return job;
  }
  function open(projectId: string): Promise<ProjectAgentState> {
    void startOpen(projectId);
    return Promise.resolve(creatingState());
  }
  async function placement(workspaceId: string) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        options.tabs.workspace(workspaceId),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("任务工作区查询超时")), 1_500);
        }),
      ]);
    } catch {
      // Names and legacy project inference are best effort. Failure means unknown, never deletion.
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  async function projectTasks(projectId: string) {
    const all = store.tasks.list();
    const owners = await Promise.all(
      all.map(async (task) => {
        if (typeof task.control?.projectId === "string") return task.control.projectId;
        return (await placement(task.workspaceId))?.projectId ?? null;
      }),
    );
    return all.filter((_task, index) => owners[index] === projectId);
  }
  async function tasksFor(callerAgentId: string) {
    const projectId = await callerProject(callerAgentId);
    const tasks = await projectTasks(projectId);
    const plans = await Promise.all(
      tasks.map(async (task) => {
        const workspace = await placement(task.workspaceId);
        const status = taskPlanStatus(task, !!task.control?.archivedAt);
        const review = reviewActive(task);
        return {
          workspaceId: task.workspaceId,
          agentId: task.anchorAgentId,
          name: workspace?.name ?? task.workspaceId,
          workspaceAvailable: workspace !== null,
          phase: task.phase,
          status,
          statusLabel: PLAN_STATUS_LABELS[status],
          goal: review?.goal ?? task.plan?.goal ?? task.summary,
          files: planFiles(review?.draftPlan ?? task.plan),
          updatedAt: task.updatedAt,
        };
      }),
    );
    return {
      projectId,
      plans,
      pendingInputs: [...inputsFor(callerAgentId).values()]
        .filter((entry) => !entry.spent)
        .map((entry) => ({ messageId: entry.input.messageId, text: entry.input.text })),
    };
  }
  async function received(input: UserInput) {
    if (!(await projectForAgent(input.agentId))) return;
    const inputs = inputsFor(input.agentId);
    if (inputs.has(input.messageId)) return;
    const item: Grant = { input, spent: false, busy: false };
    if (Buffer.byteLength(JSON.stringify([item]), "utf8") > PROJECT_INPUT_BYTES) {
      await appendStatus(
        input.agentId,
        "这条需求和附件超过 8 MiB 待路由缓存上限，请在目标任务 #1 重发；本条不能通过项目工具转发。",
      );
      return;
    }
    inputs.set(input.messageId, item);
    let evicted = false;
    while (
      inputs.size > 20 ||
      Buffer.byteLength(JSON.stringify([...inputs.values()]), "utf8") > PROJECT_INPUT_BYTES
    ) {
      const oldest = [...inputs].find(([, entry]) => !entry.busy)?.[0];
      if (!oldest) break;
      evicted ||= !inputs.get(oldest)!.spent;
      inputs.delete(oldest);
    }
    persist(input.agentId);
    if (evicted)
      await appendStatus(
        input.agentId,
        "待路由需求缓存已达上限（20 条 / 8 MiB），最早未路由需求已移出；如仍需处理，请重新发送原话和附件。",
      );
  }
  function grant(agentId: string, text: string, sourceMessageId?: string): Grant {
    const inputs = [...inputsFor(agentId).values()];
    const matches = inputs.filter(
      (entry) =>
        !entry.spent &&
        entry.input.text === text &&
        (!sourceMessageId || entry.input.messageId === sourceMessageId),
    );
    if (matches.length !== 1 || matches[0]!.busy)
      throw new Error(
        "只能逐字转发项目 agent 收到的真实用户消息；系统或 agent 消息不能授权。同文多条时请指定 sourceMessageId",
      );
    matches[0]!.busy = true;
    return matches[0]!;
  }
  function sendOptions(input: UserInput): PaseoAgentSendOptions {
    return {
      messageId: "project-route:" + input.messageId,
      ...(input.images?.length ? { images: input.images } : {}),
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    };
  }
  async function appendStatus(agentId: string, text: string): Promise<void> {
    await paseo()
      .agents.ref(agentId)
      .timeline.append({
        type: "plugin",
        id: "project-status:" + randomUUID(),
        kind: "task-status",
        version: 1,
        data: { text },
      });
  }
  async function routed(agentId: string, target: string, workspaceId: string, name: string) {
    const text = "已转给 " + name + " #1";
    await paseo()
      .agents.ref(agentId)
      .timeline.append({
        type: "plugin",
        id: "project-route:" + randomUUID(),
        kind: "project-route",
        version: 1,
        data: { text, agentId: target, workspaceId },
      });
    return { agentId: target, workspaceId, message: text };
  }
  async function route(
    callerAgentId: string,
    input: { workspaceId: string; text: string; sourceMessageId?: string },
  ) {
    const projectId = await callerProject(callerAgentId);
    const source = grant(callerAgentId, input.text, input.sourceMessageId);
    try {
      const tasks = await projectTasks(projectId);
      const target = tasks.find((task) => task.workspaceId === input.workspaceId);
      if (!target || target.control?.archivedAt) throw new Error("只能转给本项目未归档任务");
      const current = await agent(target.anchorAgentId);
      if (!current || current.archivedAt || current.status === "closed")
        throw new Error("目标任务 #1 已关闭或归档");
      const destination = "route:" + target.workspaceId;
      if (source.destination && source.destination !== destination)
        throw new Error("这条消息已开始投递到其它任务，请先完成原投递");
      source.destination = destination;
      persist(callerAgentId);
      await paseo()
        .agents.ref(target.anchorAgentId)
        .send(source.input.text, sendOptions(source.input));
      source.spent = true;
      source.input = { ...source.input, images: undefined, attachments: undefined };
      persist(callerAgentId);
      const workspace = await placement(target.workspaceId);
      return routed(
        callerAgentId,
        target.anchorAgentId,
        target.workspaceId,
        workspace?.name ?? target.workspaceId,
      );
    } finally {
      source.busy = false;
    }
  }

  async function create(
    callerAgentId: string,
    input: { text: string; name?: string; sourceMessageId?: string },
  ) {
    const projectId = await callerProject(callerAgentId);
    const source = grant(callerAgentId, input.text, input.sourceMessageId);
    try {
      const native = await project(projectId);
      const selected = await model(projectId, native.projectRootPath, "main");
      if (source.destination && source.destination !== "create")
        throw new Error("这条消息已开始投递到现有任务");
      source.destination = "create";
      persist(callerAgentId);
      const workspace = source.workspaceId
        ? paseo().workspaces.ref(source.workspaceId)
        : await paseo().workspaces.create({
            idempotencyKey: "project-task:" + source.input.messageId,
            source: { kind: "worktree", projectId, cwd: native.projectRootPath },
            ...(input.name ? { title: input.name } : {}),
          });
      source.workspaceId = workspace.id;
      persist(callerAgentId);
      store.tasks.markTaskWorkspace(workspace.id);
      const main = source.mainId
        ? paseo().agents.ref(source.mainId)
        : await workspace.agents.create({
            idempotencyKey: "project-main:" + source.input.messageId,
            config: selected.config,
            env: selected.runtimeEnv ? { VIBE_RUNTIME_ENV: selected.runtimeEnv } : {},
          });
      source.mainId = main.id;
      persist(callerAgentId);
      await options.tabs.ensureTab(main.id);
      await options.flow.provisionTabs(workspace.id);
      await main.send(source.input.text, sendOptions(source.input));
      source.spent = true;
      source.input = { ...source.input, images: undefined, attachments: undefined };
      persist(callerAgentId);
      return routed(callerAgentId, main.id, workspace.id, workspace.name ?? workspace.id);
    } finally {
      source.busy = false;
    }
  }

  async function sendProject(projectId: string, text: string): Promise<void> {
    const opened = await startOpen(projectId);
    if (!opened.agentId) throw new Error(opened.error ?? "未能打开项目 agent");
    await paseo().agents.ref(opened.agentId).send(text, { sourceAgentId: opened.agentId });
  }
  return {
    open,
    state,
    project,
    projectForAgent,
    callerProject,
    tasksFor,
    received,
    route,
    create,
    sendProject,
    appendStatus,
    setError(projectId: string, error: string | null) {
      stateReads.delete(projectId);
      completed.delete(projectId);
      if (error) errors.set(projectId, error);
      else errors.delete(projectId);
    },
  };
}
export type ProjectAgents = ReturnType<typeof createProjectAgents>;
