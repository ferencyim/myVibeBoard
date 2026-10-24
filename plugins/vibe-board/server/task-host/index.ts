import type { PaseoApi } from "@getpaseo/client";
import type { TaskConversationRow, TaskConversationMember } from "@getpaseo/protocol/messages";
import type {
  PluginTaskConversationHooks,
  PluginTaskConversationPrepareRequest,
} from "@getpaseo/plugin/server";
import {
  MODEL_ROLES,
  findTaskActualPreset,
  type ModelRole,
  type Task,
  type TaskPresetSnapshot,
} from "../vibe/contract";
import { createTaskRuntimeCommands, type VibeDb, type VibeStore } from "../vibe/db";
import { modeIdFor } from "./permission";
import { TASK_HOST_PROMPTS } from "./prompts";
import { createTaskResources } from "./resources";
import { snapshotPreset, nativeModelSnapshot, bootstrapPlannerSnapshot } from "./presets";
import { assertTaskWorkspace } from "./workspace";

type Recipient = PluginTaskConversationPrepareRequest["recipient"];
type AdmissionRequest = Parameters<PluginTaskConversationHooks["admit"]>[0]["request"];
type MemberChoiceRequest = Pick<
  PluginTaskConversationPrepareRequest,
  "recipient" | "backendAgentId" | "memberId" | "workspaceId" | "conversationId" | "clientMessageId"
>;
type ControlRequest = Parameters<
  NonNullable<PluginTaskConversationHooks["beforeControl"]>
>[0]["request"];
const COMPACT_UNKNOWN_REASON = "压缩结果不明；保留该成员资源，请核对原生成员";
export interface RecipientOptions {
  presetId?: string;
  candidateIndex?: number;
  memberId?: string;
  parentMemberId?: string;
  subtaskId?: string;
  fromSessionId?: string;
}
const READ_ONLY = new Set<ModelRole>(["planner", "scout", "plan_reviewer", "reviewer"]);
function acceptedPlannerSource(row: TaskConversationRow | null, member: TaskConversationMember) {
  return (
    !!row &&
    row.kind === "assistant" &&
    row.completed &&
    row.speaker?.role === "planner" &&
    row.source?.backendAgentId === member.backendAgentId &&
    row.source.memberId === member.memberId
  );
}
function roleOf(role: string): ModelRole {
  if (!MODEL_ROLES.includes(role as ModelRole)) throw new Error("未知任务角色：" + role);
  return role as ModelRole;
}
function readOnlyConfig(config: Recipient["config"]): Recipient["config"] {
  if (config.provider === "codex")
    return {
      ...config,
      modeId: "auto",
      providerOptions: {
        ...config.providerOptions,
        sandbox_mode: "read-only",
        approval_policy: "never",
      },
    };
  if (config.provider === "claude") return { ...config, modeId: "plan" };
  throw new Error("该 provider 尚无受支持的强制只读策略，不能接手规划或复核：" + config.provider);
}
function preserveReadOnly(config: Recipient["config"], requested: Recipient["config"]) {
  if (
    requested.modeId === "read-only" ||
    requested.modeId === "plan" ||
    requested.providerOptions?.sandbox_mode === "read-only"
  )
    return readOnlyConfig(config);
  return config;
}
function assertRolePhase(task: Task, role: ModelRole, operation = "send") {
  if (task.control?.confirmingRequestId) throw new Error("正在核对执行方案，请稍后重试");
  if (operation === "compact") return;
  const phases: Record<ModelRole, string[]> = {
    planner: ["planning", "awaiting_confirmation"],
    scout: ["planning", "awaiting_confirmation"],
    plan_reviewer: ["planning", "awaiting_confirmation"],
    worker: ["executing"],
    subagent: ["executing"],
    reviewer: ["reviewing"],
    verifier: ["verifying"],
  };
  if (!phases[role].includes(task.phase))
    throw new Error("当前阶段不能运行该角色：" + role + " / " + task.phase);
  if (
    ["worker", "subagent", "reviewer", "verifier"].includes(role) &&
    (!task.confirmedAt || !task.planSource)
  )
    throw new Error("请先通过任务面板执行或 /执行 确认最新完整方案");
}
function actualOptions(task: Task, role: ModelRole, option: RecipientOptions): RecipientOptions {
  if (option.fromSessionId || (!task.confirmedAt && !option.memberId)) return option;
  const choices = (
    Array.isArray(task.control?.actualModels) ? task.control.actualModels : []
  ) as Array<Record<string, unknown>>;
  const actual = choices.findLast(
    (choice) =>
      choice.role === role &&
      choice.confirmedAt === task.confirmedAt &&
      (!option.memberId || choice.memberId === option.memberId) &&
      (option.memberId || choice.admitted !== false) &&
      (option.memberId || role !== "subagent" || choice.subtaskId === option.subtaskId),
  );
  const effective = { ...option };
  if (!effective.presetId && typeof actual?.presetId === "string")
    effective.presetId = actual.presetId;
  if (
    effective.candidateIndex === undefined &&
    effective.presetId === actual?.presetId &&
    typeof actual?.candidateIndex === "number"
  )
    effective.candidateIndex = actual.candidateIndex;
  return effective;
}

export function recipientFromPreset(
  role: ModelRole,
  preset: TaskPresetSnapshot,
  cwd: string,
  options: RecipientOptions = {},
): Recipient {
  const model = preset.models[options.candidateIndex ?? 0];
  if (!model) throw new Error("模型候选不存在或已耗尽");
  let config: Recipient["config"] = {
    provider: model.provider as Recipient["config"]["provider"],
    model: model.model,
    cwd,
    thinkingOptionId: model.thinking || undefined,
    modeId: modeIdFor(model.provider, model.permissionMode),
  };
  if (READ_ONLY.has(role)) config = readOnlyConfig(config);
  return {
    role,
    presetId: preset.presetId,
    config,
    memberId: options.memberId,
    parentMemberId: options.parentMemberId,
    env: {
      VIBE_ROLE: role,
      VIBE_PRESET_ID: preset.presetId,
      VIBE_CANDIDATE_INDEX: String(options.candidateIndex ?? 0),
      VIBE_ENVIRONMENT_KIND: preset.environmentKind,
      ...(preset.runtimeEnv ? { VIBE_RUNTIME_ENV: preset.runtimeEnv } : {}),
      ...(options.subtaskId ? { VIBE_SUBTASK_ID: options.subtaskId } : {}),
      ...(options.fromSessionId ? { VIBE_PREVIOUS_SESSION_ID: options.fromSessionId } : {}),
    },
  };
}

export function createTaskHost(options: {
  db: VibeDb;
  store: VibeStore;
  paseo?: () => PaseoApi | null;
  onPaseo?: (paseo: PaseoApi) => void;
  resourceTimeoutMs?: number;
}) {
  const { db, store } = options;
  const resources = createTaskResources(db, options.resourceTimeoutMs);
  const runtime = createTaskRuntimeCommands(db);
  const compacting = new Map<string, string>();
  let latest: PaseoApi | null = null;
  const api = () => {
    const result = options.paseo?.() ?? latest;
    if (!result) throw new Error("任务宿主尚未连接");
    return result;
  };
  async function workspace(id: string) {
    const ref = api().workspaces.ref(id);
    await ref.refresh();
    if (!ref.directory || !ref.projectId) throw new Error("任务 workspace 不可读取");
    return ref;
  }
  async function resolveRoles(task: Task, projectId?: string) {
    return task.confirmedAt && task.rolesSnapshot
      ? task.rolesSnapshot
      : store.modelDefaults.resolveTask(
          task.roleSelections ?? {},
          projectId ?? (await workspace(task.workspaceId)).projectId!,
        );
  }
  async function unconfiguredPlanner(task: Task, role: ModelRole, option: RecipientOptions) {
    const own = task.roleSelections?.[role];
    if (
      role !== "planner" ||
      task.confirmedAt ||
      option.presetId ||
      own?.mode === "disabled" ||
      own?.mode === "preset"
    )
      return undefined;
    const project = store.projectConfigs.get((await workspace(task.workspaceId)).projectId!);
    const configured =
      project?.defaultPresets?.planner !== undefined
        ? project.defaultPresets.planner
        : store.modelDefaults.global().planner;
    if (configured) return undefined;
    const actual = findTaskActualPreset(task, { role: "planner", admittedOnly: true });
    return actual?.presetId === "task-native-planner" ? actual : undefined;
  }
  function continuationPreset(task: Task, role: ModelRole, sessionId: string) {
    const previous = runtime.getSession(sessionId);
    if (
      !previous ||
      previous.workspaceId !== task.workspaceId ||
      previous.role !== role ||
      previous.confirmedAt !== task.confirmedAt
    )
      throw new Error("接续来源不属于本任务当前轮次和角色");
    return findTaskActualPreset(task, { agentId: previous.agentId, role });
  }
  async function presetFor(task: Task, role: ModelRole, option: RecipientOptions) {
    if (option.fromSessionId) {
      const continuation = continuationPreset(task, role, option.fromSessionId);
      if (continuation) return continuation;
    }
    let actual: TaskPresetSnapshot | undefined;
    if (option.memberId) actual = findTaskActualPreset(task, { memberId: option.memberId, role });
    else if (task.confirmedAt)
      actual = findTaskActualPreset(task, {
        role,
        subtaskId: option.subtaskId,
        admittedOnly: true,
      });
    if (actual && (!option.presetId || option.presetId === actual.presetId)) return actual;
    let roles;
    try {
      roles = await resolveRoles(task);
    } catch (error) {
      const bootstrap = await unconfiguredPlanner(task, role, option);
      if (bootstrap) return bootstrap;
      throw error;
    }
    const selected = option.subtaskId
      ? (roles.subtaskPresets?.[option.subtaskId] ?? roles[role])
      : roles[role];
    if (option.presetId && option.presetId !== selected?.presetId) {
      const preset = store.presets.get(option.presetId);
      if (!preset) throw new Error("接手预设不存在或不可用");
      return snapshotPreset(preset);
    }
    return selected;
  }
  async function resolveRecipient(
    task: Task,
    role: ModelRole,
    option: RecipientOptions = {},
  ): Promise<Recipient> {
    const effective = actualOptions(task, role, option);
    const admission = role === "worker" ? resources.admissionFor(task.workspaceId) : undefined;
    if (admission?.confirmedAt === task.confirmedAt && !option.presetId)
      effective.presetId = admission.presetId;
    const preset = await presetFor(task, role, effective);
    if (!preset) throw new Error("此角色未启用：" + role);
    if (admission?.confirmedAt === task.confirmedAt && option.candidateIndex === undefined) {
      const index = preset.models.findIndex(
        (model) => model.provider === admission.provider && model.model === admission.model,
      );
      if (index < 0) throw new Error("首个执行者准入模型与冻结候选不一致");
      effective.candidateIndex = index;
    }
    const recipient = recipientFromPreset(
      role,
      preset,
      (await workspace(task.workspaceId)).directory!,
      effective,
    );
    if (!recipient.parentMemberId && task.conversationId) {
      const snapshot = await api().taskConversations.ref(task.conversationId).refresh();
      const anchor = snapshot?.members.find(
        (member) => member.backendAgentId === task.anchorAgentId,
      );
      if (anchor && role !== "planner") recipient.parentMemberId = anchor.memberId;
    }
    return recipient;
  }
  function registerPrompts() {
    store.prompts.register(TASK_HOST_PROMPTS);
  }
  function taskFor(workspaceId: string, conversationId: string) {
    const task = store.tasks.get(workspaceId);
    if (!task || task.conversationId !== conversationId)
      throw new Error("任务会话未绑定或归属不匹配");
    return task;
  }
  async function reconcileAnchor(workspaceId: string, conversationId: string) {
    const task = taskFor(workspaceId, conversationId);
    if (task.confirmedAt || !["planning", "awaiting_confirmation"].includes(task.phase))
      return task;
    const handle = api().taskConversations.ref(conversationId);
    const snapshot = await handle.refresh();
    if (
      !snapshot ||
      snapshot.workspaceId !== workspaceId ||
      snapshot.ownerPluginId !== "vibe-board"
    )
      throw new Error("任务宿主会话归属不一致，不能修正初始规划者");
    const anchorAgentId = snapshot.anchorAgentId;
    if (!anchorAgentId || anchorAgentId === task.anchorAgentId) return task;
    const member = snapshot.members.find((item) => item.backendAgentId === anchorAgentId);
    if (member?.role !== "planner") throw new Error("宿主初始成员不是规划者，不能修正任务绑定");
    const source = await handle.querySource({
      memberId: member.memberId,
      role: "planner",
      completed: true,
    });
    if (source.error) throw new Error("无法核对初始规划者原生发言：" + source.error);
    const row = source.row;
    if (!acceptedPlannerSource(row, member)) return task;
    const latestTask = taskFor(workspaceId, conversationId);
    if (
      latestTask.anchorAgentId === anchorAgentId ||
      latestTask.confirmedAt ||
      !["planning", "awaiting_confirmation"].includes(latestTask.phase)
    )
      return latestTask;
    return store.tasks.reconcileInitialAnchor(workspaceId, {
      conversationId,
      expectedAnchorAgentId: latestTask.anchorAgentId,
      anchorAgentId,
    });
  }
  function bindTask(request: PluginTaskConversationPrepareRequest, role: ModelRole) {
    let task = store.tasks.get(request.workspaceId);
    if (!task) {
      if (role !== "planner") throw new Error("新任务必须由规划者首发");
      task = store.tasks.create({
        workspaceId: request.workspaceId,
        anchorAgentId: request.anchorAgentId ?? request.backendAgentId,
        conversationId: request.conversationId,
      });
    } else if (!task.conversationId)
      task = store.tasks.bindConversation(task.workspaceId, request.conversationId);
    return taskFor(request.workspaceId, request.conversationId);
  }
  async function validateSubagent(
    request: Pick<
      PluginTaskConversationPrepareRequest,
      "recipient" | "conversationId" | "memberId" | "backendAgentId"
    >,
    task: Task,
    selection: RecipientOptions,
  ) {
    const snapshot = await api().taskConversations.ref(request.conversationId).refresh();
    const parent = snapshot?.members.find(
      (member) => member.memberId === request.recipient.parentMemberId,
    );
    if (
      parent?.role !== "worker" ||
      !selection.subtaskId ||
      !task.plan?.subtasks.some((item) => item.id === selection.subtaskId)
    )
      throw new Error("子代理必须关联执行主代理和已确认子任务");
    const declarations = task.control?.delegations as
      | Record<string, { memberId?: string; parentMemberId?: string; confirmedAt?: string }>
      | undefined;
    const declaration = declarations?.[selection.subtaskId!];
    if (
      declaration?.memberId !== request.memberId ||
      declaration.parentMemberId !== parent.memberId ||
      declaration.confirmedAt !== task.confirmedAt
    )
      throw new Error("子代理必须先经主代理正式委派，不能直接绕过任务流程运行");
    const subtask = task.plan!.subtasks.find((item) => item.id === selection.subtaskId)!;
    const run = task.subtaskRuns.find((item) => item.subtaskId === selection.subtaskId);
    if (!run || run.state === "completed") throw new Error("子任务未登记或已经完成");
    if (
      run.agentId &&
      run.agentId !== request.backendAgentId &&
      ["running", "waiting"].includes(run.state)
    )
      throw new Error("子任务已有其它执行者，先停止并核对");
    if (
      subtask.dependsOn.some(
        (id) =>
          !task.subtaskRuns.some((item) => item.subtaskId === id && item.state === "completed"),
      )
    )
      throw new Error("子任务前置依赖尚未完成");
  }
  async function rememberTemporarySelection(task: Task, role: ModelRole, presetId?: string) {
    if (task.confirmedAt || !presetId) return task;
    if (!store.presets.get(presetId)) throw new Error("接手预设不存在或不可用");
    const own = task.roleSelections?.[role];
    const project = store.projectConfigs.get((await workspace(task.workspaceId)).projectId!);
    let inherited = project?.defaultPresets?.[role];
    if (inherited === undefined) inherited = store.modelDefaults.global()[role];
    let selected = inherited;
    if (own?.mode === "preset") selected = own.presetId;
    if (own?.mode === "disabled") selected = null;
    if (selected === presetId) return task;
    return store.tasks.setRoleSelections(task.workspaceId, {
      ...task.roleSelections,
      [role]: { mode: "preset", presetId },
    });
  }
  function choiceForAgent(task: Task, agentId: string) {
    const choices = (
      Array.isArray(task.control?.actualModels) ? task.control.actualModels : []
    ) as Array<Record<string, unknown>>;
    return choices.findLast(
      (choice) => choice.agentId === agentId && choice.confirmedAt === task.confirmedAt,
    );
  }
  function choiceOptions(request: MemberChoiceRequest, task?: Task): RecipientOptions {
    const env = request.recipient.env ?? {};
    return {
      presetId: request.recipient.presetId,
      candidateIndex: Number(
        env.VIBE_CANDIDATE_INDEX ??
          runtime.findSessionByAgent(request.backendAgentId)?.candidateIndex ??
          0,
      ),
      subtaskId:
        env.VIBE_SUBTASK_ID ??
        task?.subtaskRuns.find((run) => run.agentId === request.backendAgentId)?.subtaskId,
      fromSessionId: env.VIBE_PREVIOUS_SESSION_ID,
    };
  }
  function matchesModel(preset: TaskPresetSnapshot, index: number, config: Recipient["config"]) {
    const model = preset.models[index];
    return (
      !!model &&
      model.provider === config.provider &&
      model.model === config.model &&
      (!config.thinkingOptionId || model.thinking === config.thinkingOptionId)
    );
  }
  async function preparedPreset(
    task: Task,
    role: ModelRole,
    request: MemberChoiceRequest,
    selection: RecipientOptions,
  ) {
    const existing = findTaskActualPreset(task, { agentId: request.backendAgentId, role });
    let preset = existing;
    if (!preset) {
      try {
        preset = (await presetFor(task, role, selection)) ?? undefined;
      } catch (error) {
        if (role !== "planner" || task.confirmedAt) throw error;
        const selected = selection.presetId ? store.presets.get(selection.presetId) : undefined;
        preset = selected
          ? snapshotPreset(selected)
          : bootstrapPlannerSnapshot(request.recipient.config);
      }
    }
    if (!preset) throw new Error("此角色未启用：" + role);
    let index = selection.candidateIndex ?? 0;
    if (
      !existing &&
      !selection.fromSessionId &&
      selection.presetId &&
      !matchesModel(preset, index, request.recipient.config)
    ) {
      const selected = store.presets.get(selection.presetId);
      if (!selected) throw new Error("新选择的接手预设不存在或不可用");
      preset = snapshotPreset(selected);
    }
    if (!request.recipient.presetId && !matchesModel(preset, index, request.recipient.config)) {
      preset = nativeModelSnapshot(preset, request.recipient.config, index);
      index = 0;
    }
    if (!matchesModel(preset, index, request.recipient.config))
      throw new Error("接手模型与冻结预设不一致，请刷新选择");
    return { preset, selection: { ...selection, candidateIndex: index } };
  }
  function freezePreparedChoice(
    task: Task,
    role: ModelRole,
    request: MemberChoiceRequest,
    preset: TaskPresetSnapshot,
    selection: RecipientOptions,
  ) {
    db.immediate(() => {
      const current = taskFor(task.workspaceId, request.conversationId);
      assertRolePhase(current, role);
      if (current.confirmedAt !== task.confirmedAt)
        throw new Error("准备接手时任务确认已变化，请重试");
      const choices = (
        Array.isArray(current.control?.actualModels) ? current.control.actualModels : []
      ) as Array<Record<string, unknown>>;
      const existing = choiceForAgent(current, request.backendAgentId);
      const model = preset.models[selection.candidateIndex ?? 0]!;
      const entry = {
        ...existing,
        memberId: request.memberId,
        agentId: request.backendAgentId,
        role,
        presetId: preset.presetId,
        presetSnapshot: preset,
        provider: model.provider,
        model: model.model,
        candidateIndex: selection.candidateIndex ?? 0,
        confirmedAt: task.confirmedAt,
        subtaskId: selection.subtaskId,
        admitted: existing ? existing.admitted !== false : false,
      };
      if (JSON.stringify(existing) === JSON.stringify(entry)) return;
      store.tasks.updateControl(task.workspaceId, {
        actualModels: existing
          ? choices.map((choice) => (choice === existing ? entry : choice))
          : [...choices, entry],
      });
    });
  }
  async function prepare(request: PluginTaskConversationPrepareRequest) {
    const placement = api().workspaces.ref(request.workspaceId);
    assertTaskWorkspace(await placement.refresh());
    const role = roleOf(request.recipient.role);
    const evidenceRole = ["reviewer", "verifier"].includes(role);
    let task = bindTask(request, role);
    if (request.anchorAgentId)
      task = await reconcileAnchor(request.workspaceId, request.conversationId);
    assertRolePhase(task, role);
    task = await rememberTemporarySelection(task, role, request.recipient.presetId);
    let selection = choiceOptions(request, task);
    if (role === "subagent") await validateSubagent(request, task, selection);
    const prepared = await preparedPreset(task, role, request, selection);
    selection = prepared.selection;
    const preset = prepared.preset;
    const recipient = recipientFromPreset(
      role,
      preset,
      (await workspace(task.workspaceId)).directory!,
      selection,
    );
    freezePreparedChoice(task, role, request, preset, selection);
    const projectId = (await workspace(task.workspaceId)).projectId!;
    const rolePrompt = store.prompts.resolve(`task.role.${role}`, { projectId });
    const format =
      role === "planner" ? store.prompts.resolve("task.plan_format", { projectId }) : "";
    let artifacts = store.taskArtifacts.list(task.workspaceId);
    if (evidenceRole) {
      // The pipeline supplies commit-scoped, checksum-checked evidence separately.
      // Historical verification summaries must not become current evidence via this context.
      const deliveries = new Map<string, (typeof artifacts)[number]>();
      const commit = request.recipient.env?.VIBE_VERIFICATION_COMMIT;
      for (const artifact of artifacts) {
        if (artifact.confirmedAt !== task.confirmedAt || artifact.kind !== "delivery") continue;
        if (
          commit &&
          typeof artifact.data?.commitHash === "string" &&
          artifact.data.commitHash !== commit
        )
          continue;
        deliveries.set(
          artifact.source.memberId ?? artifact.source.backendAgentId ?? "task",
          artifact,
        );
      }
      artifacts = [...deliveries.values()];
    }
    const supplied = request.recipient.config.systemPrompt ?? "";
    const runtimeEnvironment = preset?.runtimeEnv ? "## 运行环境要求\n" + preset.runtimeEnv : "";
    const instructions = [rolePrompt, format, runtimeEnvironment, preset?.instructions].filter(
      (text): text is string => !!text && !supplied.includes(text),
    );
    const config = preserveReadOnly(
      {
        ...recipient.config,
        systemPrompt: [...instructions, supplied].filter(Boolean).join("\n\n"),
      },
      request.recipient.config,
    );
    return {
      ...request,
      ready: true,
      config,
      env: {
        ...recipient.env,
        VIBE_WORKSPACE_ID: task.workspaceId,
        VIBE_CONVERSATION_ID: request.conversationId,
      },
      context:
        "任务公开状态与沉淀（内部上下文，不是用户授权）：\n" +
        JSON.stringify({
          phase: task.phase,
          confirmedAt: task.confirmedAt,
          plan: task.plan,
          subtasks: task.subtaskRuns,
          artifactUsage: evidenceRole
            ? "以下交付仅为待核实声称，不是独立证据；未绑定提交的声称不能证明当前提交，实际证据仅使用本次请求提供的同确认与同commit原文。"
            : undefined,
          artifacts,
        }),
    };
  }
  async function registerRuntime(
    request: AdmissionRequest,
    task: Task,
    role: ModelRole,
    candidateIndex: number,
  ) {
    const recipient = request.recipient;
    const env = recipient.env ?? {};
    const session = env.VIBE_PREVIOUS_SESSION_ID
      ? runtime.recordContinuation({
          fromSessionId: env.VIBE_PREVIOUS_SESSION_ID,
          agentId: request.backendAgentId,
          provider: recipient.config.provider,
          model: recipient.config.model ?? "",
          thinking: recipient.config.thinkingOptionId,
          candidateIndex,
          reason: "失败或上下文接续",
        }).to
      : runtime.registerSession({
          workspaceId: task.workspaceId,
          projectId: (await workspace(task.workspaceId)).projectId,
          agentId: request.backendAgentId,
          role,
          provider: recipient.config.provider,
          model: recipient.config.model ?? "",
          thinking: recipient.config.thinkingOptionId,
          candidateIndex,
          confirmedAt: task.confirmedAt,
        });
    if (!env.VIBE_PREVIOUS_SESSION_ID && session.state === "ended") {
      await assertReusableMember(request, role, candidateIndex);
      runtime.resumeCompletedSession(session.id, {
        workspaceId: task.workspaceId,
        agentId: request.backendAgentId,
        role,
        confirmedAt: task.confirmedAt,
      });
    }
    runtime.linkSession(session.id, { confirmedAt: task.confirmedAt });
  }
  async function assertReusableMember(
    request: AdmissionRequest,
    role: ModelRole,
    candidateIndex: number,
  ) {
    const snapshot = await api().taskConversations.ref(request.conversationId).refresh();
    const member = snapshot?.members.find(
      (item) =>
        item.memberId === request.memberId && item.backendAgentId === request.backendAgentId,
    );
    const preset = findTaskActualPreset(taskFor(request.workspaceId, request.conversationId), {
      agentId: request.backendAgentId,
      role,
    });
    if (!preset) throw new Error("旧完成会话缺少本次冻结的实际预设，不能恢复");
    const config = preserveReadOnly(
      recipientFromPreset(role, preset, (await workspace(request.workspaceId)).directory!, {
        candidateIndex,
      }).config,
      request.recipient.config,
    );
    if (
      snapshot?.workspaceId !== request.workspaceId ||
      snapshot.ownerPluginId !== "vibe-board" ||
      !member ||
      member.role !== role ||
      member.config.provider !== config.provider ||
      member.config.model !== config.model ||
      member.config.thinkingOptionId !== config.thinkingOptionId ||
      member.config.cwd !== config.cwd ||
      member.config.modeId !== config.modeId ||
      member.config.providerOptions?.sandbox_mode !== config.providerOptions?.sandbox_mode ||
      member.config.providerOptions?.approval_policy !== config.providerOptions?.approval_policy
    )
      throw new Error("旧完成会话不匹配当前原生成员与配置，不能恢复");
  }
  function updateCompactStatus(request: ControlRequest) {
    db.immediate(() => {
      const task = taskFor(request.workspaceId, request.conversationId);
      const previous = task.control?.compactUnknownMembers;
      const pending = (Array.isArray(previous) ? previous : []).filter(
        (id): id is string => typeof id === "string",
      );
      const member = request.backendAgentId ?? "unknown";
      const members =
        request.phase === "unknown"
          ? [...new Set([...pending, member])]
          : pending.filter((id) => id !== member);
      const patch = {
        compactUnknown: members.length > 0,
        compactUnknownMembers: members,
        ...(members.length ? { blockingReason: COMPACT_UNKNOWN_REASON } : {}),
        ...(!members.length && task.control?.blockingReason === COMPACT_UNKNOWN_REASON
          ? { blockingReason: "" }
          : {}),
      };
      store.tasks.updateControl(task.workspaceId, patch);
    });
  }
  async function compactControl(request: ControlRequest) {
    if (!request.backendAgentId) throw new Error("压缩收尾缺少原生成员身份，资源继续保留");
    if (request.phase === "before") {
      compacting.set(request.backendAgentId, request.workspaceId);
      return;
    }
    if (request.phase === "unknown") {
      compacting.set(request.backendAgentId, request.workspaceId);
      updateCompactStatus(request);
      return;
    }
    await resources.releaseAgent(request.workspaceId, request.backendAgentId);
    compacting.delete(request.backendAgentId);
    updateCompactStatus(request);
  }
  const hooks: PluginTaskConversationHooks = {
    async prepare({ request }, context) {
      latest = context.paseo;
      options.onPaseo?.(context.paseo);
      try {
        return await prepare(request);
      } catch (error) {
        return {
          ...request,
          ready: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
    async admit({ request }, context) {
      latest = context.paseo;
      options.onPaseo?.(context.paseo);
      try {
        const task = taskFor(request.workspaceId, request.conversationId);
        const role = roleOf(request.recipient.role);
        assertRolePhase(task, role, request.operation);
        const recipient = request.recipient;
        const env = recipient.env ?? {};
        const subtaskId =
          env.VIBE_SUBTASK_ID ??
          task.subtaskRuns.find((run) => run.agentId === request.backendAgentId)?.subtaskId;
        if (role === "subagent" && request.operation !== "compact")
          await validateSubagent(request, task, { subtaskId });
        if (request.operation !== "compact") {
          const prepared = await preparedPreset(task, role, request, {
            ...choiceOptions(request, task),
            subtaskId,
          });
          freezePreparedChoice(task, role, request, prepared.preset, prepared.selection);
        }
        const selected = choiceForAgent(
          taskFor(task.workspaceId, request.conversationId),
          request.backendAgentId,
        );
        const candidateIndex =
          typeof selected?.candidateIndex === "number"
            ? selected.candidateIndex
            : Number(env.VIBE_CANDIDATE_INDEX ?? 0);
        const bound = await resources.admit(
          {
            workspaceId: task.workspaceId,
            role,
            agentId: request.backendAgentId,
            presetId: recipient.presetId,
            provider: recipient.config.provider,
            model: recipient.config.model,
            candidateIndex,
            subtaskId,
            operation: request.operation,
          },
          task.confirmedAt,
          request.operation === "compact"
            ? undefined
            : () => registerRuntime(request, task, role, candidateIndex),
          request.clientMessageId,
        );
        if (bound.provider !== recipient.config.provider || bound.model !== recipient.config.model)
          throw new Error("资源实际模型与接手者不一致，请刷新后重试");
        const fresh = taskFor(request.workspaceId, request.conversationId);
        if (fresh.confirmedAt !== task.confirmedAt)
          throw new Error("资源准入期间方案确认已变化，请重新确认");
        assertRolePhase(fresh, role, request.operation);
        if (request.operation === "compact") return { ...request, admitted: true };
        if (role === "subagent" && subtaskId)
          store.tasks.setSubtaskRun(task.workspaceId, {
            subtaskId,
            state: "running",
            agentId: request.backendAgentId,
            actualModel: { provider: bound.provider!, model: bound.model! },
          });
        db.immediate(() => {
          const previous = taskFor(request.workspaceId, request.conversationId).control
            ?.actualModels;
          const actualModels = Array.isArray(previous) ? previous : [];
          const previousChoice = choiceForAgent(
            taskFor(task.workspaceId, request.conversationId),
            request.backendAgentId,
          );
          if (previousChoice?.admitted !== true) {
            const choices = [...actualModels];
            const index = choices.findLastIndex(
              (entry) =>
                entry.agentId === request.backendAgentId && entry.confirmedAt === task.confirmedAt,
            );
            if (index < 0) throw new Error("准入成员缺少冻结的实际模型快照");
            choices[index] = { ...choices[index], admitted: true };
            store.tasks.updateControl(task.workspaceId, {
              actualModels: choices,
            });
          }
        });
        return { ...request, admitted: true };
      } catch (error) {
        return {
          ...request,
          admitted: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
    async beforeControl({ request }) {
      if (request.action === "compact") {
        await compactControl(request);
        return request;
      }
      if (request.phase === "before")
        await resources.request({ workspaceId: request.workspaceId, action: "freeze" });
      if (request.phase === "settled") {
        await resources.settled(
          request.workspaceId,
          request.action === "stop_member" ? request.backendAgentId : undefined,
        );
        for (const [agentId, workspaceId] of compacting)
          if (
            workspaceId === request.workspaceId &&
            (request.action !== "stop_member" || agentId === request.backendAgentId)
          )
            compacting.delete(agentId);
      }
      if (request.phase === "settled" || request.phase === "unknown") {
        const task = store.tasks.get(request.workspaceId);
        if (task && task.conversationId === request.conversationId) {
          const reason =
            request.phase === "unknown"
              ? "停止结果不明；保留资源并暂停，请核对原成员"
              : "任务成员已停止；等待显式接续或重新制定方案";
          if (!["paused", "completed", "failed"].includes(task.phase))
            store.tasks.setPhase(task.workspaceId, "paused");
          for (const run of task.subtaskRuns.filter(
            (item) =>
              request.phase === "settled" &&
              ["running", "waiting"].includes(item.state) &&
              (request.action !== "stop_member" || item.agentId === request.backendAgentId),
          ))
            store.tasks.setSubtaskRun(task.workspaceId, {
              subtaskId: run.subtaskId,
              state: "paused",
              summary: reason,
            });
          store.tasks.updateControl(task.workspaceId, {
            currentStep: "paused",
            blockingReason: reason,
            ...(request.phase === "settled" && ["stop", "stop_member"].includes(request.action)
              ? { autoContinuationBlocked: true }
              : {}),
          });
          store.tasks.setSummary(task.workspaceId, reason);
        }
      }
      return request;
    },
  };
  return {
    hooks,
    resolveRoles,
    resolveRecipient,
    registerPrompts,
    reconcileAnchor,
    handleAdmission: resources.handleAdmission,
    releaseAgent: resources.releaseAgent,
    noteTurnStarted: resources.noteTurnStarted,
    takeTurn: resources.takeTurn,
    isCompacting: (agentId: string) => compacting.has(agentId),
    close() {},
  };
}
