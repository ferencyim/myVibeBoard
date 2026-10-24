import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { PaseoApi, PaseoAgentHandle } from "@getpaseo/client";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import {
  TaskRoleSnapshotSchema,
  TASK_PHASE_LABELS,
  TASK_TAB_PRESET_LABEL,
  TASK_TAB_ROLE_LABEL,
  TASK_TAB_ROLE_LABELS,
  UNRESOLVED_TAB_MODEL,
  findTaskActualPreset,
  freezeTaskSubtaskPresets,
  parseTaskPlan,
  validateTaskSubtaskPresets,
  TASK_PLAN_PROMPT,
  type Task,
  type TaskPlan,
  type TaskPlanSource,
  type TaskPresetSnapshot,
  type TaskPhase,
  type TaskRoleSnapshot,
  type TaskTab,
} from "../vibe/contract";
import { createTaskRuntimeCommands, publishEvent, type VibeDb, type VibeStore } from "../vibe/db";
import { createTaskResources } from "../task-host/resources";
import { modeIdFor } from "../task-host/permission";
import { createTaskGitFinalizer, type GitState } from "../task-conversation/git";
import { TASK_FLOW_PROMPTS } from "../task-conversation/prompts";
import { TASK_TAB_GUIDE_PROMPT } from "./prompts";
import { TASK_HOST_PROMPTS } from "../task-host/prompts";
import { HANDOFF_PATTERN, tabTitle, type TaskTabs } from "./service";

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
function rolePromptKey(role: TaskTab["role"]): string | undefined {
  if (role === "session") return undefined;
  return role === "main" ? "task.role.planner" : "task.role." + role;
}

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
  git?: Pick<ReturnType<typeof createTaskGitFinalizer>, "finalize">;
  log?: (message: string, error?: unknown) => void;
}) {
  const { db, store, tabs } = options;
  const log = options.log ?? ((message, error) => console.error("[vibe-board]", message, error ?? ""));
  const git = options.git ?? createTaskGitFinalizer();
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
  async function execute(input: {
    workspaceId: string;
    agentId: string;
    requestId: string;
    reason?: string;
  }) {
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
      const tab = await tabs.ensureTab(handle.id, {
        role: "worker",
        presetId: preset.presetId,
      });
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
      if (task.phase !== "queued") throw new Error("任务已停止，不打开执行 tab");
      const reason = String(task.control?.executionReason ?? "").trim();
      task = store.tasks.setPhase(task.workspaceId, "executing");
      const prompt = store.prompts.resolve("board.task.work", {
        projectId,
        vars: {
          plan: JSON.stringify(task.plan, null, 2),
          reason,
        },
      });
      await handle.send(prompt, { sourceAgentId: task.anchorAgentId });
      if (reason) store.tasks.updateControl(task.workspaceId, { executionReason: null });
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
        const previous =
          previousState?.verifiedCommit === commitHash ? previousState : undefined;
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
            active.cancelled ||
            requireTask(task.workspaceId).confirmedAt !== task.confirmedAt,
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
          (candidate) =>
            candidate.provider === toView.provider && candidate.model === toView.model,
        );
        if (index < 0)
          throw new Error(
            `当前 tab 的模型 ${toView.provider}/${toView.model} 不在本轮执行快照内；请先在当前 tab 选择已确认的执行模型`,
          );
        worker = { presetId: preset.presetId, index };
      }
      let progress = "";
      try {
        const page = await timeline(from.agentId, 40);
        const entry = lastAssistant(page, null);
        if (entry?.item.type === "assistant_message") progress = entry.item.text.trim();
      } catch (error) {
        log("读取接手来源进度失败", error);
      }
      if (progress.length > 6000) progress = progress.slice(-6000);
      const fromHandle = paseo().agents.ref(from.agentId);
      await fromHandle.refresh();
      if (fromHandle.current()?.activeTurn) {
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
          if (resources.hasLease(from.agentId))
            throw new Error("原执行租约尚未释放，资源保持待核对");
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
              task.plan ? `确认方案目标：${task.plan.goal}` : "",
              progress ? `#${from.number} 最近输出：\n${progress}` : "",
            ]
              .filter(Boolean)
              .join("\n"),
            prompt:
              (input.reason ?? "").replace(/#\s*\d+/, "").trim() ||
              "请继续未完成的工作，保持已确认方案范围。",
          },
        });
        const message = [roleText ? store.prompts.resolve(roleText, { projectId }) : "", continuation]
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
    "queued",
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
      if (!from || !["main", "scout", "worker"].includes(from.role)) return;
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
          modeId = modeIdFor(provider, candidate.permissionMode);
          candidateIndex = index;
          presetId = preset.presetId;
          runtimeEnv = preset.runtimeEnv;
        } else {
          if (!fromView || fromView.model === UNRESOLVED_TAB_MODEL)
            return fail("来源 tab 的模型尚未解析，请稍后重试");
          provider = fromView.provider;
          model = fromView.model;
          modeId = modeIdFor(provider, "auto");
        }
        const handle = await paseo().workspaces.ref(input.workspaceId).agents.create({
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
        const restore =
          input.previousPhase && RESTORABLE_PHASES.has(input.previousPhase)
            ? input.previousPhase
            : from.role === "worker"
              ? "executing"
              : initial.plan
                ? "awaiting_confirmation"
                : "planning";
        if (requireTask(input.workspaceId).phase === "paused")
          store.tasks.setPhase(input.workspaceId, restore);
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
  async function standaloneAccept(agentId: string, workspaceId: string, page: TimelinePage, turnId: string | null) {
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
      if (await naturalHandoff(task, tab, page, event.turnId)) return;
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
    stop,
    handoff,
    continuation,
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
