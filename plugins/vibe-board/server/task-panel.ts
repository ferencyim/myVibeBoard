import type { PaseoApi } from "@getpaseo/client";
import type { TaskConversationSnapshot } from "@getpaseo/protocol/messages";
import type { TaskConversationPanelSnapshot } from "../shared/task-conversation";
import {
  MODEL_ROLES,
  presetModels,
  type ModelRole,
  type Task,
  type TaskPresetSnapshot,
} from "./vibe/contract";
import type { VibeDb, VibeStore } from "./vibe/db";
import { recipientFromPreset, type RecipientOptions } from "./task-host";
import { latestTaskPlan } from "./task-conversation/source";
import { assertTaskWorkspace } from "./task-host/workspace";

const ROLE_LABELS: Record<ModelRole, string> = {
  scout: "探路",
  planner: "规划",
  plan_reviewer: "方案复核",
  worker: "主代理",
  subagent: "子代理",
  reviewer: "代码复核",
  verifier: "验证",
};

/** Read the context plugin's persisted policy; context remains its only writer. */
export function readTaskCachePolicy(db: VibeDb): TaskConversationPanelSnapshot["cache"] {
  const raw = db
    .prepare<{ value: string }>("SELECT value FROM vibe_meta WHERE key = ?")
    .get("context:compaction_policy")?.value;
  let policy: {
    ttlSeconds?: Record<string, number>;
    fallbackTtlSeconds?: number;
    enabled?: boolean;
  } = {};
  if (raw) {
    try {
      policy = JSON.parse(raw);
    } catch {
      /* The context plugin will replace an invalid policy. */
    }
  }
  return {
    ttlSecondsByProvider: { claude: 3600, codex: 300, ...policy.ttlSeconds },
    fallbackTtlSeconds: policy.fallbackTtlSeconds ?? 300,
    autoCompact: policy.enabled ?? true,
  };
}

function suggestedRole(task: Task | undefined): ModelRole {
  if (!task?.confirmedAt || ["planning", "awaiting_confirmation", "failed"].includes(task.phase))
    return "planner";
  if (task.phase === "reviewing") return "reviewer";
  if (["verifying", "awaiting_acceptance"].includes(task.phase)) return "verifier";
  return "worker";
}

export function createTaskPanelReader(options: {
  db: VibeDb;
  store: VibeStore;
  resolveRecipient(
    task: Task,
    role: ModelRole,
    options?: RecipientOptions,
  ): Promise<ReturnType<typeof recipientFromPreset>>;
}) {
  async function recipientChoices(
    task: Task | undefined,
    directory: string,
    conversation: TaskConversationSnapshot,
    blockers: string[],
  ) {
    const recipients: TaskConversationPanelSnapshot["recipients"] = [];
    const presets = options.store.presets.list();
    for (const role of MODEL_ROLES) {
      if (task) {
        try {
          const recipient = await options.resolveRecipient(task, role);
          recipients.push({
            id: role + ":default",
            label: ROLE_LABELS[role] + " · 当前预设",
            role,
            presetId: recipient.presetId,
            recipient,
          });
        } catch (error) {
          if (["planner", "worker", "verifier"].includes(role))
            blockers.push(error instanceof Error ? error.message : String(error));
        }
      }
      // Role hints never filter the full presets available to a task role.
      for (const preset of presets) {
        const snapshot: TaskPresetSnapshot = {
          presetId: preset.id,
          source: "task",
          models: presetModels(preset),
          environmentKind: preset.environmentKind,
          runtimeEnv: preset.runtimeEnv,
          instructions: preset.instructions,
        };
        try {
          const recipient = recipientFromPreset(role, snapshot, directory);
          recipients.push({
            id: role + ":" + preset.id,
            label: ROLE_LABELS[role] + " · " + preset.name,
            role,
            presetId: preset.id,
            recipient,
          });
        } catch {
          /* Unsupported read-only providers cannot run a read-only role. */
        }
      }
    }
    return [...recipients, ...memberChoices(conversation)];
  }
  return async (
    input: { workspaceId: string; conversationId: string },
    paseo: PaseoApi,
  ): Promise<TaskConversationPanelSnapshot> => {
    const conversation = await paseo.taskConversations.ref(input.conversationId).refresh();
    if (
      !conversation ||
      conversation.workspaceId !== input.workspaceId ||
      conversation.ownerPluginId !== "vibe-board"
    )
      throw new Error("任务会话不存在或不属于当前工作区");
    const workspace = paseo.workspaces.ref(input.workspaceId);
    assertTaskWorkspace(await workspace.refresh());
    if (!workspace.directory) throw new Error("任务工作区目录不可用");
    let task = options.store.tasks.get(input.workspaceId);
    if (task && task.conversationId !== input.conversationId)
      throw new Error("任务与群聊绑定不一致");
    if (!task && conversation.anchorAgentId)
      task = options.store.tasks.create({
        workspaceId: input.workspaceId,
        anchorAgentId: conversation.anchorAgentId,
        conversationId: input.conversationId,
      });
    const blockers = taskBlockers(task, conversation);
    const latestPlanSource = await latestSource(task, paseo, conversation, blockers);
    const recipients = await recipientChoices(task, workspace.directory, conversation, blockers);
    const role = suggestedRole(task);
    const suggested =
      recipients.find((entry) => entry.id === role + ":default") ??
      recipients.find((entry) => entry.role === role);
    return {
      task: task ?? null,
      conversationStatus: conversation.status,
      latestPlanSource,
      blockers: [...new Set(blockers)],
      subtasks: describeSubtasks(task, conversation),
      artifacts: task ? options.store.taskArtifacts.list(input.workspaceId) : [],
      recipients,
      suggestedRecipientId: suggested?.id,
      members: describeMembers(conversation),
      cache: readTaskCachePolicy(options.db),
    };
  };
}

function memberChoices(
  conversation: TaskConversationSnapshot,
): TaskConversationPanelSnapshot["recipients"] {
  return conversation.members
    .filter((member) => MODEL_ROLES.includes(member.role as ModelRole))
    .map((member) => ({
      id: "member:" + member.memberId,
      role: member.role as ModelRole,
      presetId: member.presetId,
      label:
        ROLE_LABELS[member.role as ModelRole] +
        " · " +
        (member.config.model ?? member.config.provider),
      recipient: {
        memberId: member.memberId,
        role: member.role,
        presetId: member.presetId,
        parentMemberId: member.parentMemberId,
        config: member.config,
      },
    }));
}

function taskBlockers(task: Task | undefined, conversation: TaskConversationSnapshot) {
  const blockers: string[] = [];
  if (conversation.status === "paused") blockers.push("群聊已暂停；请核对停止或未知投递后显式接续");
  if (conversation.status === "stopping") blockers.push("正在核对所有成员停止，资源仍保留");
  if (conversation.status === "archived") blockers.push("群聊已归档");
  if (task?.summary && ["paused", "failed"].includes(task.phase)) blockers.push(task.summary);
  if (typeof task?.control?.blockingReason === "string") blockers.push(task.control.blockingReason);
  return blockers;
}

async function latestSource(
  task: Task | undefined,
  paseo: PaseoApi,
  conversation: TaskConversationSnapshot,
  blockers: string[],
): Promise<TaskConversationPanelSnapshot["latestPlanSource"]> {
  if (!task || !["planning", "awaiting_confirmation"].includes(task.phase)) return null;
  try {
    return (
      await latestTaskPlan(paseo.taskConversations.ref(conversation.conversationId), conversation)
    ).source;
  } catch (error) {
    if (task.plan) blockers.push(error instanceof Error ? error.message : String(error));
    return null;
  }
}

function describeSubtasks(
  task: Task | undefined,
  conversation: TaskConversationSnapshot,
): TaskConversationPanelSnapshot["subtasks"] {
  return (task?.plan?.subtasks ?? []).map((subtask) => {
    const run = task?.subtaskRuns.find((candidate) => candidate.subtaskId === subtask.id);
    const member = conversation.members.find(
      (candidate) => candidate.backendAgentId === run?.agentId,
    );
    return {
      id: subtask.id,
      title: subtask.goal,
      dependsOn: subtask.dependsOn,
      status: run?.state ?? "pending",
      role: "subagent",
      model: run?.actualModel ? run.actualModel.provider + "/" + run.actualModel.model : null,
      memberId: member?.memberId,
      backendAgentId: run?.agentId ?? undefined,
      summary: run?.summary ?? "",
    };
  });
}

function describeMembers(
  conversation: TaskConversationSnapshot,
): TaskConversationPanelSnapshot["members"] {
  return conversation.members.map((member) => ({
    memberId: member.memberId,
    backendAgentId: member.backendAgentId,
    role: member.role,
    provider: member.config.provider,
    model: member.config.model ?? null,
    presetId: member.presetId,
    lastRequestAt: member.lastRequestAt,
    status: member.status,
  }));
}
