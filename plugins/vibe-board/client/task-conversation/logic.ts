import type { TaskConversationPanelSnapshot } from "../../shared/task-conversation";
import type { PaseoApi } from "@getpaseo/client";
import type {
  ModelRole,
  TaskAction,
  TaskArtifact,
  TaskPhase,
  TaskRoleSelection,
} from "../../shared/vibe/contract";

export const ROLE_LABELS: Record<ModelRole, string> = {
  scout: "探路",
  planner: "规划",
  plan_reviewer: "方案复核",
  worker: "执行主代理",
  subagent: "执行子代理",
  reviewer: "代码复核",
  verifier: "验证",
};
export const ARTIFACT_LABELS = {
  plan: "方案",
  scout: "探路结论",
  plan_review: "方案复核",
  delivery: "执行交付",
  review: "代码复核",
  verification: "验证清单与证据",
  git: "Git 结果",
} as const;
export const TASK_ACTIONS: readonly { action: TaskAction; command: string; label: string }[] = [
  { action: "plan", command: "制定方案", label: "制定 / 修改方案" },
  { action: "review_plan", command: "复核方案", label: "复核方案" },
  { action: "execute", command: "执行", label: "执行" },
  { action: "review", command: "复核", label: "复核" },
  { action: "verify", command: "验证", label: "验证" },
  { action: "accept", command: "通过", label: "通过" },
  { action: "stop", command: "停止任务", label: "停止任务" },
];

/** These hints never replace the command handler's authoritative stage checks. */
export function actionAvailable(action: TaskAction, phase: TaskPhase | undefined): boolean {
  if (!phase) return false;
  if (action === "plan") return true;
  if (action === "stop") return phase !== "completed";
  if (action === "execute" || action === "review_plan")
    return ["planning", "awaiting_confirmation"].includes(phase);
  if (action === "accept") return phase === "awaiting_acceptance";
  if (action === "reject")
    return ["reviewing", "verifying", "awaiting_acceptance", "paused"].includes(phase);
  if (action === "review") return ["executing", "reviewing", "paused"].includes(phase);
  return ["executing", "reviewing", "verifying", "paused"].includes(phase);
}

export function suggestedRole(phase: TaskPhase | undefined): ModelRole {
  if (phase === "reviewing") return "reviewer";
  if (phase === "verifying" || phase === "awaiting_acceptance") return "verifier";
  return ["queued", "executing"].includes(phase ?? "") ? "worker" : "planner";
}

export function cacheRemainingSeconds(
  lastRequestAt: string | null,
  ttlSeconds: number,
  now: number,
): number | null {
  if (!lastRequestAt) return null;
  const timestamp = Date.parse(lastRequestAt);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.ceil((timestamp + ttlSeconds * 1000 - now) / 1000));
}

export function formatCountdown(seconds: number | null): string {
  if (seconds === null) return "尚无请求记录";
  if (seconds === 0) return "缓存估计已到期";
  return `${Math.floor(seconds / 60)}分${String(seconds % 60).padStart(2, "0")}秒`;
}

export function recipientMember(
  snapshot: TaskConversationPanelSnapshot,
  recipientId: string | undefined,
) {
  const option = snapshot.recipients.find((item) => item.id === recipientId);
  if (!option) return undefined;
  if (option.recipient.memberId)
    return snapshot.members.find((member) => member.memberId === option.recipient.memberId);
  return snapshot.members
    .filter(
      (member) =>
        member.role === option.role &&
        member.provider === option.recipient.config.provider &&
        member.model === (option.recipient.config.model ?? null) &&
        member.presetId === option.recipient.presetId,
    )
    .sort((a, b) => (b.lastRequestAt ?? "").localeCompare(a.lastRequestAt ?? ""))[0];
}

export function recipientOptions(snapshot: TaskConversationPanelSnapshot) {
  return snapshot.recipients.map((option) => {
    const member = recipientMember(snapshot, option.id);
    const ttl = member
      ? (snapshot.cache.ttlSecondsByProvider[member.provider] ?? snapshot.cache.fallbackTtlSeconds)
      : 0;
    const timestamp = member?.lastRequestAt ? Date.parse(member.lastRequestAt) : Number.NaN;
    return {
      id: option.id,
      label: option.label,
      recipient: option.recipient,
      cacheExpiresAt: Number.isFinite(timestamp) ? timestamp + ttl * 1000 : null,
    };
  });
}

export async function resolveArtifactChatSourceKey(
  paseo: Pick<PaseoApi, "taskConversations">,
  artifact: TaskArtifact,
): Promise<string> {
  const conversation = paseo.taskConversations.ref(artifact.source.conversationId);
  const original = await conversation.querySource({ sourceKey: artifact.source.sourceKey });
  if (original.error) throw new Error(original.error);
  if (original.row) return original.row.sourceKey;
  // Historical reports may carry only native member metadata and a synthetic source key.
  // The persisted publish cursor identifies their actual public row without guessing key formats.
  if (!artifact.published) throw new Error("群聊源不存在，沉淀尚未发布");
  const published = await conversation.querySource({ cursor: artifact.published });
  if (published.error || !published.row)
    throw new Error(published.error ?? "已发布沉淀的群聊源不存在");
  return published.row.sourceKey;
}

export async function loadArtifactContent(
  paseo: Pick<PaseoApi, "taskConversations">,
  artifact: TaskArtifact,
): Promise<string> {
  if (artifact.data && Object.keys(artifact.data).length)
    return JSON.stringify(artifact.data, null, 2);
  const result = await paseo.taskConversations
    .ref(artifact.source.conversationId)
    .querySource({ sourceKey: artifact.source.sourceKey });
  if (result.error || !result.row)
    throw new Error(result.error ?? "群聊完整源不存在，无法读取此步全文");
  return result.row.text;
}

export function roleConfigurationAllowed(phase: TaskPhase | undefined): boolean {
  return phase === "planning" || phase === "awaiting_confirmation";
}

/** Saving a role preference does not send a message or authorize execution. */
export async function selectTaskRecipient(input: {
  snapshot: TaskConversationPanelSnapshot;
  id: string;
  saveRole(role: ModelRole, selection: TaskRoleSelection): Promise<unknown>;
  select(id: string): void;
}) {
  const option = input.snapshot.recipients.find((item) => item.id === input.id);
  if (!option) throw new Error("所选接手者已变化，请刷新任务面板");
  if (roleConfigurationAllowed(input.snapshot.task?.phase) && !option.recipient.memberId) {
    const selection: TaskRoleSelection =
      option.id === option.role + ":default" || !option.presetId
        ? { mode: "inherit" }
        : { mode: "preset", presetId: option.presetId };
    await input.saveRole(option.role, selection);
  }
  input.select(input.id);
}

let requestCounter = 0;
export function newCommandRequestId(): string {
  return `task-ui-${Date.now()}-${++requestCounter}`;
}
