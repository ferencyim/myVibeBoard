import type { PaseoApi } from "@getpaseo/client";
import type {
  TaskConversationMember,
  TaskConversationRecipient,
  TaskConversationRow,
  TaskConversationSnapshot,
  TaskConversationDelivery,
} from "@getpaseo/protocol/messages";
import {
  freezeTaskSubtaskPresets,
  validateTaskSubtaskPresets,
  isEvent,
  MODEL_ROLES,
  parseTaskPlan,
  TaskActionInputSchema,
  findTaskActualPreset,
  type Task,
  type TaskActionInput,
  type TaskPlanSource,
  type TaskRoleSnapshot,
  type ModelRole,
  type VibeEvent,
  type EventPayload,
  type TaskArtifactKind,
  classifyFailure,
  type AgentSession,
} from "../vibe/contract";
import {
  createTaskRuntimeCommands,
  createTaskVerificationCommands,
  publishEvent,
  type VibeStore,
} from "../vibe/db";
import { busyMember, latestTaskPlan, taskSource } from "./source";
import { createTaskGitFinalizer, type GitState } from "./git";
import type { TaskTurnToken } from "../task-host/resources";

export interface TaskFlowOptions {
  store: VibeStore;
  getPaseo(): PaseoApi | null;
  resolveRoles(task: Task): TaskRoleSnapshot | Promise<TaskRoleSnapshot>;
  resolveRecipient(
    task: Task,
    role: ModelRole,
    options?: {
      candidateIndex?: number;
      memberId?: string;
      parentMemberId?: string;
      subtaskId?: string;
      fromSessionId?: string;
    },
  ): Promise<TaskConversationRecipient>;
  releaseAgent?(workspaceId: string, agentId: string): Promise<void>;
  git?: ReturnType<typeof createTaskGitFinalizer>;
}

function blockJson(text: string, tag: string): unknown {
  const matches = [
    ...text.matchAll(new RegExp("^```" + tag + "[ \\t]*\\r?\\n([\\s\\S]*?)^```[ \\t]*$", "gm")),
  ];
  if (matches.length !== 1) return null;
  try {
    return JSON.parse(matches[0]![1]!);
  } catch {
    return null;
  }
}
interface ContinuationOutcome {
  status: "continued" | "paused" | "exhausted";
  reason: string;
  agentId?: string;
  sessionId?: string;
  candidateIndex?: number;
}

export function createTaskConversationService(options: TaskFlowOptions) {
  const { store } = options;
  const runtime = createTaskRuntimeCommands(store.db);
  const verifications = createTaskVerificationCommands(store.db);
  const git = options.git ?? createTaskGitFinalizer();
  const queues = new Map<string, Promise<unknown>>();
  const accepting = new Map<string, { cancelled: boolean }>();
  const remember = (values: string[], value: string) =>
    [...values.filter((entry) => entry !== value), value].slice(-256);
  function rememberRequest(workspaceId: string, requestId: string) {
    const completed = task(workspaceId).control?.completedRequestIds;
    store.tasks.updateControl(workspaceId, {
      completedRequestIds: remember(
        Array.isArray(completed) ? (completed as string[]) : [],
        requestId,
      ),
    });
  }
  const roleArtifact: Partial<Record<string, TaskArtifactKind>> = {
    planner: "plan",
    scout: "scout",
    plan_reviewer: "plan_review",
    worker: "delivery",
    subagent: "delivery",
  };
  const serial = <T>(workspaceId: string, action: () => Promise<T>): Promise<T> => {
    const previous = queues.get(workspaceId) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(action);
    queues.set(workspaceId, pending);
    void pending
      .finally(() => {
        if (queues.get(workspaceId) === pending) queues.delete(workspaceId);
      })
      .catch(() => {});
    return pending;
  };
  const task = (workspaceId: string, conversationId?: string) => {
    const value = store.tasks.get(workspaceId);
    if (!value?.conversationId || (conversationId && value.conversationId !== conversationId))
      throw new Error("任务会话尚未绑定或归属不匹配");
    return value;
  };
  const handle = (current: Task) => {
    const paseo = options.getPaseo();
    if (!paseo || !current.conversationId) throw new Error("宿主任务会话连接不可用");
    return paseo.taskConversations.ref(current.conversationId);
  };
  async function snapshot(current: Task) {
    const value = await handle(current).refresh();
    if (!value || value.workspaceId !== current.workspaceId)
      throw new Error("宿主任务会话不存在或归属已变化");
    return value;
  }
  async function prompt(current: Task, key: string, vars: Record<string, string> = {}) {
    const native = await options.getPaseo()!.workspaces.ref(current.workspaceId).refresh();
    const project = native ? store.projectConfigs.get(native.projectId) : undefined;
    return store.prompts.resolve(key, { projectId: project?.id, vars });
  }
  async function send(
    current: Task,
    role: ModelRole,
    text: string,
    requestId: string,
    recipientOptions: Parameters<TaskFlowOptions["resolveRecipient"]>[2] = {},
  ) {
    if (!recipientOptions.memberId && !recipientOptions.fromSessionId) {
      const previous = runtime
        .listSessions({ workspaceId: current.workspaceId })
        .findLast((session) => session.role === role);
      // A workflow command may create a replacement; it must not revive a stopped
      // backend merely because the selected role and model still match.
      if (previous?.state === "ended")
        recipientOptions = { ...recipientOptions, memberId: "flow:" + requestId + ":" + role };
    }
    const result = await handle(current).send({
      recipient: await options.resolveRecipient(current, role, recipientOptions),
      clientMessageId: "task-flow:" + requestId,
      text,
    });
    if (result.error || result.delivery?.status !== "accepted") {
      const reason =
        result.delivery?.status === "unknown"
          ? "投递结果不明，请先核对原成员，不能重复派发"
          : (result.error ?? result.delivery?.error ?? "任务消息尚未被接手成员确认接受");
      pauseFailedDelivery(current, reason, recipientOptions.subtaskId);
      throw new Error(reason);
    }
    return result.delivery;
  }
  function pauseFailedDelivery(current: Task, reason: string, subtaskId?: string) {
    store.db.immediate(() => {
      const latest = task(current.workspaceId);
      if (!["paused", "completed", "failed"].includes(latest.phase))
        store.tasks.setPhase(current.workspaceId, "paused");
      const run = subtaskId
        ? latest.subtaskRuns.find((item) => item.subtaskId === subtaskId)
        : undefined;
      if (run && ["running", "waiting", "pending"].includes(run.state))
        store.tasks.setSubtaskRun(current.workspaceId, {
          subtaskId: run.subtaskId,
          state: "paused",
          summary: reason,
        });
      store.tasks.updateControl(current.workspaceId, {
        blockingReason: reason,
        currentStep: "delivery_paused",
      });
    });
  }
  async function publishPendingArtifacts(workspaceId?: string) {
    for (const artifact of store.taskArtifacts.pendingPublish(workspaceId)) {
      const current = task(artifact.workspaceId);
      const published = await handle(current).publish({
        sourceKey: "task-artifact:" + artifact.kind + ":" + artifact.sourceKey,
        kind: "artifact",
        text: artifact.summary,
        source:
          artifact.source.backendAgentId && artifact.source.memberId
            ? {
                backendAgentId: artifact.source.backendAgentId,
                memberId: artifact.source.memberId,
                sourceTurnId: artifact.source.sourceTurnId,
                epoch: artifact.source.sourceEpoch,
                seq: artifact.source.sourceSeq,
                messageId: artifact.source.messageId,
              }
            : undefined,
        completed: true,
      });
      if (published.error || !published.row) throw new Error(published.error ?? "沉淀发布未完成");
      store.taskArtifacts.markPublished(current.workspaceId, artifact.kind, artifact.sourceKey, {
        epoch: published.row.epoch,
        seq: published.row.seq,
      });
    }
  }
  async function saveArtifact(
    current: Task,
    kind: "plan" | "scout" | "plan_review" | "delivery" | "git",
    row: TaskConversationRow,
    summary: string,
    data?: Record<string, unknown>,
  ) {
    store.taskArtifacts.record({
      workspaceId: current.workspaceId,
      kind,
      sourceKey: row.sourceKey,
      confirmedAt: current.confirmedAt,
      source: taskSource(current.conversationId!, row),
      summary,
      data,
    });
    await publishPendingArtifacts(current.workspaceId);
  }
  async function stop(current: Task, reason: string) {
    const active = accepting.get(current.workspaceId);
    if (active) active.cancelled = true;
    store.tasks.updateControl(current.workspaceId, {
      currentStep: "stopping",
      blockingReason: reason,
    });
    const result = await handle(current).stop();
    if (
      result.error ||
      !result.conversation ||
      result.conversation.status === "stopping" ||
      result.conversation.members.some((member) => busyMember(member.status))
    )
      throw new Error(result.error ?? "旧成员停止结果不明，资源继续保留");
    for (const run of current.subtaskRuns.filter((item) =>
      ["running", "waiting"].includes(item.state),
    ))
      store.tasks.setSubtaskRun(current.workspaceId, {
        subtaskId: run.subtaskId,
        state: "paused",
        summary: reason,
      });
    const latest = task(current.workspaceId);
    if (!["paused", "completed"].includes(latest.phase))
      store.tasks.setPhase(current.workspaceId, "paused");
    store.tasks.updateControl(current.workspaceId, {
      currentStep: "paused",
      blockingReason: reason,
    });
  }
  async function startWorker(current: Task, requestId: string, reason = "") {
    const delivery = await send(
      current,
      "worker",
      await prompt(current, "board.task.work", {
        plan: JSON.stringify(current.plan, null, 2),
        reason,
      }),
      requestId,
    );
    store.tasks.updateControl(current.workspaceId, {
      currentStep: "executing",
      blockingReason: null,
      autoContinuationBlocked: false,
    });
    return delivery;
  }
  async function requireWritersStopped(current: Task, native: TaskConversationSnapshot) {
    if (
      native.members.some(
        (member) => ["worker", "subagent"].includes(member.role) && busyMember(member.status),
      ) ||
      current.subtaskRuns.some((run) => ["running", "waiting"].includes(run.state))
    )
      throw new Error("执行成员或子任务仍在运行，不能跳过写入者开始复核或验证");
  }
  async function prepareAcceptance(current: Task, requestId: string, source?: TaskPlanSource) {
    if (current.phase !== "awaiting_acceptance" || !current.confirmedAt)
      throw new Error("只有本轮验证通过的待验收任务可通过");
    const native = await snapshot(current);
    await requireWritersStopped(current, native);
    const verification = verifications.list(current.workspaceId, current.confirmedAt).at(-1);
    if (!verification?.finishedAt || verification.conclusion !== "pass")
      throw new Error("本轮没有完成且通过的最新验证");
    const workspace = await options.getPaseo()!.workspaces.ref(current.workspaceId).refresh();
    const project = workspace ? store.projectConfigs.get(workspace.projectId) : undefined;
    if (!workspace || !project) throw new Error("找不到任务工作区和项目 Git 路径");
    const recordedGit = current.control?.git as GitState | undefined;
    const previous =
      recordedGit?.verifiedCommit === verification.commitHash ? recordedGit : undefined;
    const attempt = Number(current.control?.gitAttempt ?? 0) + 1;
    const active = accepting.get(current.workspaceId)!;
    store.tasks.updateControl(current.workspaceId, {
      acceptanceSource: source ?? { conversationId: current.conversationId, sourceKey: requestId },
      acceptanceRequestId: requestId,
      verifiedCommit: verification.commitHash,
      currentStep: "git",
      gitAttempt: attempt,
    });
    // Git network operations run outside the workspace queue so Stop can preempt them.
    return async () => {
      const result = await git.finalize({
        worktree: workspace.workspaceDirectory,
        repoPath: project.repoPath,
        verifiedCommit: verification.commitHash,
        previous,
        isCancelled: () =>
          active.cancelled || task(current.workspaceId).confirmedAt !== current.confirmedAt,
        onProgress: async (state) => {
          store.tasks.updateControl(current.workspaceId, { git: state });
        },
      });
      const sourceRef = {
        conversationId: current.conversationId!,
        sourceKey: "git:" + requestId + ":" + attempt,
      };
      let milestonePhase: "completed" | "paused" | undefined;
      if (!active.cancelled && result.status === "completed") milestonePhase = "completed";
      if (!active.cancelled && result.status === "verification_required") milestonePhase = "paused";
      let blockingReason: string | null = result.status === "completed" ? null : result.message;
      if (active.cancelled) blockingReason = "用户已停止 Git 收尾；请核对结果后重试";
      store.taskArtifacts.record({
        workspaceId: current.workspaceId,
        kind: "git",
        sourceKey: sourceRef.sourceKey,
        confirmedAt: current.confirmedAt,
        source: sourceRef,
        summary: result.message,
        data: { ...result },
        phase: milestonePhase,
        control: {
          ...task(current.workspaceId).control,
          git: result,
          currentStep: active.cancelled ? "paused" : "git",
          blockingReason,
        },
      });
      await publishPendingArtifacts(current.workspaceId);
      if (result.status === "completed") rememberRequest(current.workspaceId, requestId);
      return { task: task(current.workspaceId), message: result.message };
    };
  }
  async function confirmExecution(current: Task, input: TaskActionInput, completed: string[]) {
    if (
      current.confirmedAt &&
      (current.control?.confirmation as { requestId?: string } | undefined)?.requestId ===
        input.requestId
    )
      return;
    if (!["planning", "awaiting_confirmation"].includes(current.phase))
      throw new Error("当前任务已离开规划，请勿重复确认执行");
    store.tasks.updateControl(current.workspaceId, { confirmingRequestId: input.requestId });
    try {
      const latest = await latestTaskPlan(handle(current), await snapshot(current), input.source);
      const roles = freezeTaskSubtaskPresets(
        latest.plan,
        await options.resolveRoles(current),
        (id) => store.presets.get(id),
      );
      validateTaskSubtaskPresets(latest.plan, roles);
      current = store.db.immediate(() => {
        const confirmed = store.tasks.confirm(current.workspaceId, {
          plan: latest.plan,
          rolesSnapshot: roles,
          planSource: latest.source,
          requestId: input.requestId,
        });
        store.taskArtifacts.record({
          workspaceId: current.workspaceId,
          kind: "plan",
          sourceKey: "confirmed:" + input.requestId,
          confirmedAt: confirmed.confirmedAt,
          source: latest.source,
          summary: "已确认方案：" + latest.plan.goal,
          data: { plan: latest.plan },
        });
        store.tasks.updateControl(current.workspaceId, {
          completedRequestIds: remember(completed, input.requestId),
          confirmingRequestId: null,
        });
        return confirmed;
      });
      await publishPendingArtifacts(current.workspaceId);
    } finally {
      if (task(current.workspaceId).control?.confirmingRequestId === input.requestId)
        store.tasks.updateControl(current.workspaceId, { confirmingRequestId: null });
    }
  }
  async function planTask(current: Task, input: TaskActionInput) {
    if (!["planning", "awaiting_confirmation", "completed"].includes(current.phase))
      await stop(current, "修改方案前停止旧执行");
    current = task(current.workspaceId);
    if (current.phase !== "planning")
      current = store.tasks.setPhase(current.workspaceId, "planning");
    const roles = await options.resolveRoles(current);
    store.tasks.updateControl(current.workspaceId, { pendingPlanReason: input.reason ?? "" });
    if (roles.scout)
      await send(
        current,
        "scout",
        await prompt(current, "board.task.scout", { reason: input.reason ?? "" }),
        input.requestId + ":scout",
        { memberId: "plan:" + input.requestId + ":scout" },
      );
    else
      await send(
        current,
        "planner",
        await prompt(current, "board.task.plan", { reason: input.reason ?? "" }),
        input.requestId,
        { memberId: "plan:" + input.requestId + ":planner" },
      );
    store.tasks.setSummary(current.workspaceId, "正在制定新方案，等待规划结果");
    store.tasks.updateControl(current.workspaceId, {
      currentStep: "planning",
      blockingReason: null,
    });
  }
  async function reviewPlan(
    current: Task,
    input: TaskActionInput,
    native: TaskConversationSnapshot,
  ) {
    if (!["planning", "awaiting_confirmation"].includes(current.phase))
      throw new Error("请先停止并回到规划，再复核方案");
    const latest = await latestTaskPlan(handle(current), native, input.source);
    await send(
      current,
      "plan_reviewer",
      await prompt(current, "board.task.plan_review", { plan: latest.row.text }),
      input.requestId,
    );
  }
  async function rejectTask(current: Task, input: TaskActionInput) {
    if (!current.confirmedAt || !input.reason?.trim())
      throw new Error("驳回需要有效确认方案和原因；新增范围请先修改方案并重新确认");
    await stop(current, input.reason);
    current = store.tasks.setPhase(current.workspaceId, "executing");
    await startWorker(current, input.requestId, input.reason);
  }
  async function startEvidence(
    current: Task,
    input: TaskActionInput,
    native: TaskConversationSnapshot,
  ) {
    if (!current.confirmedAt || !current.rolesSnapshot) throw new Error("任务尚未显式确认执行");
    await requireWritersStopped(current, native);
    const next =
      input.action === "review" || current.rolesSnapshot.reviewer ? "reviewing" : "verifying";
    if (next === "reviewing" && !current.rolesSnapshot.reviewer)
      throw new Error("任务未启用代码复核模型");
    if (
      !["executing", "reviewing", "verifying", "paused", "awaiting_acceptance"].includes(
        current.phase,
      )
    )
      throw new Error("当前阶段不能开始复核或验证");
    store.db.immediate(() => {
      if (current.phase === "awaiting_acceptance")
        store.tasks.setPhase(current.workspaceId, "paused");
      store.tasks.setPhase(current.workspaceId, next);
      store.tasks.updateControl(current.workspaceId, { blockingReason: null, currentStep: next });
    });
  }
  async function commandImpl(input: TaskActionInput) {
    const current = task(input.workspaceId, input.conversationId);
    const completed = Array.isArray(current.control?.completedRequestIds)
      ? (current.control.completedRequestIds as string[])
      : [];
    if (completed.includes(input.requestId))
      return { task: current, message: "本次操作已经处理，未重复运行" };
    if (accepting.has(input.workspaceId) && input.action !== "stop")
      throw new Error("Git 收尾正在进行，请等待结果或先停止任务");
    const native = await snapshot(current);
    if (input.action === "execute") await confirmExecution(current, input, completed);
    else if (input.action === "plan") await planTask(current, input);
    else if (input.action === "review_plan") await reviewPlan(current, input, native);
    else if (input.action === "stop") {
      store.tasks.updateControl(current.workspaceId, {
        autoContinuationBlocked: true,
        stopRequestId: input.requestId,
        continuationInFlightId: null,
      });
      await stop(current, input.reason ?? "用户停止任务");
    } else if (input.action === "reject") await rejectTask(current, input);
    else await startEvidence(current, input, native);
    rememberRequest(input.workspaceId, input.requestId);
    return { task: task(input.workspaceId), message: "任务操作已受理" };
  }
  async function delegateImpl(input: {
    workspaceId: string;
    subtaskId: string;
    parentMemberId: string;
    requestId: string;
  }) {
    const current = task(input.workspaceId);
    if (current.phase !== "executing" || !current.plan || !current.rolesSnapshot)
      throw new Error("只有已准入执行的任务可委派子任务");
    const native = await snapshot(current);
    const parent = native.members.find(
      (member) => member.memberId === input.parentMemberId && member.role === "worker",
    );
    if (!parent || busyMember(parent.status))
      throw new Error("执行主代理必须先结束本轮并让出名额，再委派子任务");
    const subtask = current.plan.subtasks.find((item) => item.id === input.subtaskId);
    if (!subtask) throw new Error("子任务不在已确认方案中");
    if (
      subtask.dependsOn.some(
        (id) =>
          !current.subtaskRuns.some((run) => run.subtaskId === id && run.state === "completed"),
      )
    )
      throw new Error("子任务的前置依赖尚未完成");
    if (
      current.subtaskRuns.some(
        (run) =>
          run.subtaskId === subtask.id && ["running", "waiting", "completed"].includes(run.state),
      )
    )
      return;
    const memberId = "subtask:" + input.requestId;
    store.db.immediate(() => {
      recordDelegation(current, subtask.id, memberId, parent.memberId, input.requestId);
      store.tasks.setSubtaskRun(current.workspaceId, {
        subtaskId: subtask.id,
        state: "pending",
        agentId: null,
      });
    });
    const delivery = await send(
      current,
      "subagent",
      await prompt(current, "board.task.subtask", { subtask: JSON.stringify(subtask, null, 2) }),
      input.requestId,
      { subtaskId: subtask.id, parentMemberId: parent.memberId, memberId },
    );
    const updated = await snapshot(current);
    const member = updated.members.find((item) => item.memberId === delivery.memberId);
    if (!member) throw new Error("已派发子任务的宿主成员缺失，请核对后继续");
    store.tasks.setSubtaskRun(current.workspaceId, {
      subtaskId: subtask.id,
      state: "running",
      agentId: member.backendAgentId,
      actualModel: { provider: member.config.provider, model: member.config.model ?? "default" },
    });
  }
  async function completedImpl(agentId: string, turn?: TaskTurnToken) {
    const session = runtime.findSessionByAgent(agentId);
    const current = session?.workspaceId ? store.tasks.get(session.workspaceId) : undefined;
    if (!current) return;
    const native = await snapshot(current);
    if (turn && !turn.isCurrent()) return;
    const member = native.members.find((item) => item.backendAgentId === agentId);
    if (!member) return;
    await turn?.release();
    if (turn && !turn.isCurrent()) return;
    if (["reviewer", "verifier"].includes(member.role)) return;
    const response = await handle(current).querySource({
      memberId: member.memberId,
      completed: true,
    });
    if (response.error || !response.row) throw new Error(response.error ?? "完成发言源尚未落盘");
    const row = response.row;
    if (turn && (!turn.isCurrent() || row.source?.sourceTurnId !== turn.turnId)) return;
    await recordCompletedSource(current, row, member, native);
  }
  async function recordCompletedSource(
    current: Task,
    row: TaskConversationRow,
    member: TaskConversationMember,
    native: TaskConversationSnapshot,
  ) {
    if (!isMemberOutput(row, member)) return;
    const handled = Array.isArray(current.control?.handledSources)
      ? (current.control.handledSources as string[])
      : [];
    if (handled.includes(row.sourceKey)) return;
    if (member.role === "planner") await plannerCompleted(current, row, native);
    else if (member.role === "scout" || member.role === "plan_reviewer")
      await adviceCompleted(current, row, member.role);
    else if (member.role === "worker" || member.role === "subagent")
      await executionCompleted(current, row, member);
    store.tasks.updateControl(current.workspaceId, {
      handledSources: remember(handled, row.sourceKey),
    });
  }
  function isMemberOutput(row: TaskConversationRow, member: TaskConversationMember) {
    return (
      row.kind === "assistant" &&
      row.speaker?.backendAgentId === member.backendAgentId &&
      row.speaker.role === member.role
    );
  }
  async function plannerCompleted(
    current: Task,
    row: TaskConversationRow,
    native: TaskConversationSnapshot,
  ) {
    let latest: Awaited<ReturnType<typeof latestTaskPlan>>;
    try {
      latest = await latestTaskPlan(handle(current), native);
    } catch (error) {
      store.tasks.setSummary(current.workspaceId, "规划仍待补全或核对：" + String(error));
      return;
    }
    if (["planning", "awaiting_confirmation"].includes(current.phase)) {
      store.db.immediate(() => {
        store.tasks.savePlan(current.workspaceId, latest.plan);
        store.tasks.setPlanSource(current.workspaceId, latest.source);
        store.tasks.setSummary(current.workspaceId, "待确认方案：" + latest.plan.goal);
        store.tasks.updateControl(current.workspaceId, {
          currentStep: "awaiting_confirmation",
          blockingReason: null,
        });
        store.taskArtifacts.record({
          workspaceId: current.workspaceId,
          kind: "plan",
          sourceKey: row.sourceKey,
          source: latest.source,
          summary: "方案：" + latest.plan.goal,
          data: { plan: latest.plan },
        });
      });
      await publishPendingArtifacts(current.workspaceId);
    }
  }
  async function adviceCompleted(
    current: Task,
    row: TaskConversationRow,
    role: "scout" | "plan_reviewer",
  ) {
    if (!["planning", "awaiting_confirmation"].includes(current.phase)) return;
    await saveArtifact(
      current,
      role === "scout" ? "scout" : "plan_review",
      row,
      (role === "scout" ? "探路结论：" : "方案复核结论：") + row.text.slice(0, 240),
    );
    await send(
      current,
      "planner",
      await prompt(current, "board.task.plan", {
        reason: [current.control?.pendingPlanReason, row.text].filter(Boolean).join("\n\n"),
      }),
      "source:" + row.sourceKey + ":planner",
    );
  }
  async function executionCompleted(
    current: Task,
    row: TaskConversationRow,
    member: TaskConversationMember,
  ) {
    if (current.phase !== "executing") return;
    const delegation = blockJson(row.text, "vibe-delegate") as { subtaskIds?: unknown } | null;
    if (member.role === "worker" && Array.isArray(delegation?.subtaskIds)) {
      for (const id of delegation.subtaskIds)
        if (typeof id === "string")
          await delegateImpl({
            workspaceId: current.workspaceId,
            subtaskId: id,
            parentMemberId: member.memberId,
            requestId: row.sourceKey + ":" + id,
          });
    } else {
      const delivery = blockJson(row.text, "vibe-delivery") as {
        status?: string;
        summary?: string;
      } | null;
      if (
        !delivery ||
        !["completed", "blocked"].includes(delivery.status ?? "") ||
        typeof delivery.summary !== "string"
      )
        return;
      if (member.role === "subagent") {
        const run = current.subtaskRuns.find((item) => item.agentId === member.backendAgentId);
        if (!run) throw new Error("子代理没有已登记子任务");
        store.db.immediate(() => {
          store.tasks.setSubtaskRun(current.workspaceId, {
            subtaskId: run.subtaskId,
            state: delivery.status === "completed" ? "completed" : "paused",
            summary: delivery.summary,
          });
          recordDelivery(current, row, delivery.summary!);
        });
        await publishPendingArtifacts(current.workspaceId);
        const latest = task(current.workspaceId);
        if (
          delivery.status === "completed" &&
          !latest.subtaskRuns.some((item) => ["running", "waiting"].includes(item.state))
        )
          await startWorker(
            latest,
            row.sourceKey + ":resume",
            "子任务已有交付，请审核并继续尚未完成的已确认子任务。",
          );
      } else if (delivery.status === "completed") {
        await requireWritersStopped(task(current.workspaceId), await snapshot(current));
        if (
          current.plan!.subtasks.some(
            (subtask) =>
              !task(current.workspaceId).subtaskRuns.some(
                (run) => run.subtaskId === subtask.id && run.state === "completed",
              ),
          )
        )
          throw new Error("方案子任务尚未全部完成，请继续委派与审核");
        recordDelivery(
          current,
          row,
          delivery.summary,
          current.rolesSnapshot?.reviewer ? "reviewing" : "verifying",
        );
        await publishPendingArtifacts(current.workspaceId);
      } else {
        recordDelivery(current, row, delivery.summary, "paused");
        await publishPendingArtifacts(current.workspaceId);
      }
    }
  }
  function recordDelivery(
    current: Task,
    row: TaskConversationRow,
    summary: string,
    phase?: "reviewing" | "verifying" | "paused",
  ) {
    return store.taskArtifacts.record({
      workspaceId: current.workspaceId,
      kind: "delivery",
      sourceKey: row.sourceKey,
      confirmedAt: current.confirmedAt,
      source: taskSource(current.conversationId!, row),
      summary,
      phase,
      control: phase === "paused" ? { blockingReason: summary } : undefined,
    });
  }
  async function handleEvent(event: VibeEvent) {
    if (isEvent(event, "scheduler.task_admitted")) {
      let current = task(event.payload.workspaceId);
      if (
        current.confirmedAt !== event.payload.confirmedAt ||
        !["queued", "executing"].includes(current.phase)
      )
        return;
      if (current.phase === "queued")
        current = store.tasks.setPhase(current.workspaceId, "executing");
      await serial(current.workspaceId, () =>
        startWorker(current, "admitted:" + event.payload.reservationId),
      );
    } else if (isEvent(event, "task.stop_requested")) {
      let stopped = false;
      let reason = "";
      try {
        store.tasks.updateControl(event.payload.workspaceId, {
          autoContinuationBlocked: true,
          stopRequestId: event.payload.requestId,
          continuationInFlightId: null,
        });
        await serial(event.payload.workspaceId, () =>
          stop(task(event.payload.workspaceId), event.payload.reason),
        );
        stopped = true;
        reason = "任务成员已停止";
      } catch (error) {
        reason = String(error);
      }
      publishEvent(store.db, {
        type: "task.stop_result",
        dedupeKey: "task-stop-result:" + event.payload.requestId,
        payload: {
          workspaceId: event.payload.workspaceId,
          requestId: event.payload.requestId,
          stopped,
          reason,
        },
      });
    } else if (isEvent(event, "task.fix_requested")) {
      const current = task(event.payload.workspaceId);
      if (current.confirmedAt !== event.payload.confirmedAt || current.phase !== "executing")
        return;
      await serial(current.workspaceId, () =>
        startWorker(current, "fix:" + event.payload.verificationId, event.payload.prompt),
      );
    } else if (isEvent(event, "context.continuation_requested")) {
      if (
        !event.payload.workspaceId ||
        ["master", "reviewer", "verifier"].includes(event.payload.role)
      )
        return;
      await serial(event.payload.workspaceId, () => continueTask(event.payload));
    } else if (isEvent(event, "task.updated"))
      await publishPendingArtifacts(event.payload.workspaceId);
  }
  async function continueTask(input: EventPayload<"context.continuation_requested">) {
    let current = task(input.workspaceId!);
    const reply = (
      status: "continued" | "paused" | "exhausted",
      reason: string,
      extra: { agentId?: string; sessionId?: string; candidateIndex?: number } = {},
    ) =>
      publishEvent(store.db, {
        type: "context.continuation_result",
        dedupeKey: "task-continuation-result:" + input.requestId,
        payload: {
          requestId: input.requestId,
          workspaceId: input.workspaceId,
          status,
          reason,
          ...extra,
        },
      });
    if (
      current.control?.autoContinuationBlocked &&
      current.control.continuationInFlightId !== input.requestId
    ) {
      reply("paused", "任务已被显式停止，请用户重新规划或明确驳回后再继续");
      return;
    }
    const old = continuationSource(input, current);
    if (!old) {
      reply("paused", "接续来源或确认轮次已变化");
      return;
    }
    const native = await snapshot(current);
    const oldMember = native.members.find((member) => member.backendAgentId === input.agentId);
    if (!oldMember) {
      reply("paused", "旧成员不属于本任务会话");
      return;
    }
    try {
      const outcome = await continueCandidates(current, input, old, oldMember);
      reply(outcome.status, outcome.reason, {
        agentId: outcome.agentId,
        sessionId: outcome.sessionId,
        candidateIndex: outcome.candidateIndex,
      });
    } catch (error) {
      current = task(current.workspaceId);
      if (!["paused", "completed"].includes(current.phase))
        store.tasks.setPhase(current.workspaceId, "paused");
      store.tasks.updateControl(current.workspaceId, {
        blockingReason: "接续暂停：" + String(error),
      });
      reply("paused", String(error));
    }
  }
  function recordDelegation(
    current: Task,
    subtaskId: string,
    memberId: string,
    parentMemberId: string | undefined,
    requestId: string,
  ) {
    const delegations =
      current.control?.delegations && typeof current.control.delegations === "object"
        ? current.control.delegations
        : {};
    store.tasks.updateControl(current.workspaceId, {
      delegations: {
        ...delegations,
        [subtaskId]: { memberId, parentMemberId, confirmedAt: current.confirmedAt, requestId },
      },
    });
  }
  async function continuationSelection(
    current: Task,
    input: EventPayload<"context.continuation_requested">,
  ) {
    const role = input.role as ModelRole;
    const subtask = current.subtaskRuns.find((run) => run.agentId === input.agentId);
    let preset = findTaskActualPreset(current, { agentId: input.agentId, role });
    if (!preset) {
      const roles = await options.resolveRoles(current);
      preset = subtask
        ? (roles.subtaskPresets?.[subtask.subtaskId] ?? roles.subagent)
        : (roles[role] ?? undefined);
    }
    if (!preset) throw new Error("角色预设未启用");
    const candidateIndex =
      input.reason === "failure" ? input.candidateIndex + 1 : input.candidateIndex;
    return { role, subtask, candidateIndex, count: preset.models.length };
  }
  async function continueCandidates(
    current: Task,
    input: EventPayload<"context.continuation_requested">,
    old: AgentSession,
    oldMember: TaskConversationMember,
  ): Promise<ContinuationOutcome> {
    const selection = await continuationSelection(current, input);
    let from = old;
    for (let index = selection.candidateIndex; index < selection.count; index++) {
      const key =
        "continuation:" +
        input.requestId +
        (index === selection.candidateIndex ? "" : ":candidate:" + index);
      const saved = await handle(current).getDelivery({ clientMessageId: "task-flow:" + key });
      if (saved.error) throw new Error("接续投递核对失败：" + saved.error);
      let receipt = saved.delivery;
      if (!receipt) {
        if (runtime.getContinuation(from.id))
          throw new Error("接续仅有预登记，宿主尚未确认接受，请先核对投递与资源");
        receipt = await sendContinuationCandidate(input, oldMember, from, selection, index, key);
      }
      current = task(current.workspaceId);
      if (receipt?.status === "accepted")
        return completeCandidate(current, input, old, from, selection.subtask, index, receipt);
      from = await rejectedCandidate(current, from, index, key, receipt);
    }
    await stopContinuationTail(current, from);
    pauseFailedDelivery(
      current,
      "预设候选模型已耗尽，任务暂停，等待用户处理",
      selection.subtask?.subtaskId,
    );
    store.tasks.updateControl(current.workspaceId, {
      continuationInFlightId: null,
      autoContinuationBlocked: false,
      currentStep: "continuation_exhausted",
    });
    await publishPendingArtifacts(current.workspaceId);
    return { status: "exhausted", reason: "预设候选模型已耗尽，任务保持暂停" };
  }
  async function sendContinuationCandidate(
    input: EventPayload<"context.continuation_requested">,
    parent: TaskConversationMember,
    from: AgentSession,
    selection: Awaited<ReturnType<typeof continuationSelection>>,
    index: number,
    key: string,
  ) {
    let current = task(input.workspaceId!);
    store.tasks.updateControl(current.workspaceId, { continuationInFlightId: input.requestId });
    await stopContinuationTail(current, from);
    current = task(current.workspaceId);
    if (current.phase === "paused")
      current = store.tasks.setPhase(
        current.workspaceId,
        current.confirmedAt ? "executing" : "planning",
      );
    store.tasks.updateControl(current.workspaceId, { continuationInFlightId: input.requestId });
    if (selection.subtask)
      recordDelegation(
        current,
        selection.subtask.subtaskId,
        key,
        parent.parentMemberId,
        input.requestId,
      );
    const recipient = await options.resolveRecipient(current, selection.role, {
      candidateIndex: index,
      memberId: key,
      parentMemberId: parent.parentMemberId,
      subtaskId: selection.subtask?.subtaskId,
      fromSessionId: from.id,
    });
    try {
      const result = await handle(current).send({
        recipient,
        clientMessageId: "task-flow:" + key,
        text: await prompt(current, "board.task.continuation", {
          summary: input.summary,
          prompt: input.prompt,
        }),
      });
      if (!result.delivery) throw new Error(result.error ?? "宿主没有返回接续回执");
      return result.delivery;
    } catch (error) {
      const checked = await handle(current).getDelivery({ clientMessageId: "task-flow:" + key });
      if (checked.error || !checked.delivery)
        throw new Error("接续发送结果不明，请先核对原成员", { cause: error });
      return checked.delivery;
    }
  }
  async function stopContinuationTail(current: Task, from: AgentSession) {
    const native = await snapshot(current);
    const previousMember = native.members.find((member) => member.backendAgentId === from.agentId);
    if (previousMember) await stopMember(current, previousMember.memberId);
    else await options.releaseAgent?.(current.workspaceId, from.agentId);
  }
  async function rejectedCandidate(
    current: Task,
    from: AgentSession,
    index: number,
    key: string,
    receipt: TaskConversationDelivery | null,
  ): Promise<AgentSession> {
    if (receipt?.status !== "rejected")
      throw new Error("接续投递结果不明，保留原成员与资源，不能重发");
    const reason = receipt.error ?? "接续被宿主拒绝";
    if (classifyFailure(reason) === "other") throw new Error(reason);
    const native = await snapshot(current);
    const member = native.members.find((item) => item.backendAgentId === receipt.backendAgentId);
    if (member && (busyMember(member.status) || member.pendingPermissions?.length))
      throw new Error("被拒绝候选仍有在飞轮次或审批，暂停接续");
    const attempted = runtime.findSessionByAgent(receipt.backendAgentId);
    if (attempted && attempted.previousSessionId !== from.id)
      throw new Error("失败候选的接续来源不匹配");
    recordRejectedCandidate(current, index, key, reason, member, attempted);
    return attempted ?? from;
  }
  function recordRejectedCandidate(
    current: Task,
    index: number,
    key: string,
    reason: string,
    member?: TaskConversationMember,
    attempted?: AgentSession,
  ) {
    const sourceKey = "continuation-attempt:" + key;
    if (!store.taskArtifacts.get(current.workspaceId, "delivery", sourceKey))
      store.taskArtifacts.record({
        workspaceId: current.workspaceId,
        kind: "delivery",
        sourceKey,
        confirmedAt: current.confirmedAt,
        source: {
          conversationId: current.conversationId!,
          sourceKey: "human:task-flow:" + key,
          memberId: member?.memberId,
          backendAgentId: member?.backendAgentId,
        },
        summary: "候选模型拒绝接手：" + reason,
        data: {
          candidateIndex: index,
          provider: member?.config.provider ?? attempted?.currentProvider,
          model: member?.config.model ?? attempted?.model,
          status: "rejected",
        },
      });
  }
  async function completeCandidate(
    current: Task,
    input: EventPayload<"context.continuation_requested">,
    original: AgentSession,
    from: AgentSession,
    subtask: Task["subtaskRuns"][number] | undefined,
    index: number,
    receipt: TaskConversationDelivery,
  ): Promise<ContinuationOutcome> {
    const next = runtime.findSessionByAgent(receipt.backendAgentId);
    const native = await snapshot(current);
    if (
      !next ||
      next.previousSessionId !== from.id ||
      !native.members.some((member) => member.backendAgentId === next.agentId)
    )
      throw new Error("接续成员缺少已接受的真实成员与实际模型关联");
    store.tasks.updateControl(current.workspaceId, {
      autoContinuationBlocked: false,
      continuationInFlightId: null,
      currentStep: current.confirmedAt ? "executing" : "planning",
      blockingReason: null,
    });
    if (subtask)
      store.tasks.setSubtaskRun(current.workspaceId, {
        subtaskId: subtask.subtaskId,
        state: "running",
        agentId: next.agentId,
        actualModel: {
          provider: next.currentProvider,
          model: next.model!,
          ...(next.thinking ? { thinking: next.thinking } : {}),
        },
        continuation: {
          previousAgentId: original.agentId,
          summary: input.summary,
          candidateIndex: index,
        },
      });
    await publishPendingArtifacts(current.workspaceId);
    return {
      status: "continued",
      reason: "新成员已按冻结预设顺序准入并接续",
      agentId: next.agentId,
      sessionId: next.id,
      candidateIndex: index,
    };
  }
  function continuationSource(
    input: EventPayload<"context.continuation_requested">,
    current: Task,
  ) {
    const old = runtime.getSession(input.sessionId);
    if (
      !old ||
      old.agentId !== input.agentId ||
      old.workspaceId !== current.workspaceId ||
      current.confirmedAt !== input.confirmedAt ||
      !MODEL_ROLES.includes(input.role as ModelRole)
    )
      return undefined;
    return old;
  }
  async function stopMember(current: Task, memberId: string) {
    const stopped = await handle(current).stop({ memberId });
    if (
      stopped.error ||
      !stopped.conversation ||
      stopped.conversation.members.some(
        (member) => member.memberId === memberId && busyMember(member.status),
      )
    )
      throw new Error("旧成员停止不明");
  }
  async function recoverCompletedSourcesImpl(workspaceId: string) {
    let current = task(workspaceId);
    // This recovery runs in the same workspace queue as confirmation. An in-process
    // confirmation has already finished its finally; a remaining gate belongs to a crash.
    if (current.control?.confirmingRequestId)
      current = store.tasks.updateControl(workspaceId, { confirmingRequestId: null });
    const native = await snapshot(current);
    let cursor = { epoch: native.epoch, seq: 0 };
    const deliveries: TaskConversationRow[] = [];
    for (;;) {
      const response = await handle(current).fetch({ cursor, direction: "after", limit: 500 });
      if (response.error || !response.page) throw new Error(response.error ?? "任务历史源恢复失败");
      for (const row of response.page.rows) {
        if (!recoverableRow(row, native)) continue;
        recoverArtifact(current, row);
        if (
          ["worker", "subagent"].includes(row.speaker.role) &&
          current.confirmedAt &&
          row.createdAt >= current.confirmedAt
        )
          deliveries.push(row);
      }
      if (!response.page.hasNewer) break;
      const next = response.page.endCursor;
      if (!next || next.seq <= cursor.seq) throw new Error("任务历史源恢复分页不完整");
      cursor = next;
    }
    for (const row of deliveries) recoverSubtask(current, row);
    await recoverCurrentPlan(task(workspaceId), native);
    recoverWorkerPhase(task(workspaceId), native, deliveries);
    await publishPendingArtifacts(workspaceId);
  }
  async function recoverCurrentPlan(current: Task, native: TaskConversationSnapshot) {
    if (!["planning", "awaiting_confirmation"].includes(current.phase)) return;
    let latest: Awaited<ReturnType<typeof latestTaskPlan>>;
    try {
      latest = await latestTaskPlan(handle(current), native);
    } catch {
      return;
    }
    if (current.planSource?.sourceKey === latest.source.sourceKey) return;
    store.db.immediate(() => {
      store.tasks.savePlan(current.workspaceId, latest.plan);
      store.tasks.setPlanSource(current.workspaceId, latest.source);
      store.tasks.setSummary(current.workspaceId, "待确认方案：" + latest.plan.goal);
      store.tasks.updateControl(current.workspaceId, {
        currentStep: "awaiting_confirmation",
        blockingReason: null,
      });
    });
  }
  function recoverWorkerPhase(
    current: Task,
    native: TaskConversationSnapshot,
    deliveries: TaskConversationRow[],
  ) {
    if (
      current.phase === "executing" &&
      !native.members.some((member) => busyMember(member.status))
    ) {
      const worker = deliveries.findLast((row) => row.speaker?.role === "worker");
      const delivery = worker
        ? (blockJson(worker.text, "vibe-delivery") as { status?: string } | null)
        : null;
      if (
        delivery?.status === "completed" &&
        current.plan?.subtasks.every((subtask) =>
          current.subtaskRuns.some(
            (run) => run.subtaskId === subtask.id && run.state === "completed",
          ),
        )
      )
        store.tasks.setPhase(
          current.workspaceId,
          current.rolesSnapshot?.reviewer ? "reviewing" : "verifying",
        );
    }
  }
  function recoverableRow(
    row: TaskConversationRow,
    native: TaskConversationSnapshot,
  ): row is TaskConversationRow & { speaker: NonNullable<TaskConversationRow["speaker"]> } {
    return (
      row.kind === "assistant" &&
      !!row.completed &&
      !!row.speaker &&
      native.members.some(
        (member) =>
          member.memberId === row.speaker!.memberId &&
          member.backendAgentId === row.speaker!.backendAgentId,
      )
    );
  }
  function recoverArtifact(current: Task, row: TaskConversationRow) {
    const role = row.speaker!.role;
    const kind = roleArtifact[role];
    if (!kind || store.taskArtifacts.get(current.workspaceId, kind, row.sourceKey)) return;
    let data: Record<string, unknown> | undefined;
    let summary = row.text.slice(0, 240);
    if (kind === "plan") {
      try {
        const plan = parseTaskPlan(row.text);
        data = { plan };
        summary = "方案：" + plan.goal;
      } catch {
        return;
      }
    }
    if (kind === "delivery") {
      const delivery = blockJson(row.text, "vibe-delivery") as {
        status?: string;
        summary?: string;
      } | null;
      if (
        !delivery ||
        !["completed", "blocked"].includes(delivery.status ?? "") ||
        typeof delivery.summary !== "string"
      )
        return;
      summary = delivery.summary;
    }
    store.taskArtifacts.record({
      workspaceId: current.workspaceId,
      kind,
      sourceKey: row.sourceKey,
      confirmedAt:
        current.confirmedAt && row.createdAt >= current.confirmedAt ? current.confirmedAt : null,
      source: taskSource(current.conversationId!, row),
      summary,
      data,
    });
  }
  function recoverSubtask(current: Task, row: TaskConversationRow) {
    if (
      !["executing", "reviewing", "verifying", "paused"].includes(current.phase) ||
      row.speaker?.role !== "subagent"
    )
      return;
    const run = current.subtaskRuns.find((item) => item.agentId === row.speaker!.backendAgentId);
    const delivery = blockJson(row.text, "vibe-delivery") as {
      status?: string;
      summary?: string;
    } | null;
    if (
      !run ||
      !["running", "waiting"].includes(run.state) ||
      !delivery ||
      !["completed", "blocked"].includes(delivery.status ?? "") ||
      typeof delivery.summary !== "string"
    )
      return;
    store.tasks.setSubtaskRun(current.workspaceId, {
      subtaskId: run.subtaskId,
      state: delivery.status === "completed" ? "completed" : "paused",
      summary: delivery.summary,
    });
  }
  async function acceptCommand(input: TaskActionInput) {
    let active: { cancelled: boolean } | undefined;
    try {
      const finish = await serial(input.workspaceId, async () => {
        const current = task(input.workspaceId, input.conversationId);
        // Persist the authorization before any await or Git operation. A failed or crashed
        // attempt needs a fresh explicit user request; historical requests never authorize retries.
        const attemptKey = "accept-request:" + input.requestId;
        if (
          store.taskArtifacts.get(current.workspaceId, "git", attemptKey) ||
          current.control?.acceptanceRequestId === input.requestId ||
          (Array.isArray(current.control?.completedRequestIds) &&
            current.control.completedRequestIds.includes(input.requestId))
        ) {
          await publishPendingArtifacts(current.workspaceId);
          throw new Error("本次通过请求已经处理；请核对结果后重新点击通过");
        }
        store.taskArtifacts.record({
          workspaceId: current.workspaceId,
          kind: "git",
          sourceKey: attemptKey,
          confirmedAt: current.confirmedAt,
          source: input.source ?? { conversationId: input.conversationId, sourceKey: attemptKey },
          summary: "用户发起通过尝试",
          data: { action: "accept", requestId: input.requestId },
        });
        if (accepting.has(input.workspaceId))
          throw new Error("Git 收尾正在进行，请等待结果或先停止任务");
        active = { cancelled: false };
        accepting.set(input.workspaceId, active);
        return prepareAcceptance(current, input.requestId, input.source);
      });
      return await finish();
    } finally {
      if (active && accepting.get(input.workspaceId) === active)
        accepting.delete(input.workspaceId);
    }
  }
  return {
    command: (input: TaskActionInput) => {
      const parsed = TaskActionInputSchema.parse(input);
      if (parsed.action === "accept") return acceptCommand(parsed);
      if (parsed.action === "stop") {
        const active = accepting.get(parsed.workspaceId);
        const completed = task(parsed.workspaceId, parsed.conversationId).control
          ?.completedRequestIds;
        if (active && !(Array.isArray(completed) && completed.includes(parsed.requestId)))
          active.cancelled = true;
      }
      return serial(parsed.workspaceId, () => commandImpl(parsed));
    },
    delegate: (input: Parameters<typeof delegateImpl>[0]) =>
      serial(input.workspaceId, () => delegateImpl(input)),
    onTurnCompleted: (agentId: string, turn?: TaskTurnToken) => {
      if (turn && !turn.isCurrent()) return Promise.resolve();
      const session = runtime.findSessionByAgent(agentId);
      return session?.workspaceId
        ? serial(session.workspaceId, () => completedImpl(agentId, turn))
        : Promise.resolve();
    },
    handleEvent,
    publishPendingArtifacts,
    recoverCompletedSources: (workspaceId: string) =>
      serial(workspaceId, () => recoverCompletedSourcesImpl(workspaceId)),
  };
}
export type TaskConversationService = ReturnType<typeof createTaskConversationService>;
