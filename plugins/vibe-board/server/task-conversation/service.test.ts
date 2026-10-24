import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import type {
  TaskConversationRecipient,
  TaskConversationRow,
  TaskConversationSnapshot,
  TaskConversationDelivery,
} from "@getpaseo/protocol/messages";
import {
  createVibeStore,
  openVibeDb,
  migrateAll,
  createTaskRuntimeCommands,
  createTaskVerificationCommands,
  readEvents,
  type VibeDb,
} from "../vibe/db";
import { TaskRoleSnapshotSchema, TaskPresetSnapshotSchema, type TaskPlan } from "../vibe/contract";
import { createTaskConversationService, type TaskFlowOptions } from "./service";
import type { GitState, TaskGitFinalizeInput } from "./git";
import { TASK_FLOW_PROMPTS } from "./prompts";
import { TASK_HOST_PROMPTS } from "../task-host/prompts";

const databases: VibeDb[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function fixture() {
  const db = openVibeDb({ path: ":memory:" });
  databases.push(db);
  migrateAll(db);
  const store = createVibeStore(db, { deviceId: "wp115-test" });
  store.prompts.register([...TASK_HOST_PROMPTS, ...TASK_FLOW_PROMPTS], { pruneMissing: true });
  store.projects.create({
    name: "任务测试",
    prefix: "TEST",
    repoPath: "/main",
    projectType: "web",
    paseoProjectId: "native-project",
  });
  const preset = {
    presetId: "frozen",
    source: "global",
    models: [
      { provider: "codex", model: "test-model", thinking: "medium", permissionMode: "auto" },
    ],
    environmentKind: "project-default",
    runtimeEnv: null,
    instructions: "中文指令",
  };
  const roles = TaskRoleSnapshotSchema.parse({
    scout: null,
    planner: preset,
    plan_reviewer: preset,
    worker: preset,
    subagent: preset,
    reviewer: null,
    verifier: preset,
  });
  const plan: TaskPlan = {
    goal: "交付任务面板",
    approach: "复用宿主群聊",
    files: [],
    subtasks: [],
    checks: [{ text: "同一会话完成", method: "集成检查" }],
  };
  const row: TaskConversationRow = {
    id: "plan",
    epoch: "epoch",
    seq: 2,
    sourceKey: "planner-output",
    kind: "assistant",
    text: "```vibe-plan\n" + JSON.stringify(plan) + "\n```",
    completed: true,
    createdAt: "2026-10-23T00:00:00.000Z",
    speaker: {
      role: "planner",
      memberId: "planner",
      backendAgentId: "anchor",
      provider: "codex",
      model: "test-model",
    },
    source: { memberId: "planner", backendAgentId: "anchor", messageId: "plan-message" },
  };
  const native: TaskConversationSnapshot = {
    conversationId: "conversation",
    workspaceId: "workspace",
    anchorAgentId: "anchor",
    ownerPluginId: "vibe-board",
    status: "active",
    epoch: "epoch",
    lastSeq: 2,
    createdAt: row.createdAt,
    updatedAt: row.createdAt,
    members: [
      {
        memberId: "planner",
        backendAgentId: "anchor",
        role: "planner",
        status: "idle",
        config: { provider: "codex", model: "test-model", cwd: "/task" },
        seenConversationSeq: 0,
        lastRequestAt: null,
      },
    ],
  };
  store.tasks.create({
    workspaceId: "workspace",
    anchorAgentId: "anchor",
    conversationId: "conversation",
  });
  const runtime = createTaskRuntimeCommands(db);
  runtime.registerSession({
    workspaceId: "workspace",
    agentId: "anchor",
    role: "planner",
    provider: "codex",
    model: "test-model",
    candidateIndex: 0,
  });
  const querySource = vi.fn(async (_input: unknown) => ({ error: null, row }));
  const publish = vi.fn(async (input: { sourceKey: string; text: string }) => ({
    error: null,
    row: { ...row, kind: "artifact", sourceKey: input.sourceKey, text: input.text, seq: 10 },
  }));
  const receipts = new Map<string, TaskConversationDelivery>();
  const rejectedModels = new Set<string>();
  const unknownModels = new Set<string>();
  const send = vi.fn(
    async (input: { recipient: TaskConversationRecipient; clientMessageId: string }) => {
      const id = input.recipient.memberId ?? input.recipient.role;
      if (!native.members.some((m) => m.memberId === id))
        native.members.push({
          ...native.members[0]!,
          memberId: id,
          backendAgentId: id,
          role: input.recipient.role,
          config: input.recipient.config,
          parentMemberId: input.recipient.parentMemberId,
        });
      const registration = {
        workspaceId: "workspace",
        agentId: id,
        role: input.recipient.role as "worker",
        provider: "codex",
        model: input.recipient.config.model!,
        thinking: input.recipient.config.thinkingOptionId,
        candidateIndex: Number(input.recipient.env?.VIBE_CANDIDATE_INDEX ?? 0),
        confirmedAt: store.tasks.get("workspace")!.confirmedAt,
      };
      if (input.recipient.env?.VIBE_PREVIOUS_SESSION_ID)
        runtime.recordContinuation({
          fromSessionId: input.recipient.env.VIBE_PREVIOUS_SESSION_ID,
          ...registration,
          reason: "失败接续",
        });
      else runtime.registerSession(registration);
      let status: TaskConversationDelivery["status"] = "accepted";
      if (rejectedModels.has(input.recipient.config.model!)) status = "rejected";
      if (unknownModels.has(input.recipient.config.model!)) status = "unknown";
      const receipt: TaskConversationDelivery = {
        deliveryId: input.clientMessageId,
        conversationId: "conversation",
        throughSeq: 2,
        status,
        memberId: id,
        backendAgentId: id,
        clientMessageId: input.clientMessageId,
        error: rejectedModels.has(input.recipient.config.model!) ? "login expired" : null,
      };
      receipts.set(input.clientMessageId, receipt);
      return { error: null, delivery: receipt };
    },
  );
  const getDelivery = vi.fn(async (input: { clientMessageId: string }) => ({
    error: null,
    delivery:
      receipts.get(input.clientMessageId) ??
      (input.clientMessageId === "accept" ? { status: "accepted" } : null),
  }));
  const stop = vi.fn(async () => ({ error: null, conversation: native }));
  const fetch = vi.fn(async () => ({
    error: null,
    page: { rows: [] as TaskConversationRow[], hasNewer: false },
  }));
  const handle = {
    id: "conversation",
    refresh: async () => native,
    querySource,
    send,
    publish,
    stop,
    getDelivery,
    fetch,
  };
  const paseo = {
    taskConversations: { ref: () => handle },
    workspaces: {
      ref: () => ({
        refresh: async () => ({ projectId: "native-project", workspaceDirectory: "/task" }),
      }),
    },
  } as unknown as PaseoApi;
  const finalize = vi.fn(
    async (input: TaskGitFinalizeInput): Promise<GitState> => ({
      status: "completed" as const,
      verifiedCommit: input.verifiedCommit,
      mergedCommit: input.verifiedCommit,
      localMerged: true,
      message: "Git 收尾完成",
    }),
  );
  const releaseAgent = vi.fn(async () => {});
  const resolveRoles = vi.fn(() => roles);
  const flowOptions: TaskFlowOptions = {
    store,
    getPaseo: () => paseo,
    resolveRoles,
    resolveRecipient: async (current, role, options = {}) => {
      const from = options.fromSessionId ? runtime.getSession(options.fromSessionId) : undefined;
      const entries = Array.isArray(current.control?.actualModels)
        ? (current.control.actualModels as Array<{ agentId?: string; presetSnapshot?: unknown }>)
        : [];
      const frozen = TaskPresetSnapshotSchema.safeParse(
        entries.findLast((entry) => entry.agentId === from?.agentId)?.presetSnapshot,
      );
      const resolvedPreset = frozen.success ? frozen.data : roles[role];
      if (!resolvedPreset) throw new Error("测试角色已禁用");
      const index = options.candidateIndex ?? 0;
      const candidate = resolvedPreset.models[index];
      if (!candidate) throw new Error("测试候选不存在");
      return {
        role,
        memberId: options.memberId,
        parentMemberId: options.parentMemberId,
        env: {
          VIBE_CANDIDATE_INDEX: String(index),
          VIBE_RUNTIME_ENV: resolvedPreset.runtimeEnv ?? "",
          ...(options.fromSessionId ? { VIBE_PREVIOUS_SESSION_ID: options.fromSessionId } : {}),
        },
        config: {
          provider: "codex",
          model: candidate.model,
          cwd: "/task",
          thinkingOptionId: candidate.thinking,
          modeId: candidate.permissionMode,
          systemPrompt: resolvedPreset.instructions,
        },
      };
    },
    releaseAgent,
    git: { inspectCommit: async () => "a".repeat(40), finalize },
  };
  const service = createTaskConversationService(flowOptions);
  const action = (
    name: "execute" | "plan" | "review" | "verify" | "accept" | "stop",
    requestId = name,
  ) =>
    service.command({
      workspaceId: "workspace",
      conversationId: "conversation",
      action: name,
      requestId,
    });
  const confirm = async () => {
    await action("execute");
    store.tasks.setPhase("workspace", "executing");
  };
  const verified = (commit = "a".repeat(40)) => {
    store.tasks.setPhase("workspace", "verifying");
    const verification = createTaskVerificationCommands(db);
    const created = verification.create({
      workspaceId: "workspace",
      confirmedAt: store.tasks.get("workspace")!.confirmedAt!,
      projectId: store.projects.list()[0]!.id,
      commitHash: commit,
      checks: plan.checks,
    });
    verification.finish(created.verification.id, "pass");
    store.tasks.setPhase("workspace", "awaiting_acceptance");
  };
  const worker = () => {
    native.members.push({
      ...native.members[0]!,
      memberId: "worker",
      backendAgentId: "worker",
      role: "worker",
    });
    runtime.registerSession({
      workspaceId: "workspace",
      agentId: "worker",
      role: "worker",
      provider: "codex",
      model: "test-model",
      candidateIndex: 0,
    });
    row.speaker = { ...row.speaker!, role: "worker", memberId: "worker", backendAgentId: "worker" };
    row.source = { memberId: "worker", backendAgentId: "worker" };
    row.sourceKey = "worker-delivery";
  };
  return {
    db,
    store,
    service,
    roles,
    plan,
    row,
    native,
    action,
    confirm,
    worker,
    publish,
    send,
    querySource,
    getDelivery,
    stop,
    finalize,
    releaseAgent,
    fetch,
    receipts,
    rejectedModels,
    unknownModels,
    verified,
    resolveRoles,
    restartService: () => createTaskConversationService(flowOptions),
  };
}
describe("统一任务动作与编排", () => {
  it("执行注册提示准确使用公开委派标记，修改正文不能覆盖只读固定格式", () => {
    const f = fixture();
    const prompt = f.store.prompts.resolve("board.task.work");
    expect(prompt).toContain(
      "在公开回复中输出 vibe-delegate JSON 代码块，由任务流程服务登记并启动子任务",
    );
    expect(prompt).not.toContain("委派工具");
    const fixed = TASK_FLOW_PROMPTS.find((entry) => entry.key === "board.task.work")!.fixedSuffix!;
    f.store.prompts.setOverride("board.task.work", "请在已确认范围内完成任务。");
    expect(f.store.prompts.resolve("board.task.work")).toBe(
      "请在已确认范围内完成任务。\n\n" + fixed,
    );
    const rolePrompt = f.store.prompts.resolve("task.role.worker");
    expect(rolePrompt).toContain(fixed);
    expect(rolePrompt).not.toContain("委派工具");
  });
  it("执行冻结完整方案与七角色并原子保存确认沉淀，重复请求不再派发", async () => {
    const f = fixture();
    await f.action("execute");
    await f.action("execute");
    expect(f.store.tasks.get("workspace")).toMatchObject({
      phase: "queued",
      plan: f.plan,
      planSource: { sourceKey: "planner-output" },
      rolesSnapshot: { worker: { presetId: "frozen" }, subtaskPresets: {} },
    });
    expect(f.store.taskArtifacts.list("workspace")).toHaveLength(1);
    expect(f.publish).toHaveBeenCalledTimes(1);
    expect(f.send).not.toHaveBeenCalled();
    await expect(f.action("execute", "different-execute-request")).rejects.toThrow("已离开规划");
    expect(f.store.tasks.get("workspace")!.control!.confirmingRequestId).toBeNull();
  });
  it("调度准入将queued推进executing并只发起同一会话worker", async () => {
    const f = fixture();
    await f.action("execute");
    const event = {
      type: "scheduler.task_admitted",
      payload: {
        workspaceId: "workspace",
        confirmedAt: f.store.tasks.get("workspace")!.confirmedAt!,
        role: "worker",
        reservationId: "reservation",
        presetId: "frozen",
        provider: "codex",
        model: "test-model",
        port: 17115,
        deviceIds: [],
      },
    };
    await f.service.handleEvent(event as never);
    expect(f.store.tasks.get("workspace")!.phase).toBe("executing");
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it("普通完成提问不自动进入验证，明确交付必须验证", async () => {
    const f = fixture();
    await f.confirm();
    f.worker();
    f.row.text = "请确认这个问题";
    await f.service.onTurnCompleted("worker");
    expect(f.store.tasks.get("workspace")!.phase).toBe("executing");
    f.row.sourceKey = "final";
    f.row.text = '```vibe-delivery\n{"status":"completed","summary":"已交付"}\n```';
    await f.service.onTurnCompleted("worker");
    expect(f.store.tasks.get("workspace")!.phase).toBe("verifying");
    expect(f.releaseAgent).not.toHaveBeenCalled();
  });
  it.each(["stale", "wrong_source", "current"] as const)(
    "回合完成只处理当前代次且匹配原生turn来源：%s",
    async (kind) => {
      const f = fixture();
      await f.confirm();
      f.worker();
      f.row.text = '```vibe-delivery\n{"status":"completed","summary":"已交付"}\n```';
      f.row.source!.sourceTurnId = kind === "wrong_source" ? "new-turn" : "old-turn";
      const turn = {
        turnId: "old-turn",
        isCurrent: vi.fn(() => true),
        release: vi.fn(async () => {}),
      };
      if (kind === "stale") turn.isCurrent.mockReturnValueOnce(true).mockReturnValue(false);
      await f.service.onTurnCompleted("worker", turn);
      expect(f.store.tasks.get("workspace")!.phase).toBe(
        kind === "current" ? "verifying" : "executing",
      );
      expect(turn.release).toHaveBeenCalledTimes(kind === "stale" ? 0 : 1);
      expect(f.releaseAgent).not.toHaveBeenCalled();
    },
  );
  it("仍在运行的写入者不能被复核或验证按钮绕过", async () => {
    const f = fixture();
    await f.confirm();
    f.worker();
    f.native.members.at(-1)!.status = "running";
    await expect(f.action("verify")).rejects.toThrow("仍在运行");
  });
  it("子任务只允许主代理停轮后按依赖委派并保存parentMemberId，完成后交回主代理", async () => {
    const f = fixture();
    f.plan.subtasks.push(
      {
        id: "child",
        goal: "实现子任务",
        method: "改指定文件",
        notes: "中文注意事项",
        files: ["child.ts"],
        dependsOn: [],
        acceptance: "检查通过",
      },
      {
        id: "dependent",
        goal: "依赖子任务",
        method: "读取结果",
        notes: "",
        files: [],
        dependsOn: ["child"],
        acceptance: "有证据",
      },
    );
    f.row.text = "```vibe-plan\n" + JSON.stringify(f.plan) + "\n```";
    await f.confirm();
    f.worker();
    await expect(
      f.service.delegate({
        workspaceId: "workspace",
        subtaskId: "dependent",
        parentMemberId: "worker",
        requestId: "dependent",
      }),
    ).rejects.toThrow("前置依赖");
    f.native.members.at(-1)!.status = "running";
    await expect(
      f.service.delegate({
        workspaceId: "workspace",
        subtaskId: "child",
        parentMemberId: "worker",
        requestId: "child",
      }),
    ).rejects.toThrow("先结束本轮");
    f.native.members.at(-1)!.status = "idle";
    await f.service.delegate({
      workspaceId: "workspace",
      subtaskId: "child",
      parentMemberId: "worker",
      requestId: "child",
    });
    expect(f.send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        recipient: expect.objectContaining({ role: "subagent", parentMemberId: "worker" }),
      }),
    );
    expect(f.store.tasks.get("workspace")!.subtaskRuns[0]).toMatchObject({
      subtaskId: "child",
      state: "running",
      agentId: "subtask:child",
    });
    f.row.sourceKey = "child-output";
    f.row.speaker = {
      ...f.row.speaker!,
      role: "subagent",
      memberId: "subtask:child",
      backendAgentId: "subtask:child",
    };
    f.row.source = { memberId: "subtask:child", backendAgentId: "subtask:child" };
    f.row.text = '```vibe-delivery\n{"status":"completed","summary":"子任务已交付"}\n```';
    await f.service.onTurnCompleted("subtask:child");
    expect(f.store.tasks.get("workspace")!.subtaskRuns[0]!.state).toBe("completed");
    expect(f.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ recipient: expect.objectContaining({ role: "worker" }) }),
    );
    expect(f.store.tasks.get("workspace")!.phase).toBe("executing");
  });
  it("修改方案先停止旧执行且撤销确认，历史沉淀保留", async () => {
    const f = fixture();
    await f.confirm();
    await f.action("plan");
    expect(f.stop).toHaveBeenCalledTimes(1);
    expect(f.store.tasks.get("workspace")).toMatchObject({ phase: "planning", confirmedAt: null });
    expect(f.store.taskArtifacts.list("workspace")).toHaveLength(1);
    await f.action("execute");
    expect(f.store.tasks.get("workspace")!.phase).toBe("planning");
  });
  it("停止不明不能撤销旧写锁或启动新规划", async () => {
    const f = fixture();
    await f.confirm();
    f.native.status = "stopping";
    await expect(f.action("plan")).rejects.toThrow("停止结果不明");
    expect(f.send).not.toHaveBeenCalled();
    expect(f.store.tasks.get("workspace")!.confirmedAt).not.toBeNull();
  });
  it("最新完整规划完成后显示新目标与待确认状态，清除旧停止摘要和阻塞提示", async () => {
    const f = fixture();
    f.store.tasks.setSummary("workspace", "任务成员已停止；等待显式接续或重新制定方案");
    f.store.tasks.updateControl("workspace", { currentStep: "paused", blockingReason: "旧停止" });
    await f.service.onTurnCompleted("anchor");
    expect(f.store.tasks.get("workspace")).toMatchObject({
      phase: "awaiting_confirmation",
      summary: "待确认方案：" + f.plan.goal,
      control: { currentStep: "awaiting_confirmation", blockingReason: null },
    });
  });
  it.each([false, true])(
    "显式重新规划创建新成员，已停止planner/scout不复活，探路后规划也可继续：scout=%s",
    async (scoutEnabled) => {
      const f = fixture();
      if (scoutEnabled) f.roles.scout = { ...f.roles.planner };
      const runtime = createTaskRuntimeCommands(f.db);
      const planner = runtime.findSessionByAgent("anchor")!;
      f.store.sessions.setState(planner.id, "ended", { outcome: "canceled" });
      const scout = runtime.registerSession({
        workspaceId: "workspace",
        agentId: "old-scout",
        role: "scout",
        provider: "codex",
        model: "test-model",
        candidateIndex: 0,
      });
      f.store.sessions.setState(scout.id, "ended", { outcome: "closed" });
      f.native.members.push({
        ...f.native.members[0]!,
        memberId: "old-scout",
        backendAgentId: "old-scout",
        role: "scout",
      });
      await f.confirm();
      const artifactsBefore = f.store.taskArtifacts.list("workspace").length;
      await f.action("plan", "explicit-new-plan");
      const first = f.send.mock.calls.at(-1)![0].recipient;
      expect(first.memberId).toBe("plan:explicit-new-plan:" + (scoutEnabled ? "scout" : "planner"));
      expect(f.store.tasks.get("workspace")).toMatchObject({
        phase: "planning",
        confirmedAt: null,
      });
      expect(f.store.taskArtifacts.list("workspace")).toHaveLength(artifactsBefore);
      if (scoutEnabled) {
        const scoutId = first.memberId!;
        f.row.speaker = {
          ...f.row.speaker!,
          role: "scout",
          memberId: scoutId,
          backendAgentId: scoutId,
        };
        f.row.source = { memberId: scoutId, backendAgentId: scoutId };
        f.row.sourceKey = "new-scout-output";
        f.row.text = "新探路结论";
        await f.service.onTurnCompleted(scoutId);
        expect(f.send).toHaveBeenLastCalledWith(
          expect.objectContaining({
            recipient: expect.objectContaining({
              role: "planner",
              memberId: "flow:source:new-scout-output:planner:planner",
            }),
          }),
        );
        expect(f.store.tasks.get("workspace")!.phase).toBe("planning");
      }
      expect(runtime.getSession(planner.id)!.state).toBe("ended");
      expect(runtime.getSession(scout.id)!.state).toBe("ended");
      expect(f.native.members.some((member) => member.backendAgentId === "anchor")).toBe(true);
      expect(f.native.members.some((member) => member.backendAgentId === "old-scout")).toBe(true);
      const sent = f.send.mock.calls.length;
      await f.action("plan", "explicit-new-plan");
      expect(f.send).toHaveBeenCalledTimes(sent);
    },
  );
  it("沉淀发布失败仍保留已确认快照，重启补发不重复授权", async () => {
    const f = fixture();
    f.publish.mockRejectedValueOnce(new Error("宿主暂不可用"));
    await expect(f.action("execute")).rejects.toThrow("宿主暂不可用");
    expect(f.store.tasks.get("workspace")!.phase).toBe("queued");
    expect(f.store.taskArtifacts.pendingPublish("workspace")).toHaveLength(1);
    await f.service.publishPendingArtifacts("workspace");
    await f.action("execute");
    expect(f.store.taskArtifacts.pendingPublish("workspace")).toHaveLength(0);
    expect(f.store.taskArtifacts.list("workspace")).toHaveLength(1);
    expect(f.send).not.toHaveBeenCalled();
  });
  it("失败接续先停止原成员，并按冻结候选创建同会话新成员及持久关联", async () => {
    const f = fixture();
    f.roles.worker.models.push({ ...f.roles.worker.models[0]!, model: "next-model" });
    await f.confirm();
    f.worker();
    f.stop.mockImplementation(async () => {
      f.store.tasks.setPhase("workspace", "paused");
      return { error: null, conversation: f.native };
    });
    const old = createTaskRuntimeCommands(f.db).findSessionByAgent("worker")!;
    const event = {
      type: "context.continuation_requested",
      payload: {
        requestId: "replacement",
        workspaceId: "workspace",
        sessionId: old.id,
        agentId: "worker",
        role: "worker",
        reason: "failure",
        message: "登录失效",
        summary: "已完成定位",
        candidateIndex: 0,
        confirmedAt: f.store.tasks.get("workspace")!.confirmedAt,
        prompt: "继续已确认范围",
      },
    };
    await f.service.handleEvent(event as never);
    expect(f.stop).toHaveBeenCalledWith({ memberId: "worker" });
    expect(f.send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        recipient: expect.objectContaining({
          memberId: "continuation:replacement",
          config: expect.objectContaining({ model: "next-model" }),
        }),
      }),
    );
    expect(createTaskRuntimeCommands(f.db).getContinuation(old.id)).toMatchObject({
      agentId: "continuation:replacement",
      model: "next-model",
      candidateIndex: 1,
    });
    expect(f.store.tasks.get("workspace")!.rolesSnapshot!.worker.models[0]!.model).toBe(
      "test-model",
    );
    await f.service.handleEvent(event as never);
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it("显式停止后旧失败请求不能自动重启任务", async () => {
    const f = fixture();
    f.roles.worker.models.push({ ...f.roles.worker.models[0]!, model: "next-model" });
    await f.confirm();
    f.worker();
    const old = createTaskRuntimeCommands(f.db).findSessionByAgent("worker")!;
    await f.action("stop");
    await f.service.handleEvent({
      type: "context.continuation_requested",
      payload: {
        requestId: "late-failure",
        workspaceId: "workspace",
        sessionId: old.id,
        agentId: "worker",
        role: "worker",
        reason: "failure",
        message: "失效",
        summary: "摘要",
        candidateIndex: 0,
        confirmedAt: f.store.tasks.get("workspace")!.confirmedAt,
        prompt: "接续",
      },
    } as never);
    expect(f.store.tasks.get("workspace")!.phase).toBe("paused");
    expect(f.send).not.toHaveBeenCalled();
  });
  it.each(["review", "verify"] as const)(
    "停止后显式%s清除旧阻塞提示但不恢复worker自动接续",
    async (action) => {
      const f = fixture();
      if (action === "review") f.roles.reviewer = { ...f.roles.planner };
      f.roles.worker.models.push({ ...f.roles.worker.models[0]!, model: "next-model" });
      await f.confirm();
      f.worker();
      const old = createTaskRuntimeCommands(f.db).findSessionByAgent("worker")!;
      await f.action("stop");
      expect(f.store.tasks.get("workspace")!.control).toMatchObject({
        blockingReason: "用户停止任务",
        currentStep: "paused",
        autoContinuationBlocked: true,
      });
      await f.action(action);
      const next = action === "review" ? "reviewing" : "verifying";
      expect(f.store.tasks.get("workspace")).toMatchObject({
        phase: next,
        control: { blockingReason: null, currentStep: next, autoContinuationBlocked: true },
      });
      await f.service.handleEvent({
        type: "context.continuation_requested",
        payload: {
          requestId: "stale-" + action,
          workspaceId: "workspace",
          sessionId: old.id,
          agentId: "worker",
          role: "worker",
          reason: "failure",
          message: "login expired",
          summary: "旧轮摘要",
          candidateIndex: 0,
          confirmedAt: f.store.tasks.get("workspace")!.confirmedAt,
          prompt: "继续旧轮",
        },
      } as never);
      expect(f.store.tasks.get("workspace")!.phase).toBe(next);
      expect(
        readEvents(f.db, 0, { types: ["context.continuation_result"] }).at(-1)!.payload,
      ).toMatchObject({ status: "paused", reason: expect.stringContaining("显式停止") });
      expect(f.send).not.toHaveBeenCalled();
    },
  );
  it("探路开启时完整保留本轮修改要求并交给规划成员", async () => {
    const f = fixture();
    f.roles.scout = { ...f.roles.planner };
    await f.service.command({
      workspaceId: "workspace",
      conversationId: "conversation",
      requestId: "revise",
      action: "plan",
      reason: "改为仅实现Web入口",
    });
    expect(f.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: expect.stringContaining("改为仅实现Web入口") }),
    );
    const scoutId = f.send.mock.calls.at(-1)![0].recipient.memberId!;
    f.row.speaker = {
      ...f.row.speaker!,
      role: "scout",
      memberId: scoutId,
      backendAgentId: scoutId,
    };
    f.row.source = { memberId: scoutId, backendAgentId: scoutId };
    f.row.sourceKey = "scout-source";
    f.row.text = "探路结论：复用现有入口。";
    await f.service.onTurnCompleted(scoutId);
    expect(f.send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        recipient: expect.objectContaining({ role: "planner" }),
        text: expect.stringContaining("改为仅实现Web入口"),
      }),
    );
    expect(f.store.taskArtifacts.list("workspace")[0]!.summary).toContain("复用现有入口");
  });
  it("重启后补回已完成交付并推进必验证，不重发执行消息或历史通过", async () => {
    const f = fixture();
    await f.confirm();
    f.worker();
    f.row.createdAt = new Date(Date.now() + 1000).toISOString();
    f.row.text = '```vibe-delivery\n{"status":"completed","summary":"崩溃前已交付"}\n```';
    f.fetch.mockResolvedValue({ error: null, page: { rows: [f.row], hasNewer: false } });
    await f.service.recoverCompletedSources("workspace");
    await f.service.recoverCompletedSources("workspace");
    expect(f.store.tasks.get("workspace")!.phase).toBe("verifying");
    expect(f.store.taskArtifacts.list("workspace", { kind: "delivery" })).toHaveLength(1);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.finalize).not.toHaveBeenCalled();
  });
  it("暂停任务恢复子任务完成记录时保留暂停且不重发主代理", async () => {
    const f = fixture();
    f.plan.subtasks.push({
      id: "child",
      goal: "子任务",
      method: "实现",
      notes: "",
      files: [],
      dependsOn: [],
      acceptance: "完成",
    });
    f.row.text = "```vibe-plan\n" + JSON.stringify(f.plan) + "\n```";
    await f.confirm();
    f.worker();
    await f.service.delegate({
      workspaceId: "workspace",
      subtaskId: "child",
      parentMemberId: "worker",
      requestId: "child",
    });
    f.store.tasks.setPhase("workspace", "paused");
    f.row.speaker = {
      ...f.row.speaker!,
      role: "subagent",
      memberId: "subtask:child",
      backendAgentId: "subtask:child",
    };
    f.row.source = { memberId: "subtask:child", backendAgentId: "subtask:child" };
    f.row.sourceKey = "recovered-child";
    f.row.createdAt = new Date(Date.now() + 1000).toISOString();
    f.row.text = '```vibe-delivery\n{"status":"completed","summary":"子任务已完成"}\n```';
    f.fetch.mockResolvedValue({ error: null, page: { rows: [f.row], hasNewer: false } });
    await f.service.recoverCompletedSources("workspace");
    expect(f.store.tasks.get("workspace")!.phase).toBe("paused");
    expect(f.store.tasks.get("workspace")!.subtaskRuns[0]!.state).toBe("completed");
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it("只有预登记的接续agent不能在重放时假报已接续", async () => {
    const f = fixture();
    f.roles.worker.models.push({ ...f.roles.worker.models[0]!, model: "next-model" });
    await f.confirm();
    f.worker();
    f.store.tasks.setPhase("workspace", "paused");
    const runtime = createTaskRuntimeCommands(f.db);
    const old = runtime.findSessionByAgent("worker")!;
    runtime.recordContinuation({
      fromSessionId: old.id,
      agentId: "orphan",
      provider: "codex",
      model: "next-model",
      candidateIndex: 1,
      reason: "准入后创建失败",
    });
    await f.service.handleEvent({
      type: "context.continuation_requested",
      payload: {
        requestId: "orphan-request",
        workspaceId: "workspace",
        sessionId: old.id,
        agentId: "worker",
        role: "worker",
        reason: "failure",
        message: "失效",
        summary: "摘要",
        candidateIndex: 0,
        confirmedAt: f.store.tasks.get("workspace")!.confirmedAt,
        prompt: "接续",
      },
    } as never);
    expect(
      readEvents(f.db, 0, { types: ["context.continuation_result"] }).at(-1)!.payload,
    ).toMatchObject({ status: "paused", reason: expect.stringContaining("预登记") });
    expect(f.send).not.toHaveBeenCalled();
  });
  it("两个候选明确模型拒绝后按序接第三候选，保留尝试链且重放不重复投递", async () => {
    const f = fixture();
    for (const model of ["rejected-1", "rejected-2", "accepted-3"])
      f.roles.worker.models.push({ ...f.roles.worker.models[0]!, model });
    f.rejectedModels.add("rejected-1");
    f.rejectedModels.add("rejected-2");
    await f.confirm();
    f.worker();
    f.stop.mockImplementation(async () => {
      f.store.tasks.setPhase("workspace", "paused");
      return { error: null, conversation: f.native };
    });
    const runtime = createTaskRuntimeCommands(f.db);
    const old = runtime.findSessionByAgent("worker")!;
    const event = {
      type: "context.continuation_requested",
      payload: {
        requestId: "ordered",
        workspaceId: "workspace",
        sessionId: old.id,
        agentId: "worker",
        role: "worker",
        reason: "failure",
        message: "login expired",
        summary: "接续摘要",
        candidateIndex: 0,
        confirmedAt: f.store.tasks.get("workspace")!.confirmedAt,
        prompt: "继续",
      },
    };
    await f.service.handleEvent(event as never);
    const first = runtime.getContinuation(old.id)!;
    const second = runtime.getContinuation(first.id)!;
    const third = runtime.getContinuation(second.id)!;
    expect([first.model, second.model, third.model]).toEqual([
      "rejected-1",
      "rejected-2",
      "accepted-3",
    ]);
    expect(
      readEvents(f.db, 0, { types: ["context.continuation_result"] }).at(-1)!.payload,
    ).toMatchObject({ status: "continued", agentId: third.agentId, candidateIndex: 3 });
    expect(f.send).toHaveBeenCalledTimes(3);
    expect(f.store.taskArtifacts.list("workspace", { kind: "delivery" })).toHaveLength(2);
    await f.service.handleEvent(event as never);
    expect(f.send).toHaveBeenCalledTimes(3);
    expect(f.stop).toHaveBeenCalledTimes(3);
  });
  it("候选全部明确拒绝后报告耗尽并暂停，unknown结果绝不尝试下一模型", async () => {
    const f = fixture();
    for (const model of ["rejected-1", "rejected-2"]) {
      f.roles.worker.models.push({ ...f.roles.worker.models[0]!, model });
      f.rejectedModels.add(model);
    }
    await f.confirm();
    f.worker();
    const old = createTaskRuntimeCommands(f.db).findSessionByAgent("worker")!;
    const event = {
      type: "context.continuation_requested",
      payload: {
        requestId: "exhausted",
        workspaceId: "workspace",
        sessionId: old.id,
        agentId: "worker",
        role: "worker",
        reason: "failure",
        message: "login expired",
        summary: "摘要",
        candidateIndex: 0,
        confirmedAt: f.store.tasks.get("workspace")!.confirmedAt,
        prompt: "继续",
      },
    };
    await f.service.handleEvent(event as never);
    expect(
      readEvents(f.db, 0, { types: ["context.continuation_result"] }).at(-1)!.payload,
    ).toMatchObject({ status: "exhausted" });
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.store.tasks.get("workspace")!.phase).toBe("paused");
    const u = fixture();
    for (const model of ["unknown-1", "unused-2"])
      u.roles.worker.models.push({ ...u.roles.worker.models[0]!, model });
    u.unknownModels.add("unknown-1");
    await u.confirm();
    u.worker();
    const source = createTaskRuntimeCommands(u.db).findSessionByAgent("worker")!;
    await u.service.handleEvent({
      ...event,
      payload: {
        ...event.payload,
        requestId: "unknown",
        sessionId: source.id,
        confirmedAt: u.store.tasks.get("workspace")!.confirmedAt,
      },
    } as never);
    expect(
      readEvents(u.db, 0, { types: ["context.continuation_result"] }).at(-1)!.payload,
    ).toMatchObject({ status: "paused", reason: expect.stringContaining("不明") });
    expect(u.send).toHaveBeenCalledTimes(1);
  });
  it("主动换预设后使用实际覆盖快照的候选数，冻结默认保持不变", async () => {
    const f = fixture();
    await f.confirm();
    f.worker();
    const actualPreset = {
      ...f.roles.worker,
      presetId: "manual-preset",
      runtimeEnv: "FROZEN_ENV=original",
      instructions: "冻结原始中文指令",
      models: [
        { ...f.roles.worker.models[0]! },
        {
          ...f.roles.worker.models[0]!,
          model: "manual-next",
          thinking: "high",
          permissionMode: "accept-edits" as const,
        },
      ],
    };
    f.store.tasks.updateControl("workspace", {
      actualModels: [
        {
          agentId: "worker",
          role: "worker",
          confirmedAt: f.store.tasks.get("workspace")!.confirmedAt,
          presetSnapshot: actualPreset,
          admitted: false,
        },
      ],
    });
    f.store.presets.create({
      id: actualPreset.presetId,
      name: "实际覆盖",
      provider: "codex",
      model: "test-model",
      models: actualPreset.models,
      runtimeEnv: actualPreset.runtimeEnv,
      instructions: actualPreset.instructions,
    });
    f.store.presets.update(actualPreset.presetId, {
      models: [
        {
          ...actualPreset.models[0]!,
          model: "edited-model",
          thinking: "low",
          permissionMode: "full",
        },
      ],
      runtimeEnv: "EDITED_ENV=changed",
      instructions: "已改动指令",
    });
    f.store.presets.delete(actualPreset.presetId);
    expect(f.store.presets.get(actualPreset.presetId)).toBeUndefined();
    f.resolveRoles.mockImplementation(() => {
      throw new Error("运行中实际覆盖不应再读取实时默认");
    });
    const old = createTaskRuntimeCommands(f.db).findSessionByAgent("worker")!;
    await f.service.handleEvent({
      type: "context.continuation_requested",
      payload: {
        requestId: "manual-next",
        workspaceId: "workspace",
        sessionId: old.id,
        agentId: "worker",
        role: "worker",
        reason: "failure",
        message: "login expired",
        summary: "摘要",
        candidateIndex: 0,
        confirmedAt: f.store.tasks.get("workspace")!.confirmedAt,
        prompt: "继续",
      },
    } as never);
    expect(f.send).toHaveBeenCalledWith(
      expect.objectContaining({
        recipient: expect.objectContaining({
          config: expect.objectContaining({
            model: "manual-next",
            thinkingOptionId: "high",
            modeId: "accept-edits",
            systemPrompt: "冻结原始中文指令",
          }),
          env: expect.objectContaining({ VIBE_RUNTIME_ENV: "FROZEN_ENV=original" }),
        }),
      }),
    );
    expect(
      readEvents(f.db, 0, { types: ["context.continuation_result"] }).at(-1)!.payload,
    ).toMatchObject({ status: "continued", candidateIndex: 1 });
    expect(f.store.tasks.get("workspace")!.rolesSnapshot!.worker.models).toHaveLength(1);
  });
  it("Git需要重验时暂停并开放验证，新pass不会被旧Git状态卡住", async () => {
    const f = fixture();
    await f.confirm();
    f.verified();
    f.finalize.mockResolvedValueOnce({
      status: "verification_required",
      verifiedCommit: "a".repeat(40),
      localMerged: false,
      reason: "merge_needs_verification",
      message: "合并结果需重新验证",
    });
    await f.action("accept");
    expect(f.store.tasks.get("workspace")!.phase).toBe("paused");
    expect(f.store.tasks.get("workspace")!.control!.blockingReason).toBe("合并结果需重新验证");
    await f.action("verify");
    expect(f.store.tasks.get("workspace")!.phase).toBe("verifying");
    f.verified("b".repeat(40));
    await f.action("accept", "accept-new-pass");
    expect(f.finalize.mock.calls[1]![0]).toMatchObject({
      verifiedCommit: "b".repeat(40),
      previous: undefined,
    });
    expect(f.store.tasks.get("workspace")!.phase).toBe("completed");
  });
  it("新规划源完成后崩溃，恢复最新方案定位后允许确认而不回退旧方案", async () => {
    const f = fixture();
    await f.service.onTurnCompleted("anchor");
    expect(f.store.tasks.get("workspace")!.planSource!.sourceKey).toBe("planner-output");
    f.row.sourceKey = "planner-new-output";
    f.row.seq = 5;
    f.plan.goal = "新规划目标";
    f.row.text = "```vibe-plan\n" + JSON.stringify(f.plan) + "\n```";
    f.fetch.mockResolvedValue({ error: null, page: { rows: [f.row], hasNewer: false } });
    await f.service.recoverCompletedSources("workspace");
    expect(f.store.tasks.get("workspace")!.planSource!.sourceKey).toBe("planner-new-output");
    await f.action("execute");
    expect(f.store.tasks.get("workspace")!.plan!.goal).toBe("新规划目标");
    expect(f.send).not.toHaveBeenCalled();
  });
  it("重启恢复清理同一规划源的残留确认门闩，随后可以正常确认", async () => {
    const f = fixture();
    await f.service.onTurnCompleted("anchor");
    f.store.tasks.updateControl("workspace", { confirmingRequestId: "crashed-confirmation" });
    const restarted = f.restartService();
    await restarted.recoverCompletedSources("workspace");
    expect(f.store.tasks.get("workspace")!.planSource!.sourceKey).toBe("planner-output");
    expect(f.store.tasks.get("workspace")!.control!.confirmingRequestId).toBeNull();
    await restarted.command({
      workspaceId: "workspace",
      conversationId: "conversation",
      action: "execute",
      requestId: "after-restart",
    });
    expect(f.store.tasks.get("workspace")!.phase).toBe("queued");
  });
  it("同进程恢复排在活跃确认之后，不能提前清除正在核对方案的门闩", async () => {
    const f = fixture();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.querySource.mockImplementationOnce(async () => {
      entered();
      await hold;
      return { error: null, row: f.row };
    });
    const confirming = f.action("execute");
    await started;
    expect(f.store.tasks.get("workspace")!.control!.confirmingRequestId).toBe("execute");
    const recovering = f.service.recoverCompletedSources("workspace");
    await Promise.resolve();
    expect(f.store.tasks.get("workspace")!.control!.confirmingRequestId).toBe("execute");
    expect(f.fetch).not.toHaveBeenCalled();
    release();
    await confirming;
    await recovering;
    expect(f.store.tasks.get("workspace")!.phase).toBe("queued");
    expect(f.store.tasks.get("workspace")!.control!.confirmingRequestId).toBeNull();
  });
  it("无本轮最新pass时通过不能启动Git", async () => {
    const f = fixture();
    await f.confirm();
    f.store.tasks.setPhase("workspace", "verifying");
    f.store.tasks.setPhase("workspace", "awaiting_acceptance");
    await expect(f.action("accept")).rejects.toThrow("最新验证");
    expect(f.finalize).not.toHaveBeenCalled();
    expect(f.store.taskArtifacts.get("workspace", "git", "accept-request:accept")).toBeDefined();
    await expect(f.action("accept")).rejects.toThrow("本次通过请求已经处理");
  });
  it("历史普通通过发言不能触发Git，只有显式任务命令授权", async () => {
    const f = fixture();
    await f.confirm();
    f.verified();
    f.row.kind = "user";
    f.row.text = "通过";
    f.fetch.mockResolvedValue({ error: null, page: { rows: [f.row], hasNewer: false } });
    await f.service.recoverCompletedSources("workspace");
    expect(f.finalize).not.toHaveBeenCalled();
    await f.action("accept");
    expect(f.finalize).toHaveBeenCalledTimes(1);
    expect(f.store.tasks.get("workspace")!.phase).toBe("completed");
  });
  it("Git网络等待不占用任务队列，Stop先完成并让Git在安全点取消", async () => {
    const f = fixture();
    await f.confirm();
    f.verified();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.finalize.mockImplementationOnce(async (input) => {
      entered();
      await hold;
      expect(input.isCancelled?.()).toBe(true);
      return {
        status: "pending_push",
        localMerged: true,
        verifiedCommit: input.verifiedCommit,
        message: "已停止",
      };
    });
    const acceptance = f.action("accept");
    await started;
    await f.action("stop");
    expect(f.store.tasks.get("workspace")!.phase).toBe("paused");
    release();
    await acceptance;
    expect(f.store.tasks.get("workspace")!.phase).toBe("paused");
    expect(f.store.tasks.get("workspace")!.control!.git).toMatchObject({ status: "pending_push" });
    expect(f.store.tasks.get("workspace")!.control!.completedRequestIds).toContain("stop");
  });
  it("同requestId部分失败后禁止重放，新授权才重试并保留尝试记录", async () => {
    const f = fixture();
    await f.confirm();
    f.verified();
    f.finalize.mockResolvedValueOnce({
      status: "pending_push",
      verifiedCommit: "a".repeat(40),
      localMerged: true,
      message: "push失败",
    });
    await f.action("accept");
    await expect(f.action("accept")).rejects.toThrow("本次通过请求已经处理");
    expect(f.finalize).toHaveBeenCalledTimes(1);
    await f.action("accept", "accept-new");
    expect(f.finalize).toHaveBeenCalledTimes(2);
    expect(
      f.store.taskArtifacts.list("workspace").filter((item) => item.kind === "git"),
    ).toHaveLength(4);
    expect(f.store.tasks.get("workspace")!.phase).toBe("completed");
  });
  it("收尾忙碌时的新通过尝试也落盘，原收尾失败后不能重放该请求", async () => {
    const f = fixture();
    await f.confirm();
    f.verified();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.finalize.mockImplementationOnce(async (input) => {
      entered();
      await hold;
      return {
        status: "pending_push",
        localMerged: true,
        verifiedCommit: input.verifiedCommit,
        message: "push失败",
      };
    });
    const original = f.action("accept", "accept-first");
    await started;
    await expect(f.action("accept", "accept-busy")).rejects.toThrow("Git 收尾正在进行");
    expect(
      f.store.taskArtifacts.get("workspace", "git", "accept-request:accept-busy"),
    ).toBeDefined();
    release();
    await original;
    await expect(f.action("accept", "accept-busy")).rejects.toThrow("本次通过请求已经处理");
    expect(f.finalize).toHaveBeenCalledTimes(1);
  });
  it("旧Stop请求的重试不能取消后来的Git收尾", async () => {
    const f = fixture();
    await f.confirm();
    await f.action("stop");
    f.verified();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.finalize.mockImplementationOnce(async (input) => {
      entered();
      await hold;
      expect(input.isCancelled?.()).toBe(false);
      return {
        status: "completed",
        localMerged: true,
        verifiedCommit: input.verifiedCommit,
        message: "完成",
      };
    });
    const acceptance = f.action("accept");
    await started;
    await f.action("stop");
    release();
    await acceptance;
    expect(f.store.tasks.get("workspace")!.phase).toBe("completed");
  });
  it("Git完成后群聊发布失败，同请求补发布后拒绝再次授权，不重复Git", async () => {
    const f = fixture();
    await f.confirm();
    f.verified();
    f.publish.mockRejectedValueOnce(new Error("群聊暂不可用"));
    await expect(f.action("accept")).rejects.toThrow("群聊暂不可用");
    expect(f.store.tasks.get("workspace")!.phase).toBe("completed");
    await expect(f.action("accept")).rejects.toThrow("本次通过请求已经处理");
    expect(f.finalize).toHaveBeenCalledTimes(1);
    expect(f.store.taskArtifacts.pendingPublish("workspace")).toHaveLength(0);
    expect(f.store.taskArtifacts.get("workspace", "git", "accept-request:accept")).toBeDefined();
  });
  it("control处理记录裁剪且保留最近请求", async () => {
    const f = fixture();
    f.store.tasks.updateControl("workspace", {
      completedRequestIds: Array.from({ length: 256 }, (_, i) => "old" + i),
    });
    await f.action("stop");
    const completed = f.store.tasks.get("workspace")!.control!.completedRequestIds as string[];
    expect(completed).toHaveLength(256);
    expect(completed).not.toContain("old0");
    expect(completed.at(-1)).toBe("stop");
  });
});
