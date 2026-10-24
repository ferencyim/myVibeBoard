import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { PaseoApi, PaseoAgentHandle } from "@getpaseo/client";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import {
  TaskRoleSnapshotSchema,
  TASK_TAB_PRESET_LABEL,
  TASK_TAB_ROLE_LABEL,
  findTaskActualPreset,
  freezeTaskSubtaskPresets,
  parseTaskPlan,
  validateTaskSubtaskPresets,
  TASK_PLAN_PROMPT,
  type Task,
  type TaskPlan,
  type TaskPlanSource,
  type TaskPresetSnapshot,
  type TaskRoleSnapshot,
  type TaskTab,
} from "../vibe/contract";
import { createTaskRuntimeCommands, type VibeDb, type VibeStore } from "../vibe/db";
import { createTaskResources } from "../task-host/resources";
import { modeIdFor } from "../task-host/permission";
import { createTaskGitFinalizer, type GitState } from "../task-conversation/git";
import { TASK_FLOW_PROMPTS } from "../task-conversation/prompts";
import { TASK_TAB_GUIDE_PROMPT } from "./prompts";
import { TASK_HOST_PROMPTS } from "../task-host/prompts";
import type { TaskTabs } from "./service";

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

function parseDelivery(text: string): { status: "completed" | "blocked"; summary: string } | undefined {
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
function nativeSnapshot(agent: { provider: string; model: string | null; thinkingOptionId?: string | null }) {
  return {
    presetId: "task-tab-native",
    source: "task" as const,
    models: [
      {
        provider: agent.provider,
        model: agent.model ?? "",
        thinking: agent.thinkingOptionId ?? "",
        permissionMode: "full" as const,
      },
    ],
    environmentKind: "project-default" as const,
    runtimeEnv: null,
    instructions: "",
  };
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

export function createTaskFlow(options: {
  db: VibeDb;
  store: VibeStore;
  tabs: TaskTabs;
  getPaseo(): PaseoApi | null;
  log?: (message: string, error?: unknown) => void;
}) {
  const { db, store, tabs } = options;
  const log = options.log ?? ((message, error) => console.error("[vibe-board]", message, error ?? ""));
  const git = createTaskGitFinalizer();
  const resources = createTaskResources(db);
  const runtime = createTaskRuntimeCommands(db);
  const accepting = new Map<string, { cancelled: boolean }>();
  const opening = new Set<string>();
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
  async function releaseIdle(workspaceId: string, agentId: string) {
    try {
      const handle = paseo().agents.ref(agentId);
      await handle.refresh();
      const agent = handle.current();
      if (!agent || agent.activeTurn || !["idle", "error", "closed"].includes(agent.status))
        return;
      await resources.releaseAgent(workspaceId, agentId);
    } catch (error) {
      log("执行 tab 资源释放未确认", error);
    }
  }
  function queue<T>(workspaceId: string, action: () => Promise<T>): Promise<T> {
    const previous = serial.get(workspaceId) ?? Promise.resolve();
    const current = previous.then(action, action);
    serial.set(
      workspaceId,
      current.finally(() => {
        if (serial.get(workspaceId) === current) serial.delete(workspaceId);
      }),
    );
    return current;
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
    return matching.length || turnId ? matching : page.entries.filter((entry) => entry.item.type === type);
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
  async function projectFor(workspaceId: string) {
    const placement = await tabs.workspace(workspaceId);
    const project = placement.projectId ? store.projectConfigs.get(placement.projectId) : undefined;
    if (!placement.directory || !placement.projectId || !project)
      throw new Error("找不到任务工作区或项目 Git 路径");
    return { placement, project, directory: placement.directory, projectId: placement.projectId };
  }
  async function rolesFor(task: Task, tab: TaskTab): Promise<TaskRoleSnapshot> {
    const { projectId } = await projectFor(task.workspaceId);
    try {
      return store.modelDefaults.resolveTask(task.roleSelections ?? {}, projectId);
    } catch (error) {
      log("角色默认预设不可用，使用当前 tab 的原生模型", error);
      const handle = paseo().agents.ref(tab.agentId);
      await handle.refresh();
      const agent = handle.current();
      if (!agent) throw error;
      const snapshot = nativeSnapshot(agent);
      return TaskRoleSnapshotSchema.parse({
        scout: null,
        planner: snapshot,
        plan_reviewer: null,
        worker: snapshot,
        subagent: snapshot,
        reviewer: null,
        verifier: snapshot,
      });
    }
  }
  async function execute(input: { workspaceId: string; agentId: string; requestId: string }) {
    return queue(input.workspaceId, async () => {
      let task = requireTask(input.workspaceId);
      if (!["planning", "awaiting_confirmation"].includes(task.phase))
        throw new Error("当前阶段不能确认执行；请先在主会话修改方案");
      const tab = tabFor(task, input.agentId) ?? anchorTab(task);
      if (!tab) throw new Error("任务还没有主会话 tab");
      const candidates = [tab];
      const anchor = anchorTab(task);
      if (anchor && anchor.agentId !== tab.agentId) candidates.push(anchor);
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
      if (!located)
        throw new Error("还没有保存完整方案，请让主会话输出 vibe-plan 方案");
      task = store.tasks.savePlan(input.workspaceId, located.plan);
      return confirmWith(
        task,
        located.plan,
        sourceFor(located.sourceTab, located.page, located.entry),
        input.requestId,
        tab,
      );
    });
  }
  async function confirmWith(
    task: Task,
    plan: TaskPlan,
    source: TaskPlanSource,
    requestId: string,
    tab: TaskTab,
  ) {
    const roles = await rolesFor(task, tab);
    const frozen = freezeTaskSubtaskPresets(plan, roles, (id) => store.presets.get(id));
    validateTaskSubtaskPresets(plan, frozen);
    const confirmed = store.tasks.confirm(task.workspaceId, {
      plan,
      rolesSnapshot: frozen,
      planSource: source,
      requestId,
    });
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
    return { task: confirmed, message: "已确认方案，等待调度器准入后自动打开执行 tab。" };
  }
  async function workerAdmitted(admission: Admission) {
    const task = requireTask(admission.workspaceId);
    if (task.confirmedAt !== admission.confirmedAt || task.phase !== "queued") return;
    if (opening.has(task.workspaceId)) return;
    opening.add(task.workspaceId);
    try {
      await queue(task.workspaceId, () => openWorker(task, admission));
    } finally {
      opening.delete(task.workspaceId);
    }
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
    const { directory, projectId } = await projectFor(task.workspaceId);
    const ref = paseo().workspaces.ref(task.workspaceId);
    let handle: PaseoAgentHandle | undefined;
    try {
      handle = await ref.agents.create({
        config: {
          provider: `${model.provider}/${model.model}`,
          ...(modeIdFor(model.provider, model.permissionMode)
            ? { modeId: modeIdFor(model.provider, model.permissionMode) }
            : {}),
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
      const tab = await tabs.ensureTab(handle.id);
      await resources.admit(
        {
          workspaceId: task.workspaceId,
          role: "worker",
          agentId: handle.id,
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
            agentId: handle!.id,
            role: "worker",
            provider: agent.provider,
            model: agent.model!,
            thinking: agent.thinkingOptionId ?? undefined,
            candidateIndex: index,
            confirmedAt: task.confirmedAt!,
          });
        },
      );
      task = requireTask(task.workspaceId);
      task = store.tasks.setPhase(task.workspaceId, "executing");
      const prompt = store.prompts.resolve("board.task.work", {
        projectId,
        vars: {
          plan: JSON.stringify(task.plan, null, 2),
          reason: "",
        },
      });
      await handle.send(prompt);
      store.tasks.setSummary(
        task.workspaceId,
        `执行 tab #${tab?.number ?? "?"} 已启动，等待交付。`,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      try {
        await resources.request({
          workspaceId: task.workspaceId,
          action: "release",
          reservationId: admission.reservationId,
        });
      } catch (releaseError) {
        log("执行准入释放失败", releaseError);
      }
      if (store.tasks.get(task.workspaceId)?.phase === "queued")
        store.tasks.updateControl(task.workspaceId, { blockingReason: "执行启动失败：" + reason });
      throw error;
    } finally {
      void handle;
    }
  }
  async function workerCompleted(task: Task, tab: TaskTab, page: TimelinePage, turnId: string | null) {
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
  async function savePlanFromTurn(task: Task, tab: TaskTab, page: TimelinePage) {
    if (!["planning", "awaiting_confirmation"].includes(task.phase)) return;
    const found = planMessage(page);
    if (!found) return;
    const current = requireTask(task.workspaceId);
    if (JSON.stringify(current.plan) === JSON.stringify(found.plan)) return;
    store.tasks.savePlan(task.workspaceId, found.plan);
    store.tasks.setSummary(task.workspaceId, `主会话已更新方案：${found.plan.goal}`);
  }
  async function latestVerification(task: Task) {
    return store.taskArtifacts
      .list(task.workspaceId, { kind: "verification", confirmedAt: task.confirmedAt })
      .filter(
        (artifact) =>
          artifact.data?.conclusion === "pass" && artifact.data?.voided !== true,
      )
      .at(-1);
  }
  async function accept(input: { workspaceId: string; agentId: string; requestId: string }) {
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
      summary: "用户发起通过尝试",
      data: { action: "accept", requestId: input.requestId },
    });
    const attempt = Number(task.control?.gitAttempt ?? 0) + 1;
    const previousState = task.control?.git as GitState | undefined;
    const previous =
      previousState?.verifiedCommit === commitHash ? previousState : undefined;
    const active = { cancelled: false };
    accepting.set(task.workspaceId, active);
    store.tasks.updateControl(task.workspaceId, {
      acceptanceSource: source,
      acceptanceRequestId: input.requestId,
      verifiedCommit: commitHash,
      currentStep: "git",
      gitAttempt: attempt,
    });
    try {
      const result = await git.finalize({
        worktree: directory,
        repoPath: project.repoPath,
        verifiedCommit: commitHash,
        previous,
        isCancelled: () =>
          active.cancelled ||
          requireTask(task.workspaceId).confirmedAt !== task.confirmedAt,
        onProgress: (state) => {
          store.tasks.updateControl(task.workspaceId, { git: state });
        },
      });
      const phase = result.status === "completed" ? "completed" : undefined;
      store.taskArtifacts.record({
        workspaceId: task.workspaceId,
        kind: "git",
        sourceKey: "git:" + input.requestId,
        confirmedAt: task.confirmedAt,
        source: { ...source, sourceKey: "git:" + input.requestId },
        summary: result.message,
        data: { ...result },
        ...(phase ? { phase } : {}),
        control: {
          ...(requireTask(task.workspaceId).control ?? {}),
          git: result,
          currentStep: result.status === "completed" ? "done" : "git",
          blockingReason: result.status === "completed" ? null : result.message,
        },
      });
      store.tasks.setSummary(task.workspaceId, result.message);
      await tabs.appendStatus(tab.agentId, `Git 收尾：${result.message}`);
      return { task: requireTask(task.workspaceId), message: result.message };
    } finally {
      if (accepting.get(task.workspaceId) === active) accepting.delete(task.workspaceId);
    }
  }
  async function status(input: { workspaceId: string; agentId: string }) {
    const result = await tabs.status(input.workspaceId, input.agentId);
    await tabs.appendStatus(input.agentId, result.text);
    return { task: result.task, text: result.text };
  }
  async function standaloneAccept(agentId: string, workspaceId: string, page: TimelinePage, turnId: string | null) {
    const task = requireTask(workspaceId);
    if (task.phase !== "awaiting_acceptance") return;
    const messages = page.entries.filter(
      (entry) =>
        entry.item.type === "user_message" &&
        (!turnId || entry.turnId === turnId) &&
        entry.item.text.trim() === "通过",
    );
    const message = messages.at(-1);
    if (!message) return;
    const key = "pass:" + (message.item.type === "user_message" ? message.item.messageId ?? String(message.seqEnd) : message.seqEnd);
    if (task.control?.handledAcceptanceSource === key) return;
    store.tasks.updateControl(workspaceId, { handledAcceptanceSource: key });
    try {
      await accept({ workspaceId, agentId, requestId: key });
    } catch (error) {
      await tabs
        .appendStatus(agentId, "通过失败：" + (error instanceof Error ? error.message : String(error)))
        .catch(() => {});
      throw error;
    }
  }
  async function turnEnded(event: {
    agent: { id: string; workspaceId: string | null };
    turnId: string | null;
    outcome: { kind: string };
  }) {
    const workspaceId = event.agent.workspaceId;
    if (!workspaceId) return;
    const task = store.tasks.get(workspaceId);
    if (!task) return;
    const tab = tabFor(task, event.agent.id);
    if (!tab) return;
    const page = await timeline(tab.agentId);
    if (event.outcome.kind === "completed") {
      if (["main", "session"].includes(tab.role)) await savePlanFromTurn(task, tab, page);
      if (tab.role === "worker") {
        await workerCompleted(task, tab, page, event.turnId);
        await releaseIdle(workspaceId, tab.agentId);
      }
      await standaloneAccept(tab.agentId, workspaceId, page, event.turnId);
    } else if (event.outcome.kind === "failed" && BUSY_ROLES.has(tab.role)) {
      const current = requireTask(workspaceId);
      if (["executing", "reviewing", "verifying"].includes(current.phase))
        store.tasks.setPhase(workspaceId, "paused");
      store.tasks.updateControl(workspaceId, {
        blockingReason: `${tab.role} tab #${tab.number} 运行失败`,
      });
      if (tab.role === "worker") await releaseIdle(workspaceId, tab.agentId);
    }
  }
  function registerPrompts() {
    store.prompts.register(
      [TASK_PLAN_PROMPT, ...TASK_HOST_PROMPTS, ...TASK_FLOW_PROMPTS, TASK_TAB_GUIDE_PROMPT],
      { pruneMissing: true },
    );
  }
  return {
    registerPrompts,
    execute,
    accept,
    status,
    workerAdmitted,
    turnEnded,
    releaseAgent: resources.releaseAgent,
    close: async () => {
      for (const active of accepting.values()) active.cancelled = true;
    },
    resources,
    runtime,
  };
}
export type TaskFlow = ReturnType<typeof createTaskFlow>;
