import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { Logger } from "pino";
import { TaskConversationDeliverySchema } from "@getpaseo/protocol/messages";
import {
  getParentAgentIdFromLabels,
  isOpenAgentTabLabel,
  PARENT_AGENT_ID_LABEL,
} from "@getpaseo/protocol/agent-labels";
import type {
  TaskConversationCreateRequest,
  TaskConversationResolveRequest,
  TaskConversationSendRequest,
  TaskConversationFetchRequest,
  TaskConversationPublishRequest,
  TaskConversationQuerySourceRequest,
  TaskConversationStopRequest,
  TaskConversationArchiveRequest,
  TaskConversationCompactRequest,
  TaskConversationRecipient,
  TaskConversationSnapshot,
  TaskConversationRow,
  TaskConversationDelivery,
  TaskConversationMember,
  TaskConversationPage,
} from "@getpaseo/protocol/messages";
import type {
  AgentManager,
  AgentManagerEvent,
  CreateAgentOptions,
} from "../agent/agent-manager.js";
import type {
  AgentSessionConfig,
  AgentPromptInput,
  AgentPermissionResponse,
} from "../agent/agent-sdk-types.js";
import type { AgentRunOptions } from "../agent/agent-sdk-types.js";
import type { PluginTaskConversationPrepareRequest } from "@getpaseo/plugin/server";
import type { AgentStorage } from "../agent/agent-storage.js";
import { ensureAgentLoaded } from "../agent/agent-loading.js";
import { buildAgentPrompt } from "../agent/prompt-attachments.js";
import { formatSystemNotificationPrompt } from "../agent/agent-messages/index.js";
import type { PluginService } from "../plugins/index.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";
import {
  TaskConversationStore,
  type StoredTaskConversation,
  type StoredTaskConversationDelivery,
} from "./store.js";
import {
  TASK_CONVERSATION_ID_LABEL as CONVERSATION_LABEL,
  TASK_CONVERSATION_MEMBER_ID_LABEL as MEMBER_LABEL,
} from "./identity.js";

type Input<T> = Omit<T, "type" | "requestId">;
type NativeTimelineRow = Awaited<ReturnType<AgentManager["getTimelineRows"]>>[number];
const READ_ONLY_TASK_ROLES = new Set(["planner", "scout", "plan_reviewer", "reviewer"]);
interface Update {
  conversation?: TaskConversationSnapshot;
  row?: TaskConversationRow;
  eventSeq?: number;
}
function fingerprint(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === "object")
      return Object.fromEntries(
        Object.entries(input)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, v]) => [key, canonical(v)]),
      );
    return input;
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function ownGet<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}
function ownSet<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}
function assistantSourceKey(
  memberId: string,
  turnId: string | undefined,
  deliveryId?: string,
): string {
  return deliveryId
    ? `assistant:${memberId}:delivery:${deliveryId}`
    : `assistant:${memberId}:${turnId}`;
}
function confirmDeliveryReceipt(
  record: StoredTaskConversation,
  delivery: StoredTaskConversationDelivery,
  receipt: NativeTimelineRow | undefined,
): void {
  if (delivery.status !== "unknown" || !receipt?.turnId) return;
  delivery.status = "accepted";
  delivery.sourceTurnId = receipt.turnId;
  const member = record.snapshot.members.find((entry) => entry.memberId === delivery.memberId)!;
  member.seenConversationSeq = Math.max(member.seenConversationSeq, delivery.throughSeq);
}
function legacyMatchesDelivery(
  legacy: TaskConversationRow | null,
  epoch: string,
  receipt: NativeTimelineRow | undefined,
  nextReceipt: NativeTimelineRow | undefined,
  ambiguousTurn: boolean,
): boolean {
  return (
    !ambiguousTurn ||
    (legacy?.source?.epoch === epoch &&
      (!receipt || (legacy.source.seq ?? -1) > receipt.seq) &&
      (!nextReceipt || (legacy.source.seq ?? -1) < nextReceipt.seq))
  );
}
function mergeAssistantFragments(
  previous: AgentManagerEvent | undefined,
  event: AgentManagerEvent,
): AgentManagerEvent | null {
  if (previous?.type !== "agent_stream" || event.type !== "agent_stream") return null;
  if (previous.event.type !== "timeline" || event.event.type !== "timeline") return null;
  if (
    previous.event.item.type !== "assistant_message" ||
    event.event.item.type !== "assistant_message"
  )
    return null;
  if (
    previous.agentId !== event.agentId ||
    previous.epoch !== event.epoch ||
    previous.event.item.messageId !== event.event.item.messageId
  )
    return null;
  return {
    ...event,
    event: {
      ...event.event,
      item: { ...event.event.item, text: previous.event.item.text + event.event.item.text },
    },
  };
}
function projectMemberState(
  member: TaskConversationMember,
  event: Extract<AgentManagerEvent, { type: "agent_state" }>,
): void {
  member.status = event.agent.lifecycle;
  const pending = Array.from(event.agent.pendingPermissions.values());
  // Closed native snapshots have no interactive permission map. Keep durable
  // Codex plans visible until their original provider member resumes.
  member.pendingPermissions =
    (event.agent.lifecycle === "closed" || event.agent.lifecycle === "initializing") &&
    !pending.length
      ? (member.pendingPermissions ?? []).filter(
          (request) => request.provider === "codex" && request.name === "CodexPlanApproval",
        )
      : pending;
}
function isTerminalEvent(event: AgentManagerEvent): boolean {
  return (
    event.type === "agent_stream" &&
    (event.event.type === "turn_completed" ||
      event.event.type === "turn_failed" ||
      event.event.type === "turn_canceled")
  );
}
function isProjectionEvent(event: AgentManagerEvent): boolean {
  return (
    event.type === "agent_state" ||
    (event.type === "agent_stream" &&
      (event.event.type === "turn_started" ||
        isTerminalEvent(event) ||
        (event.event.type === "timeline" && event.event.item.type === "assistant_message")))
  );
}
function unseenContext(
  store: TaskConversationStore,
  record: StoredTaskConversation,
  member: TaskConversationMember | undefined,
  backendAgentId: string,
  throughSeq: number,
): TaskConversationRow[] {
  return store
    .queryRows(record, {
      afterSeq: member?.seenConversationSeq ?? 0,
      throughSeq,
    })
    .filter((row) => {
      if (row.kind === "assistant" && row.source?.backendAgentId === backendAgentId) return false;
      const delivery = row.clientMessageId
        ? ownGet(record.deliveries, row.clientMessageId)
        : undefined;
      if (row.kind === "user" && delivery?.status === "rejected") return false;
      return !(
        row.kind === "user" &&
        delivery?.backendAgentId === backendAgentId &&
        delivery.status === "accepted"
      );
    });
}
function validateSummary(
  summary: TaskConversationMember["summary"],
  previous: TaskConversationMember["summary"],
  throughSeq: number,
): void {
  if (
    summary &&
    (!summary.text.trim() ||
      summary.throughSeq < (previous?.throughSeq ?? 0) ||
      summary.throughSeq > throughSeq)
  )
    throw new Error("Task context summary does not cover a valid sequence boundary");
}
function preparedConfig(
  prepare: PluginTaskConversationPrepareRequest,
  cwd: string,
): AgentSessionConfig {
  if (!prepare.ready || !prepare.config)
    throw new Error(prepare.reason ?? "Task context preparation is unavailable");
  const config: AgentSessionConfig = { ...prepare.config, cwd };
  delete config.internal;
  return config;
}
function memberIdentity(candidate: TaskConversationMember | undefined, requestedMemberId?: string) {
  if (candidate) return { memberId: candidate.memberId, backendAgentId: candidate.backendAgentId };
  return { memberId: requestedMemberId ?? randomUUID(), backendAgentId: randomUUID() };
}
function recipientConfigurationFingerprint(recipient: TaskConversationRecipient): string {
  return fingerprint({
    role: recipient.role,
    config: recipient.config,
    env: recipient.env,
    presetId: recipient.presetId,
    parentMemberId: recipient.parentMemberId,
  });
}
function memberConfigurationFingerprint(
  record: StoredTaskConversation,
  member: TaskConversationMember,
): string {
  const stored = record.memberConfigs[member.memberId]!;
  return fingerprint({ config: stored.preparedConfig ?? stored.config, env: stored.env });
}
function memberMatchesConfiguration(
  record: StoredTaskConversation,
  member: TaskConversationMember,
  expected: string,
): boolean {
  const stored = record.memberConfigs[member.memberId]!;
  return (
    memberConfigurationFingerprint(record, member) === expected ||
    fingerprint({ config: stored.config, env: stored.env }) === expected
  );
}
function sensitiveConfig(config: AgentSessionConfig): unknown {
  return Object.fromEntries(
    Object.entries(config).filter(
      // Trusted agent.create hooks add host MCP servers after task admission.
      ([key]) =>
        !["systemPrompt", "title", "internal", "daemonAppendSystemPrompt", "mcpServers"].includes(
          key,
        ),
    ),
  );
}

/** The sole writer of task public history; provider replay remains a member detail. */
export class TaskConversationService {
  private readonly authority = new AsyncLocalStorage<{ agentId?: string; control?: boolean }>();
  private readonly authorizedRuns = new WeakMap<AgentRunOptions, string>();
  private readonly listeners = new Map<string, Set<(update: Update) => void>>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly activeDeliveries = new Map<string, Promise<TaskConversationDelivery>>();
  private readonly projectionTails = new Map<string, Promise<void>>();
  private readonly pendingProjections = new Map<
    string,
    {
      timer: ReturnType<typeof setTimeout>;
      events: { agentId: string; event: AgentManagerEvent }[];
    }
  >();
  private readonly projectionSourceSeqs = new Map<string, number>();
  private readonly recoveryMembers = new Map<string, Set<string>>();
  private readonly recoveryOperations = new Map<string, Promise<Set<string>>>();
  private readonly unsubscribe: () => void;
  constructor(
    private readonly dependencies: {
      store: TaskConversationStore;
      agentManager: AgentManager;
      agentStorage: AgentStorage;
      workspaceRegistry: Pick<WorkspaceRegistry, "get">;
      plugins: Pick<PluginService, "before" | "hasBefore">;
      logger: Logger;
    },
  ) {
    dependencies.agentManager.taskConversations = this;
    for (const record of dependencies.store.list()) {
      if (record.snapshot.status === "archived") continue;
      try {
        dependencies.store.update(record.snapshot.conversationId, (current) => {
          for (const delivery of Object.values(current.deliveries)) {
            if (delivery.status === "prepared") {
              delivery.status = "rejected";
              delivery.error = "宿主在派发前重启，消息未投递。";
              this.markRejectedMessage(current, delivery.clientMessageId);
            } else if (delivery.status === "dispatching") {
              delivery.status = "unknown";
              delivery.error = "投递结果尚未核实；请查询原成员记录，不能自动重发。";
              current.snapshot.status = "paused";
            }
          }
          const unfinishedMembers = new Set(
            dependencies.store
              .queryRows(current, {
                kind: "assistant",
                completed: false,
              })
              .map((row) => row.source?.backendAgentId),
          );
          const members = current.snapshot.members.filter(
            (member) =>
              member.status === "running" ||
              current.recoveryMembers?.includes(member.backendAgentId) ||
              unfinishedMembers.has(member.backendAgentId) ||
              Object.values(current.deliveries).some(
                (delivery) =>
                  delivery.backendAgentId === member.backendAgentId &&
                  delivery.status === "unknown",
              ),
          );
          if (members.length) {
            this.recoveryMembers.set(
              current.snapshot.conversationId,
              new Set(members.map((member) => member.backendAgentId)),
            );
            current.snapshot.status = "paused";
            dependencies.store.append(current, {
              sourceKey: `recovery:${members
                .map((member) => member.backendAgentId)
                .sort()
                .join(":")}`,
              kind: "system",
              text: "宿主重启时有成员轮次尚未收口。将核对原始记录；确认完整性前暂停派发，不自动重发。",
              completed: true,
            });
          }
        });
      } catch (error) {
        dependencies.logger.warn(
          { err: error, conversationId: record.snapshot.conversationId },
          "Task conversation recovery failed; skipping record",
        );
      }
    }
    this.unsubscribe = dependencies.agentManager.subscribe((event) => this.onAgentEvent(event), {
      replayState: false,
    });
  }

  listByWorkspace(workspaceId: string): TaskConversationSnapshot[] {
    const record = this.dependencies.store.find({ workspaceId });
    return record ? [record.snapshot] : [];
  }
  runWithControl<T>(callback: () => T): T {
    return this.authority.run({ control: true }, callback);
  }
  getByAgentId(backendAgentId: string): TaskConversationSnapshot | null {
    return this.dependencies.store.find({ backendAgentId })?.snapshot ?? null;
  }
  assertAgentRun(agentId: string, options?: AgentRunOptions): void {
    if (
      this.dependencies.store.hasMember(agentId) &&
      (!options || this.authorizedRuns.get(options) !== agentId)
    )
      throw new Error(
        "task_conversation_route_required: 请通过任务会话发送，后台成员不接受普通发送入口。",
      );
  }
  assertAgentCreation(
    agentId: string,
    config: AgentSessionConfig,
    options: CreateAgentOptions,
  ): void {
    if (options.labels) this.assertAgentLabels(agentId, options.labels);
    const conversation = this.getByAgentId(agentId);
    const parentId = getParentAgentIdFromLabels(options.labels);
    if (
      this.dependencies.store.hasMember(agentId) ||
      options.labels?.[CONVERSATION_LABEL] ||
      (parentId && this.dependencies.store.hasMember(parentId))
    ) {
      if (!conversation || this.authority.getStore()?.agentId !== agentId || config.internal)
        throw new Error("task_conversation_member_admission_required");
      const member = conversation.members.find((entry) => entry.backendAgentId === agentId)!;
      this.dependencies.store.update(conversation.conversationId, (record) => {
        const stored = record.memberConfigs[member.memberId]!;
        const expected = stored.preparedConfig ?? stored.config;
        if (
          fingerprint(sensitiveConfig(expected)) !== fingerprint(sensitiveConfig(config)) ||
          fingerprint(stored.env ?? {}) !== fingerprint(options.env ?? {})
        )
          throw new Error("Task member sensitive configuration changed after admission");
        stored.preparedConfig = expected;
        stored.config = { ...config };
        delete stored.config.internal;
        record.snapshot.members.find((entry) => entry.memberId === member.memberId)!.config =
          stored.config;
      });
    }
  }
  recordMemberConfiguration(agentId: string, config: AgentSessionConfig): void {
    const conversation = this.getByAgentId(agentId);
    if (!conversation) return;
    this.dependencies.store.update(conversation.conversationId, (record) => {
      const member = record.snapshot.members.find((entry) => entry.backendAgentId === agentId)!;
      const actual = { ...config };
      delete actual.internal;
      record.memberConfigs[member.memberId]!.config = actual;
      member.config = actual;
    });
  }
  assertAgentMutation(agentId: string, operation: string): void {
    if (
      this.dependencies.store.hasMember(agentId) &&
      !this.authority.getStore()?.control &&
      this.authority.getStore()?.agentId !== agentId
    )
      throw new Error(`task_conversation_control_required: ${operation}`);
  }
  assertAgentLabels(agentId: string, labels: Record<string, string | null>): void {
    const conversation = this.getByAgentId(agentId);
    if (Object.hasOwn(labels, CONVERSATION_LABEL) || Object.hasOwn(labels, MEMBER_LABEL)) {
      const scope = this.authority.getStore();
      if (!conversation || !(scope?.control || scope?.agentId === agentId))
        throw new Error(
          "task_conversation_reserved_labels: Task member identity is owned by the host",
        );
      const member = conversation.members.find((entry) => entry.backendAgentId === agentId)!;
      if (
        (Object.hasOwn(labels, CONVERSATION_LABEL) &&
          labels[CONVERSATION_LABEL] !== conversation.conversationId) ||
        (Object.hasOwn(labels, MEMBER_LABEL) && labels[MEMBER_LABEL] !== member.memberId)
      )
        throw new Error(
          "task_conversation_reserved_labels: Task member identity must match its canonical binding",
        );
    }
    if (!conversation && !this.dependencies.store.hasMember(agentId)) return;
    if (
      Object.keys(labels).some(
        (key) =>
          key === PARENT_AGENT_ID_LABEL ||
          key === CONVERSATION_LABEL ||
          key === MEMBER_LABEL ||
          isOpenAgentTabLabel(key),
      )
    )
      this.assertAgentMutation(agentId, "change member ownership");
  }

  async create(
    input: Input<TaskConversationCreateRequest>,
    onReady?: (conversation: TaskConversationSnapshot) => Promise<void>,
  ): Promise<TaskConversationSnapshot> {
    const workspace = await this.dependencies.workspaceRegistry.get(input.workspaceId);
    if (!workspace || workspace.archivedAt)
      throw new Error("Task workspace is missing or archived");
    if (input.initialMessage && !input.initialRecipient)
      throw new Error("Initial task recipient is required");
    const now = new Date().toISOString();
    const record = this.dependencies.store.create(
      {
        conversationId: randomUUID(),
        workspaceId: input.workspaceId,
        anchorAgentId: null,
        ownerPluginId: input.ownerPluginId,
        status: "active",
        epoch: randomUUID(),
        lastSeq: 0,
        members: [],
        createdAt: now,
        updatedAt: now,
      },
      { idempotencyKey: input.idempotencyKey, fingerprint: fingerprint(input) },
    );
    await onReady?.(record.snapshot);
    if (input.initialMessage && input.initialRecipient) {
      const delivery = await this.send(
        {
          conversationId: record.snapshot.conversationId,
          recipient: input.initialRecipient,
          ...input.initialMessage,
        },
        onReady,
      );
      if (delivery.status !== "accepted")
        throw new Error(delivery.error ?? `Task initial delivery is ${delivery.status}`);
    }
    return this.require(record.snapshot.conversationId).snapshot;
  }
  resolve(input: Input<TaskConversationResolveRequest>): TaskConversationSnapshot | null {
    if (input.conversationId)
      return this.dependencies.store.get(input.conversationId)?.snapshot ?? null;
    return this.dependencies.store.find(input)?.snapshot ?? null;
  }
  getDelivery(input: {
    conversationId: string;
    clientMessageId: string;
  }): TaskConversationDelivery | null {
    const delivery = ownGet(this.require(input.conversationId).deliveries, input.clientMessageId);
    return delivery ? TaskConversationDeliverySchema.parse(delivery) : null;
  }
  fetch(input: Input<TaskConversationFetchRequest>): TaskConversationPage {
    return this.dependencies.store.fetch(input.conversationId, input);
  }
  subscribe(conversationId: string, listener: (update: Update) => void): () => void {
    this.require(conversationId);
    const listeners = this.listeners.get(conversationId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(conversationId, listeners);
    void this.reconcile(conversationId).catch((error) =>
      this.dependencies.logger.warn(
        { err: error, conversationId },
        "Task source reconciliation failed",
      ),
    );
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(conversationId);
    };
  }
  async publish(input: Input<TaskConversationPublishRequest>): Promise<TaskConversationRow> {
    if (input.kind === "assistant" || input.kind === "user")
      throw new Error("Canonical task speech is owned by the host");
    const row = this.dependencies.store.update(input.conversationId, (record) => {
      if (
        input.source &&
        !record.snapshot.members.some(
          (member) =>
            member.memberId === input.source!.memberId &&
            member.backendAgentId === input.source!.backendAgentId,
        )
      )
        throw new Error("Task source does not belong to this conversation");
      if (input.speaker) {
        const member = record.snapshot.members.find(
          (entry) =>
            entry.memberId === input.speaker!.memberId &&
            entry.backendAgentId === input.speaker!.backendAgentId,
        );
        if (
          !member ||
          input.speaker.role !== member.role ||
          input.speaker.provider !== member.config.provider ||
          (input.source && input.source.backendAgentId !== input.speaker.backendAgentId)
        )
          throw new Error("Task speaker does not belong to this conversation");
      }
      const { conversationId: _conversationId, ...rowInput } = input;
      return this.dependencies.store.append(record, rowInput);
    });
    this.notify(input.conversationId, { row, eventSeq: row.updatedSeq ?? row.seq });
    return row;
  }
  querySource(input: Input<TaskConversationQuerySourceRequest>): TaskConversationRow | null {
    return this.dependencies.store.querySource(input.conversationId, input);
  }

  send(
    input: Input<TaskConversationSendRequest>,
    onReady?: (conversation: TaskConversationSnapshot) => Promise<void>,
  ): Promise<TaskConversationDelivery> {
    const identity = `${input.conversationId}:${input.clientMessageId}`;
    const running = this.activeDeliveries.get(identity);
    if (running)
      return running.then((delivery) => {
        const stored = this.require(input.conversationId).deliveries[input.clientMessageId];
        if (stored.requestFingerprint !== fingerprint(input))
          throw new Error("task_message_id_conflict");
        return TaskConversationDeliverySchema.parse(delivery);
      });
    const previous = this.queues.get(input.conversationId) ?? Promise.resolve();
    const result = previous
      .catch(() => undefined)
      .then(() => this.dispatch(input, onReady))
      .then((delivery) => TaskConversationDeliverySchema.parse(delivery));
    this.queues.set(input.conversationId, result);
    this.activeDeliveries.set(identity, result);
    void result
      .finally(() => {
        this.activeDeliveries.delete(identity);
        if (this.queues.get(input.conversationId) === result)
          this.queues.delete(input.conversationId);
      })
      .catch(() => undefined);
    return result;
  }

  private async prepareDispatch(input: Input<TaskConversationSendRequest>) {
    let record = this.require(input.conversationId);
    if (
      record.snapshot.status === "stopping" ||
      record.snapshot.status === "archived" ||
      record.control?.status === "unknown" ||
      Object.values(record.deliveries).some((entry) => entry.status === "unknown")
    )
      throw new Error("Task conversation is stopping, archived or has an unknown delivery");
    if (
      !input.recipient.parentMemberId &&
      record.snapshot.members.some(
        (member) =>
          !member.parentMemberId &&
          this.dependencies.agentManager.hasInFlightRun(member.backendAgentId),
      )
    )
      throw new Error("Task member is busy; stop the current round before handing over");
    const workspace = await this.dependencies.workspaceRegistry.get(record.snapshot.workspaceId);
    if (!workspace || workspace.archivedAt)
      throw new Error("Task workspace is missing or archived");
    const requestedRecipient = {
      ...input.recipient,
      config: { ...input.recipient.config, cwd: workspace.cwd },
    };
    await this.validateAttachments([{ attachments: input.attachments }], workspace.cwd);
    const result = await this.prepareRecipient(record, input, requestedRecipient);
    await this.admit(
      record.snapshot,
      {
        memberId: result.memberId,
        backendAgentId: result.backendAgentId,
        recipient: requestedRecipient,
        clientMessageId: input.clientMessageId,
      },
      result.candidate ? "send" : "create",
    );
    record = this.require(input.conversationId);
    if (
      record.snapshot.status === "stopping" ||
      record.snapshot.status === "archived" ||
      record.control?.status === "unknown"
    )
      throw new Error("Task conversation was stopped during admission");
    return { ...result, requestedRecipient };
  }

  private async prepareRecipient(
    record: StoredTaskConversation,
    input: Input<TaskConversationSendRequest>,
    requestedRecipient: TaskConversationRecipient,
  ) {
    const cwd = requestedRecipient.config.cwd;
    let candidate = this.selectMember(record, requestedRecipient);
    let { memberId, backendAgentId } = memberIdentity(candidate, requestedRecipient.memberId);
    if (candidate && this.dependencies.agentManager.hasInFlightRun(backendAgentId))
      throw new Error("Task member is already running");
    const throughSeq = record.snapshot.lastSeq;
    const contextForMember = () =>
      unseenContext(this.dependencies.store, record, candidate, backendAgentId, throughSeq);
    let publicContext = contextForMember();
    await this.validateAttachments(publicContext, cwd);
    const prepareForMember = () =>
      this.dependencies.plugins.before(
        "task.conversation.prepare",
        {
          conversationId: input.conversationId,
          workspaceId: record.snapshot.workspaceId,
          ownerPluginId: record.snapshot.ownerPluginId,
          anchorAgentId: record.snapshot.anchorAgentId,
          memberId,
          backendAgentId,
          recipient: requestedRecipient,
          clientMessageId: input.clientMessageId,
          text: input.text,
          throughSeq,
          publicContext,
          ready: false,
        },
        { pluginId: record.snapshot.ownerPluginId },
      );
    let prepare = await prepareForMember();
    let config = preparedConfig(prepare, cwd);
    let env =
      prepare.env ??
      requestedRecipient.env ??
      (candidate ? record.memberConfigs[candidate.memberId]!.env : undefined);
    const effectiveFingerprint = fingerprint({ config, env });
    if (candidate && !memberMatchesConfiguration(record, candidate, effectiveFingerprint)) {
      if (requestedRecipient.memberId)
        throw new Error("Task member configuration does not match the selected member");
      candidate = record.snapshot.members.findLast(
        (member) =>
          record.memberConfigs[member.memberId]!.fingerprint ===
            recipientConfigurationFingerprint(requestedRecipient) &&
          memberMatchesConfiguration(record, member, effectiveFingerprint),
      );
      ({ memberId, backendAgentId } = memberIdentity(candidate));
      publicContext = contextForMember();
      await this.validateAttachments(publicContext, cwd);
      prepare = await prepareForMember();
      config = preparedConfig(prepare, cwd);
      env = prepare.env ?? requestedRecipient.env;
      if (fingerprint({ config, env }) !== effectiveFingerprint)
        throw new Error("Task effective configuration changed during preparation");
    }
    const summary = prepare.summary ?? candidate?.summary;
    validateSummary(summary, candidate?.summary, throughSeq);
    if (config.provider !== requestedRecipient.config.provider)
      throw new Error("Task preparation changed the requested provider");
    return {
      candidate,
      memberId,
      backendAgentId,
      throughSeq,
      publicContext,
      prepare,
      config,
      env,
      summary,
    };
  }

  private selectMember(
    record: StoredTaskConversation,
    recipient: TaskConversationRecipient,
  ): TaskConversationMember | undefined {
    if (!recipient.memberId)
      return record.snapshot.members.findLast(
        (member) =>
          record.memberConfigs[member.memberId]!.fingerprint ===
          recipientConfigurationFingerprint(recipient),
      );
    this.assertMemberIdentityAvailable(record.snapshot.conversationId, recipient.memberId);
    const member = record.snapshot.members.find((entry) => entry.memberId === recipient.memberId);
    if (
      member &&
      (member.role !== recipient.role || member.parentMemberId !== recipient.parentMemberId)
    )
      throw new Error("Task member role or parent does not match the selected member");
    return member;
  }

  private assertMemberIdentityAvailable(conversationId: string, memberId: string): void {
    if (
      this.dependencies.store
        .list()
        .some(
          (record) =>
            record.snapshot.conversationId !== conversationId &&
            record.snapshot.members.some((member) => member.memberId === memberId),
        )
    )
      throw new Error("Task member belongs to another conversation");
  }

  private async dispatch(
    input: Input<TaskConversationSendRequest>,
    onReady?: (conversation: TaskConversationSnapshot) => Promise<void>,
  ): Promise<TaskConversationDelivery> {
    const prior = ownGet(this.require(input.conversationId).deliveries, input.clientMessageId);
    if (prior) {
      if (prior.requestFingerprint !== fingerprint(input))
        throw new Error("task_message_id_conflict");
      return prior;
    }
    const {
      candidate,
      memberId,
      backendAgentId,
      throughSeq,
      requestedRecipient,
      publicContext,
      prepare,
      config,
      env,
      summary,
    } = await this.prepareDispatch(input);
    const member: TaskConversationMember = candidate ?? {
      memberId,
      backendAgentId,
      role: input.recipient.role,
      presetId: input.recipient.presetId,
      config,
      parentMemberId: input.recipient.parentMemberId,
      seenConversationSeq: 0,
      lastRequestAt: null,
      status: "initializing",
      pendingPermissions: [],
    };
    const delivery: TaskConversationDelivery = {
      deliveryId: input.clientMessageId,
      conversationId: input.conversationId,
      clientMessageId: input.clientMessageId,
      status: "prepared",
      memberId,
      backendAgentId,
      throughSeq,
      error: null,
    };
    let userRow!: TaskConversationRow;
    let childRow: TaskConversationRow | undefined;
    this.dependencies.store.update(input.conversationId, (current) => {
      current.snapshot.status = "active";
      if (!candidate) {
        this.assertMemberIdentityAvailable(input.conversationId, memberId);
        if (
          member.parentMemberId &&
          !current.snapshot.members.some((parent) => parent.memberId === member.parentMemberId)
        )
          throw new Error("Task parent member is missing");
        current.snapshot.members.push(member);
        ownSet(current.memberConfigs, memberId, {
          config,
          preparedConfig: config,
          env,
          fingerprint: recipientConfigurationFingerprint(requestedRecipient),
        });
        current.snapshot.anchorAgentId ??= backendAgentId;
        if (member.parentMemberId)
          childRow = this.dependencies.store.append(current, {
            sourceKey: `child:${memberId}`,
            kind: "child",
            text: member.role,
            speaker: this.speaker(member),
            source: { memberId, backendAgentId },
            child: { backendAgentId, memberId },
            completed: true,
          });
      }
      ownSet(current.deliveries, input.clientMessageId, {
        ...delivery,
        requestFingerprint: fingerprint(input),
      });
      userRow = this.dependencies.store.append(current, {
        sourceKey: `human:${input.clientMessageId}`,
        kind: "user",
        text: input.text,
        images: input.images,
        attachments: input.attachments,
        clientMessageId: input.clientMessageId,
        speaker: this.speaker(member),
        source: { memberId, backendAgentId },
        completed: true,
      });
    });
    await onReady?.(this.require(input.conversationId).snapshot);
    if (childRow)
      this.notify(input.conversationId, {
        row: childRow,
        eventSeq: childRow.updatedSeq ?? childRow.seq,
      });
    this.notify(input.conversationId, {
      conversation: this.require(input.conversationId).snapshot,
      row: userRow,
      eventSeq: userRow.updatedSeq ?? userRow.seq,
    });
    const internal =
      publicContext.length || prepare.context || summary
        ? formatSystemNotificationPrompt(
            JSON.stringify({
              conversationId: input.conversationId,
              throughSeq,
              summary,
              messages: publicContext
                .filter((row) => (row.updatedSeq ?? row.seq) > (summary?.throughSeq ?? 0))
                .map((row) =>
                  Object.assign({}, row, {
                    images: row.images?.map((image, index) => ({
                      mimeType: image.mimeType,
                      reference: `${input.conversationId}:${row.seq}:image:${index}`,
                    })),
                  }),
                ),
              context: prepare.context,
            }),
          )
        : "";
    const prompt = buildAgentPrompt(input.text, input.images, input.attachments);
    const contextImages = publicContext.flatMap((row) =>
      (row.images ?? []).map((image) => ({
        type: "image" as const,
        data: image.data,
        mimeType: image.mimeType,
      })),
    );
    const preparedPrompt: AgentPromptInput = internal
      ? [
          { type: "text", text: internal },
          ...contextImages,
          ...(typeof prompt === "string" ? [{ type: "text" as const, text: prompt }] : prompt),
        ]
      : prompt;
    return this.authority.run({ agentId: backendAgentId }, async () => {
      let providerStarted = false;
      try {
        if (
          candidate &&
          (this.dependencies.agentManager.getAgent(backendAgentId) ||
            (await this.dependencies.agentStorage.get(backendAgentId)))
        )
          await ensureAgentLoaded(backendAgentId, {
            agentManager: this.dependencies.agentManager,
            agentStorage: this.dependencies.agentStorage,
            logger: this.dependencies.logger,
          });
        else {
          const snapshot = this.require(input.conversationId).snapshot;
          const parent = member.parentMemberId
            ? snapshot.members.find((entry) => entry.memberId === member.parentMemberId)
                ?.backendAgentId
            : snapshot.anchorAgentId;
          await this.dependencies.agentManager.createAgent(config, backendAgentId, {
            workspaceId: snapshot.workspaceId,
            labels: {
              [CONVERSATION_LABEL]: input.conversationId,
              [MEMBER_LABEL]: memberId,
              ...(parent && parent !== backendAgentId ? { [PARENT_AGENT_ID_LABEL]: parent } : {}),
            },
            env,
          });
        }
        if (this.require(input.conversationId).snapshot.status !== "active")
          throw new Error("Task stopped before dispatch");
        this.dependencies.store.update(input.conversationId, (current) => {
          current.deliveries[input.clientMessageId].status = "dispatching";
          const target = current.snapshot.members.find((entry) => entry.memberId === memberId)!;
          // Persist recovery intent with the FULL dispatch receipt, before the
          // first throttled text/state batch can be lost in a crash.
          target.status = "running";
          target.lastRequestAt = new Date().toISOString();
        });
        const runOptions = { clientMessageId: delivery.deliveryId };
        this.authorizedRuns.set(runOptions, backendAgentId);
        let iterator: AsyncGenerator<import("../agent/agent-sdk-types.js").AgentStreamEvent>;
        try {
          iterator = this.dependencies.agentManager.streamAgent(
            backendAgentId,
            preparedPrompt,
            runOptions,
          );
        } finally {
          this.authorizedRuns.delete(runOptions);
        }
        providerStarted = true;
        const first = await iterator.next();
        if (first.done || first.value.type !== "turn_started")
          throw new Error("Provider did not confirm task delivery");
        this.dependencies.store.update(input.conversationId, (current) => {
          const accepted = current.deliveries[input.clientMessageId];
          accepted.status = "accepted";
          accepted.sourceTurnId =
            first.value.type === "turn_started" ? first.value.turnId : undefined;
          const target = current.snapshot.members.find((entry) => entry.memberId === memberId)!;
          target.seenConversationSeq = throughSeq;
          if (summary) target.summary = summary;
        });
        this.notifySnapshot(input.conversationId);
        void this.drain(iterator, input.conversationId, backendAgentId).catch((error) =>
          this.dependencies.logger.warn({ err: error }, "Task member stream failed"),
        );
        return this.require(input.conversationId).deliveries[input.clientMessageId];
      } catch (error) {
        const rejectedRow = this.dependencies.store.update(input.conversationId, (current) => {
          const failed = current.deliveries[input.clientMessageId];
          failed.status = providerStarted ? "unknown" : "rejected";
          failed.error = errorText(error);
          if (failed.status === "unknown") {
            current.snapshot.status = "paused";
            this.trackRecovery(input.conversationId, backendAgentId);
          } else {
            const target = current.snapshot.members.find((entry) => entry.memberId === memberId)!;
            if (target.status === "running") target.status = "idle";
            return this.markRejectedMessage(current, input.clientMessageId);
          }
        });
        if (rejectedRow)
          this.notify(input.conversationId, {
            row: rejectedRow,
            eventSeq: rejectedRow.updatedSeq ?? rejectedRow.seq,
          });
        this.notifySnapshot(input.conversationId);
        return this.require(input.conversationId).deliveries[input.clientMessageId];
      }
    });
  }

  private async drain(
    iterator: AsyncGenerator<import("../agent/agent-sdk-types.js").AgentStreamEvent>,
    conversationId: string,
    agentId: string,
  ): Promise<void> {
    for await (const event of iterator) {
      if (event.type === "turn_failed")
        this.dependencies.logger.warn({ agentId, error: event.error }, "Task member turn failed");
    }
    this.flushProjection(conversationId, agentId);
    await this.projectionTails.get(conversationId);
  }
  private async admit(
    snapshot: TaskConversationSnapshot,
    detail: {
      memberId: string;
      backendAgentId: string;
      recipient: TaskConversationRecipient;
      clientMessageId: string;
    },
    operation: "send" | "compact" | "create",
  ): Promise<void> {
    const admission = await this.dependencies.plugins.before(
      "task.conversation.admit",
      {
        conversationId: snapshot.conversationId,
        workspaceId: snapshot.workspaceId,
        ownerPluginId: snapshot.ownerPluginId,
        anchorAgentId: snapshot.anchorAgentId,
        ...detail,
        operation,
        admitted: false,
      },
      { pluginId: snapshot.ownerPluginId },
    );
    if (!admission.admitted) throw new Error(admission.reason ?? "Task admission is unavailable");
  }
  private speaker(member: TaskConversationMember) {
    const runtime = this.dependencies.agentManager.getAgent(member.backendAgentId)?.runtimeInfo;
    return {
      role: member.role,
      memberId: member.memberId,
      backendAgentId: member.backendAgentId,
      provider: member.config.provider,
      model: runtime?.model ?? member.config.model ?? null,
      thinkingOptionId: runtime?.thinkingOptionId ?? member.config.thinkingOptionId ?? null,
      presetId: member.presetId,
    };
  }

  assertPermissionApproval(
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse,
  ): void {
    if (response.behavior !== "allow") return;
    const conversation = this.getByAgentId(agentId);
    const member = conversation?.members.find((entry) => entry.backendAgentId === agentId);
    if (!member) return;
    const config = member.config;
    const readOnlyVerifier =
      member.role === "verifier" &&
      (config.modeId === "plan" ||
        config.modeId === "read-only" ||
        config.providerOptions?.sandbox_mode === "read-only");
    if (!READ_ONLY_TASK_ROLES.has(member.role) && !readOnlyVerifier) return;
    const request =
      this.dependencies.agentManager.getAgent(agentId)?.pendingPermissions?.get(requestId) ??
      member.pendingPermissions?.find((entry) => entry.id === requestId);
    if (response.updatedPermissions?.length || request?.kind !== "question")
      throw new Error(
        "该任务成员为只读角色，只能回答提问，不能批准工具或修改权限；请通过任务面板确认执行。",
      );
  }
  async preparePermissionResponse(
    agentId: string,
    requestId?: string,
    response?: AgentPermissionResponse,
  ): Promise<void> {
    const conversation = this.getByAgentId(agentId);
    if (!conversation) throw new Error("Task member is missing");
    this.assertPermissionResponse(this.require(conversation.conversationId));
    if (requestId && response) this.assertPermissionApproval(agentId, requestId, response);
    await this.authority.run({ agentId }, () =>
      ensureAgentLoaded(agentId, {
        agentManager: this.dependencies.agentManager,
        agentStorage: this.dependencies.agentStorage,
        logger: this.dependencies.logger,
      }),
    );
    this.assertPermissionResponse(this.require(conversation.conversationId));
    if (requestId && response) this.assertPermissionApproval(agentId, requestId, response);
  }
  async continuePermission(
    agentId: string,
    prompt: AgentPromptInput,
    requestId: string,
  ): Promise<void> {
    const conversation = this.getByAgentId(agentId);
    if (!conversation) throw new Error("Task member is missing");
    const conversationId = conversation.conversationId;
    const previous = this.queues.get(conversationId) ?? Promise.resolve();
    const result = previous
      .catch(() => undefined)
      .then(() => this.dispatchPermission(agentId, prompt, requestId));
    this.queues.set(conversationId, result);
    try {
      await result;
    } finally {
      if (this.queues.get(conversationId) === result) this.queues.delete(conversationId);
    }
  }

  private async dispatchPermission(
    agentId: string,
    prompt: AgentPromptInput,
    requestId: string,
  ): Promise<void> {
    const conversation = this.getByAgentId(agentId);
    if (!conversation) throw new Error("Task member is missing");
    const stored = this.require(conversation.conversationId);
    this.assertPermissionResponse(stored);
    const member = conversation.members.find((entry) => entry.backendAgentId === agentId)!;
    const clientMessageId = `permission:${agentId}:${requestId}`;
    await this.admit(
      conversation,
      {
        memberId: member.memberId,
        backendAgentId: agentId,
        recipient: {
          role: member.role,
          presetId: member.presetId,
          config: member.config,
          parentMemberId: member.parentMemberId,
        },
        clientMessageId,
      },
      "send",
    );
    const runOptions = { clientMessageId };
    this.dependencies.store.update(conversation.conversationId, (record) => {
      if (record.snapshot.status === "stopping" || record.snapshot.status === "archived")
        throw new Error("Task stopped during approval admission");
      if (ownGet(record.deliveries, clientMessageId))
        throw new Error("Permission follow-up was already dispatched; inspect its receipt");
      ownSet(record.deliveries, clientMessageId, {
        deliveryId: clientMessageId,
        conversationId: conversation.conversationId,
        clientMessageId,
        backendAgentId: agentId,
        memberId: member.memberId,
        status: "dispatching",
        throughSeq: member.seenConversationSeq,
        error: null,
        requestFingerprint: fingerprint(prompt),
      });
      const target = record.snapshot.members.find((entry) => entry.memberId === member.memberId)!;
      target.status = "running";
      target.lastRequestAt = new Date().toISOString();
    });
    let providerStarted = false;
    await this.authority.run({ agentId }, async () => {
      try {
        await ensureAgentLoaded(agentId, {
          agentManager: this.dependencies.agentManager,
          agentStorage: this.dependencies.agentStorage,
          logger: this.dependencies.logger,
        });
        this.authorizedRuns.set(runOptions, agentId);
        const iterator = this.dependencies.agentManager.hasInFlightRun(agentId)
          ? await this.dependencies.agentManager.replaceAgentRun(agentId, prompt, runOptions)
          : this.dependencies.agentManager.streamAgent(agentId, prompt, runOptions);
        providerStarted = true;
        this.authorizedRuns.delete(runOptions);
        const first = await iterator.next();
        if (first.done || first.value.type !== "turn_started")
          throw new Error("Provider did not confirm permission follow-up");
        this.dependencies.store.update(conversation.conversationId, (record) => {
          record.snapshot.status = "active";
          record.deliveries[clientMessageId].status = "accepted";
          record.deliveries[clientMessageId].sourceTurnId =
            first.value.type === "turn_started" ? first.value.turnId : undefined;
        });
        void this.drain(iterator, conversation.conversationId, agentId).catch((error) =>
          this.dependencies.logger.warn({ err: error }, "Task permission follow-up failed"),
        );
      } catch (error) {
        this.dependencies.store.update(conversation.conversationId, (record) => {
          record.deliveries[clientMessageId].status = providerStarted ? "unknown" : "rejected";
          record.deliveries[clientMessageId].error = errorText(error);
          if (providerStarted) {
            record.snapshot.status = "paused";
            this.trackRecovery(conversation.conversationId, agentId);
          } else {
            const target = record.snapshot.members.find(
              (entry) => entry.memberId === member.memberId,
            )!;
            if (target.status === "running") target.status = "idle";
          }
        });
        throw error;
      } finally {
        this.authorizedRuns.delete(runOptions);
      }
    });
    this.notifySnapshot(conversation.conversationId);
  }

  private assertPermissionResponse(record: StoredTaskConversation): void {
    if (
      record.snapshot.status === "stopping" ||
      record.snapshot.status === "archived" ||
      record.control?.status === "unknown" ||
      Object.values(record.deliveries).some((delivery) => delivery.status === "unknown")
    )
      throw new Error(
        "Task approval is blocked until its pending control or delivery is reconciled",
      );
  }

  async stop(input: Input<TaskConversationStopRequest>): Promise<TaskConversationSnapshot> {
    let snapshot = this.require(input.conversationId).snapshot;
    if (input.memberId && !snapshot.members.some((member) => member.memberId === input.memberId))
      throw new Error("Task member is missing");
    this.dependencies.store.update(input.conversationId, (record) => {
      record.snapshot.status = "stopping";
      record.control = { status: "stopping", memberId: input.memberId };
    });
    this.notifySnapshot(input.conversationId);
    await this.controlNotice(snapshot, input.memberId ? "stop_member" : "stop", "before");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const dispatch = this.queues.get(input.conversationId);
    const dispatchSettled =
      !dispatch ||
      (await Promise.race([
        dispatch.then(
          () => true,
          () => true,
        ),
        new Promise<false>((done) => {
          timer = setTimeout(() => done(false), 15_000);
        }),
      ]));
    if (timer) clearTimeout(timer);
    this.flushProjection(input.conversationId);
    await this.projectionTails.get(input.conversationId);
    snapshot = this.require(input.conversationId).snapshot;
    const selected = input.memberId
      ? snapshot.members.filter((member) => member.memberId === input.memberId)
      : snapshot.members;
    const recoveryRecord = this.require(input.conversationId);
    const unfinishedMembers = new Set(
      this.dependencies.store
        .queryRows(recoveryRecord, {
          kind: "assistant",
          completed: false,
        })
        .map((row) => row.source?.backendAgentId),
    );
    const uncertainMembers = new Set(
      selected
        .filter(
          (member) =>
            this.dependencies.agentManager.hasInFlightRun(member.backendAgentId) ||
            member.status === "running" ||
            recoveryRecord.recoveryMembers?.includes(member.backendAgentId) ||
            this.recoveryMembers.get(input.conversationId)?.has(member.backendAgentId) ||
            Object.values(recoveryRecord.deliveries).some(
              (delivery) =>
                delivery.backendAgentId === member.backendAgentId && delivery.status === "unknown",
            ) ||
            unfinishedMembers.has(member.backendAgentId),
        )
        .map((member) => member.backendAgentId),
    );
    // Cancellation may publish idle/completed before native history is read.
    // Keep the recovery obligation durable across a crash in that interval.
    this.dependencies.store.update(input.conversationId, (current) => {
      current.recoveryMembers = [
        ...new Set([...(current.recoveryMembers ?? []), ...uncertainMembers]),
      ];
    });
    for (const agentId of uncertainMembers) this.trackRecovery(input.conversationId, agentId);
    const outcomes = await Promise.all(
      selected.map(async (member) => {
        try {
          if (!this.dependencies.agentManager.getAgent(member.backendAgentId)) {
            if (!uncertainMembers.has(member.backendAgentId)) return true;
            const stored = await this.dependencies.agentStorage.get(member.backendAgentId);
            if (!stored?.persistence) return false;
            await this.authority.run({ agentId: member.backendAgentId }, () =>
              ensureAgentLoaded(member.backendAgentId, {
                agentManager: this.dependencies.agentManager,
                agentStorage: this.dependencies.agentStorage,
                logger: this.dependencies.logger,
              }),
            );
          }
          return (
            (
              await this.authority.run({ control: true }, () =>
                this.dependencies.agentManager.cancelAgentRun(member.backendAgentId),
              )
            ).status !== "refused"
          );
        } catch {
          return false;
        }
      }),
    );
    const settled = dispatchSettled && outcomes.every(Boolean);
    this.dependencies.store.update(input.conversationId, (record) => {
      record.snapshot.status = "paused";
      record.control = { status: settled ? "settled" : "unknown", memberId: input.memberId };
    });
    await this.controlNotice(
      snapshot,
      input.memberId ? "stop_member" : "stop",
      settled ? "settled" : "unknown",
      selected[0]?.backendAgentId,
    );
    this.notifySnapshot(input.conversationId);
    if (!settled) throw new Error("Task cancellation is unknown; resources must remain reserved");
    this.flushProjection(input.conversationId);
    await this.projectionTails.get(input.conversationId);
    const reconciled = await this.reconcile(input.conversationId);
    this.completeStoppedMembers(input.conversationId, selected);
    if (input.reconcileDelivery) {
      const resolution = input.reconcileDelivery;
      const rejectedRow = this.dependencies.store.update(input.conversationId, (record) => {
        const delivery = ownGet(record.deliveries, resolution.clientMessageId);
        if (
          !delivery ||
          !selected.some((member) => member.backendAgentId === delivery.backendAgentId)
        )
          throw new Error("Task delivery does not belong to the selected member");
        if (resolution.resolution === "accepted") {
          if (delivery.status !== "accepted" || !delivery.sourceTurnId)
            throw new Error("Task delivery has no confirmed provider receipt");
        } else {
          if (delivery.status !== "unknown")
            throw new Error("Only an unknown task delivery can be explicitly rejected");
          delivery.status = "rejected";
          delivery.error = "经人工核对确认未投递，已解除结果不明状态。";
          return this.markRejectedMessage(record, delivery.clientMessageId);
        }
      });
      if (rejectedRow)
        this.notify(input.conversationId, {
          row: rejectedRow,
          eventSeq: rejectedRow.updatedSeq ?? rejectedRow.seq,
        });
      this.notifySnapshot(input.conversationId);
    }
    this.clearRejectedRecovery(input, reconciled);
    return this.require(input.conversationId).snapshot;
  }
  private clearRejectedRecovery(
    input: Input<TaskConversationStopRequest>,
    reconciled: Set<string>,
  ): void {
    if (input.reconcileDelivery?.resolution === "rejected") {
      const current = this.require(input.conversationId);
      const agentId = current.deliveries[input.reconcileDelivery.clientMessageId]!.backendAgentId;
      if (
        reconciled.has(agentId) &&
        !Object.values(current.deliveries).some(
          (delivery) => delivery.backendAgentId === agentId && delivery.status === "unknown",
        )
      )
        this.recoveryMembers.get(input.conversationId)?.delete(agentId);
      this.dependencies.store.update(input.conversationId, (record) => {
        record.recoveryMembers = [...(this.recoveryMembers.get(input.conversationId) ?? [])];
      });
    }
  }
  private completeStoppedMembers(conversationId: string, members: TaskConversationMember[]): void {
    const ids = new Set(members.map((member) => member.backendAgentId));
    const rows = this.dependencies.store.update(conversationId, (record) => {
      for (const member of record.snapshot.members) {
        if (ids.has(member.backendAgentId) && member.status !== "error") member.status = "idle";
      }
      return this.dependencies.store
        .queryRows(record, {
          kind: "assistant",
          completed: false,
          backendAgentIds: [...ids],
        })
        .map((row) => this.dependencies.store.replaceRow(record, row, { completed: true }));
    });
    for (const row of rows)
      this.notify(conversationId, { row, eventSeq: row.updatedSeq ?? row.seq });
    this.notifySnapshot(conversationId);
  }
  async archive(input: Input<TaskConversationArchiveRequest>): Promise<TaskConversationSnapshot> {
    await this.stop(input);
    return this.authority.run({ control: true }, async () => {
      const snapshot = this.require(input.conversationId).snapshot;
      await this.controlNotice(snapshot, "archive", "before");
      for (const member of snapshot.members.toReversed()) {
        if (this.dependencies.agentManager.getAgent(member.backendAgentId))
          await this.dependencies.agentManager.archiveAgent(member.backendAgentId);
        else if (await this.dependencies.agentStorage.get(member.backendAgentId))
          await this.dependencies.agentManager.archiveSnapshot(
            member.backendAgentId,
            new Date().toISOString(),
          );
      }
      this.dependencies.store.update(input.conversationId, (record) => {
        record.snapshot.status = "archived";
        record.snapshot.archivedAt = new Date().toISOString();
        for (const member of record.snapshot.members) member.pendingPermissions = [];
      });
      await this.controlNotice(snapshot, "archive", "settled");
      this.notifySnapshot(input.conversationId);
      return this.require(input.conversationId).snapshot;
    });
  }
  async compact(input: Input<TaskConversationCompactRequest>): Promise<TaskConversationSnapshot> {
    const previous = this.queues.get(input.conversationId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(() => this.compactMember(input));
    this.queues.set(input.conversationId, result);
    try {
      return await result;
    } finally {
      if (this.queues.get(input.conversationId) === result)
        this.queues.delete(input.conversationId);
    }
  }
  private async compactMember(
    input: Input<TaskConversationCompactRequest>,
  ): Promise<TaskConversationSnapshot> {
    const snapshot = this.require(input.conversationId).snapshot;
    const member = snapshot.members.find((entry) => entry.memberId === input.memberId);
    if (!member) throw new Error("Task member is missing");
    if (snapshot.status !== "active") throw new Error("Task is paused or archived");
    if (this.dependencies.agentManager.hasInFlightRun(member.backendAgentId))
      throw new Error("Task member is busy");
    await this.admit(
      snapshot,
      {
        memberId: member.memberId,
        backendAgentId: member.backendAgentId,
        recipient: { role: member.role, presetId: member.presetId, config: member.config },
        clientMessageId: `compact:${randomUUID()}`,
      },
      "compact",
    );
    await this.controlNotice(snapshot, "compact", "before", member.backendAgentId);
    await this.authority.run({ agentId: member.backendAgentId }, async () => {
      const runOptions = { clientMessageId: `compact:${randomUUID()}` };
      this.authorizedRuns.set(runOptions, member.backendAgentId);
      let completion: { promise: Promise<void>; dispose(): void } | null = null;
      let handled: boolean | undefined;
      try {
        await ensureAgentLoaded(member.backendAgentId, {
          agentManager: this.dependencies.agentManager,
          agentStorage: this.dependencies.agentStorage,
          logger: this.dependencies.logger,
        });
        completion = this.observeCompaction(member.backendAgentId);
        this.dependencies.store.update(input.conversationId, (record) => {
          record.control = { status: "unknown", memberId: member.memberId };
        });
        handled = await this.dependencies.agentManager.runOutOfBand(
          member.backendAgentId,
          "/compact",
          runOptions,
        );
        if (!handled) throw new Error("此模型提供商不支持原生上下文压缩。");
        await completion.promise;
        this.dependencies.store.update(input.conversationId, (record) => {
          record.snapshot.members.find(
            (entry) => entry.memberId === member.memberId,
          )!.lastRequestAt = new Date().toISOString();
          if (record.snapshot.status === "active")
            record.control = { status: "settled", memberId: member.memberId };
        });
        await this.controlNotice(snapshot, "compact", "settled", member.backendAgentId);
      } catch (error) {
        this.dependencies.store.update(input.conversationId, (record) => {
          record.control = {
            status: handled === false ? "settled" : "unknown",
            memberId: member.memberId,
          };
          if (handled !== false) record.snapshot.status = "paused";
        });
        await this.controlNotice(
          snapshot,
          "compact",
          handled === false ? "settled" : "unknown",
          member.backendAgentId,
        );
        throw error;
      } finally {
        completion?.dispose();
        this.authorizedRuns.delete(runOptions);
        this.notifySnapshot(input.conversationId);
      }
    });
    return this.require(input.conversationId).snapshot;
  }
  private observeCompaction(agentId: string) {
    const baseline = this.dependencies.agentManager.fetchTimeline(agentId, {
      direction: "tail",
      limit: 1,
    });
    let complete!: () => void;
    let reject!: (error: Error) => void;
    let loading = false;
    const promise = new Promise<void>((done, fail) => {
      complete = done;
      reject = fail;
    });
    // A provider request can still be awaiting acknowledgement when its event fails.
    void promise.catch(() => undefined);
    const timer = setTimeout(
      () => reject(new Error("原生压缩结果不明，资源仍保留，请核查成员详情。")),
      120_000,
    );
    const unsubscribe = this.dependencies.agentManager.subscribe(
      (event) => {
        if (event.type !== "agent_stream" || event.agentId !== agentId) return;
        if (event.event.type === "turn_failed" || event.event.type === "turn_canceled") {
          reject(new Error("原生压缩中断，结果不明，资源仍保留。"));
          return;
        }
        if (event.event.type !== "timeline" || event.event.item.type !== "compaction") return;
        if (
          event.epoch !== baseline.epoch ||
          event.seq === undefined ||
          event.seq <= (baseline.endSeq ?? 0)
        )
          return;
        const item = event.event.item;
        if (item.trigger === "auto") return;
        if (item.status === "loading") loading = true;
        if (item.status === "completed" && (loading || item.trigger === "manual")) complete();
      },
      { agentId, replayState: false },
    );
    return {
      promise,
      dispose() {
        clearTimeout(timer);
        unsubscribe();
      },
    };
  }
  private async controlNotice(
    snapshot: TaskConversationSnapshot,
    action: "stop" | "stop_member" | "archive" | "compact",
    phase: "before" | "settled" | "unknown",
    backendAgentId?: string,
  ): Promise<void> {
    if (!this.dependencies.plugins.hasBefore(snapshot.ownerPluginId, "task.conversation.control"))
      return;
    try {
      await this.dependencies.plugins.before(
        "task.conversation.control",
        {
          conversationId: snapshot.conversationId,
          workspaceId: snapshot.workspaceId,
          ownerPluginId: snapshot.ownerPluginId,
          action,
          phase,
          backendAgentId,
        },
        { pluginId: snapshot.ownerPluginId },
      );
    } catch (error) {
      this.dependencies.logger.warn(
        { err: error, action, phase },
        "Task control notification failed",
      );
    }
  }

  private onAgentEvent(event: AgentManagerEvent): void {
    let agentId: string | null = null;
    if (event.type === "agent_state") agentId = event.agent.id;
    else if (event.type === "agent_stream") agentId = event.agentId;
    if (!agentId) return;
    if (!isProjectionEvent(event)) return;
    const conversationId = this.dependencies.store.conversationIdForMember(agentId);
    if (!conversationId) return;
    const assistant = event.type === "agent_stream" && event.event.type === "timeline";
    if (assistant && event.epoch && event.seq !== undefined) {
      const sourceKey = `${conversationId}:${agentId}:${event.epoch}`;
      const latest = Math.max(
        this.projectionSourceSeqs.get(sourceKey) ?? -1,
        this.dependencies.store.sourceSequence(conversationId, agentId, event.epoch),
      );
      if (event.seq <= latest) return;
      this.projectionSourceSeqs.set(sourceKey, event.seq);
    }
    let pending = this.pendingProjections.get(conversationId);
    if (!pending) {
      // The native coalescer already emits every 60ms. A shorter window would
      // still commit once per native fragment instead of throttling disk work.
      const timer = setTimeout(() => this.flushProjection(conversationId), 300);
      timer.unref?.();
      pending = { timer, events: [] };
      this.pendingProjections.set(conversationId, pending);
    }
    // Members interleave; merge each member's adjacent message fragments even
    // when other members or state notifications arrive between them.
    const previous = pending.events.findLast(
      (entry) => entry.agentId === agentId && entry.event.type === "agent_stream",
    );
    const merged = assistant && mergeAssistantFragments(previous?.event, event);
    if (previous && merged) previous.event = merged;
    else pending.events.push({ agentId, event });
    if (isTerminalEvent(event)) this.flushProjection(conversationId, agentId);
  }
  private flushProjection(conversationId: string, agentId?: string): void {
    const pending = this.pendingProjections.get(conversationId);
    if (!pending) return;
    const events = agentId
      ? pending.events.filter((entry) => entry.agentId === agentId)
      : pending.events;
    if (!events.length) return;
    if (agentId) pending.events = pending.events.filter((entry) => entry.agentId !== agentId);
    if (!agentId || !pending.events.length) {
      clearTimeout(pending.timer);
      this.pendingProjections.delete(conversationId);
    }
    const previous = this.projectionTails.get(conversationId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.project(conversationId, events));
    this.projectionTails.set(conversationId, next);
    void next.catch((error) => {
      for (const key of this.projectionSourceSeqs.keys())
        if (key.startsWith(`${conversationId}:`)) this.projectionSourceSeqs.delete(key);
      this.dependencies.logger.error(
        { err: error, conversationId },
        "Task public history commit failed",
      );
      try {
        this.dependencies.store.update(conversationId, (record) => {
          record.snapshot.status = "paused";
        });
      } catch {
        /* Preserve the original storage failure. */
      }
    });
  }
  private project(
    conversationId: string,
    events: { agentId: string; event: AgentManagerEvent }[],
  ): void {
    const rows = new Map<string, TaskConversationRow>();
    let snapshot: TaskConversationSnapshot | undefined;
    const terminal = events.some(({ event }) => isTerminalEvent(event));
    this.dependencies.store.update(
      conversationId,
      (record) => {
        for (const { agentId, event } of events) {
          const member = record.snapshot.members.find((entry) => entry.backendAgentId === agentId)!;
          if (event.type === "agent_state") {
            projectMemberState(member, event);
            snapshot = record.snapshot;
            continue;
          }
          if (event.type !== "agent_stream") continue;
          if (event.event.type === "turn_started")
            member.lastRequestAt = event.timestamp ?? new Date().toISOString();
          const sourceTurnId = "turnId" in event.event ? event.event.turnId : undefined;
          const delivery = Object.values(record.deliveries).findLast(
            (candidate) =>
              candidate.backendAgentId === agentId &&
              (candidate.status === "accepted" ||
                candidate.status === "dispatching" ||
                candidate.status === "unknown") &&
              (!sourceTurnId || !candidate.sourceTurnId || candidate.sourceTurnId === sourceTurnId),
          );
          const turnId =
            sourceTurnId ??
            this.dependencies.agentManager.getAgent(agentId)?.activeForegroundTurnId ??
            delivery?.sourceTurnId;
          let row: TaskConversationRow | undefined;
          const sourceKey = assistantSourceKey(member.memberId, turnId, delivery?.deliveryId);
          if (event.event.type === "timeline" && event.event.item.type === "assistant_message") {
            if (turnId)
              row = this.projectAssistant(
                record,
                member,
                turnId,
                sourceKey,
                event.event.item,
                event,
              );
          } else {
            snapshot = record.snapshot;
            if (isTerminalEvent(event)) {
              member.status = event.event.type === "turn_failed" ? "error" : "idle";
              const existing = this.dependencies.store.querySource(record, {
                sourceKey,
              });
              if (existing)
                row = this.dependencies.store.replaceRow(record, existing, { completed: true });
            }
          }
          if (row) rows.set(row.id, row);
        }
      },
      { durability: terminal ? "full" : "normal" },
    );
    if (snapshot) this.notify(conversationId, { conversation: snapshot });
    for (const row of rows.values())
      this.notify(conversationId, { row, eventSeq: row.updatedSeq ?? row.seq });
  }
  private projectAssistant(
    record: StoredTaskConversation,
    member: TaskConversationMember,
    turnId: string,
    sourceKey: string,
    item: { text: string; messageId?: string },
    event: { epoch?: string; seq?: number },
  ): TaskConversationRow | undefined {
    const existing = this.dependencies.store.querySource(record, {
      sourceKey,
    });
    if (existing?.completed) return;
    const source = {
      memberId: member.memberId,
      backendAgentId: member.backendAgentId,
      sourceTurnId: turnId,
      epoch: event.epoch,
      seq: event.seq,
      messageId: item.messageId,
    };
    if (
      event.epoch &&
      event.seq !== undefined &&
      !this.dependencies.store.acceptSourceSequence(
        record,
        member.backendAgentId,
        event.epoch,
        event.seq,
      )
    )
      return;
    if (!existing)
      return this.dependencies.store.append(record, {
        sourceKey,
        kind: "assistant",
        text: item.text,
        speaker: this.speaker(member),
        source,
        completed: false,
      });
    if (
      event.epoch &&
      event.seq !== undefined &&
      existing.source?.epoch === event.epoch &&
      (existing.source.seq ?? -1) >= event.seq
    )
      return;
    return this.dependencies.store.replaceRow(record, existing, {
      text:
        existing.text +
        (item.messageId &&
        existing.source?.messageId &&
        item.messageId !== existing.source.messageId
          ? "\n\n"
          : "") +
        item.text,
      source,
    });
  }
  private async validateAttachments(
    rows: Pick<TaskConversationRow, "attachments">[],
    cwd: string,
  ): Promise<void> {
    for (const row of rows)
      for (const attachment of row.attachments ?? []) {
        if (attachment.type === "uploaded_file")
          await access(
            isAbsolute(attachment.path) ? attachment.path : resolve(cwd, attachment.path),
          );
      }
  }
  private markRejectedMessage(
    record: StoredTaskConversation,
    clientMessageId: string,
  ): TaskConversationRow | undefined {
    const row = this.dependencies.store.queryRows(record, { kind: "user", clientMessageId })[0];
    if (row && !row.text.startsWith("[未投递] "))
      return this.dependencies.store.replaceRow(record, row, { text: `[未投递] ${row.text}` });
  }
  private trackRecovery(conversationId: string, agentId: string): void {
    const members = this.recoveryMembers.get(conversationId) ?? new Set<string>();
    members.add(agentId);
    this.recoveryMembers.set(conversationId, members);
  }
  private reconcile(conversationId: string): Promise<Set<string>> {
    const existing = this.recoveryOperations.get(conversationId);
    if (existing) return existing;
    const members = this.recoveryMembers.get(conversationId);
    if (!members?.size) return Promise.resolve(new Set());
    const operation = (async () => {
      const reconciled = new Set<string>();
      for (const agentId of members) {
        try {
          this.flushProjection(conversationId);
          await this.projectionTails.get(conversationId);
          const stored = await this.dependencies.agentStorage.get(agentId);
          // Missing native identity is explicitly uncertain, never a reason to create a replacement.
          if (!this.dependencies.agentManager.getAgent(agentId) && !stored?.persistence) continue;
          await this.authority.run({ agentId }, () =>
            ensureAgentLoaded(agentId, {
              agentManager: this.dependencies.agentManager,
              agentStorage: this.dependencies.agentStorage,
              logger: this.dependencies.logger,
            }),
          );
          const native = await this.dependencies.agentManager.getTimelineRows(agentId);
          const epoch = this.dependencies.agentManager.fetchTimeline(agentId, { limit: 1 }).epoch;
          // Replay can overlap a buffered stream batch: commit it before comparing prefixes.
          this.flushProjection(conversationId);
          await this.projectionTails.get(conversationId);
          const rows: TaskConversationRow[] = [];
          this.dependencies.store.update(conversationId, (record) => {
            for (const delivery of Object.values(record.deliveries).filter(
              (entry) => entry.backendAgentId === agentId,
            )) {
              const receipt = native.find(
                (row) =>
                  row.item.type === "user_message" &&
                  row.item.clientMessageId === delivery.deliveryId,
              );
              confirmDeliveryReceipt(record, delivery, receipt);
              if (!delivery.sourceTurnId) continue;
              const ambiguousTurn =
                Object.values(record.deliveries).filter(
                  (entry) =>
                    entry.backendAgentId === agentId &&
                    entry.sourceTurnId === delivery.sourceTurnId,
                ).length > 1;
              if (!receipt && ambiguousTurn) continue;
              const nextReceipt =
                receipt &&
                native.find((row) => row.seq > receipt.seq && row.item.type === "user_message");
              const output = native.filter(
                (row) =>
                  row.turnId === delivery.sourceTurnId &&
                  row.item.type === "assistant_message" &&
                  (!receipt || row.seq > receipt.seq) &&
                  (!nextReceipt || row.seq < nextReceipt.seq),
              );
              if (!output.length) continue;
              const text = output
                .map((row) => (row.item.type === "assistant_message" ? row.item.text : ""))
                .join("\n\n");
              const sourceKey = assistantSourceKey(
                delivery.memberId,
                delivery.sourceTurnId,
                delivery.deliveryId,
              );
              const legacy = this.dependencies.store.querySource(record, {
                sourceKey: assistantSourceKey(delivery.memberId, delivery.sourceTurnId),
              });
              const legacyMatchesReceipt = legacyMatchesDelivery(
                legacy,
                epoch,
                receipt,
                nextReceipt,
                ambiguousTurn,
              );
              const indexed = this.dependencies.store.querySource(record, { sourceKey });
              const current = indexed ?? (legacyMatchesReceipt ? legacy : undefined);
              const source = {
                memberId: delivery.memberId,
                backendAgentId: agentId,
                sourceTurnId: delivery.sourceTurnId,
                epoch,
                seq: output.at(-1)!.seq,
              };
              this.dependencies.store.acceptSourceSequence(record, agentId, epoch, source.seq);
              if (current?.completed) continue;
              if (current && text.startsWith(current.text) && current.text !== text)
                rows.push(
                  this.dependencies.store.replaceRow(record, current, {
                    text,
                    source,
                    ...(indexed ? {} : { sourceKey }),
                  }),
                );
              else if (!current) {
                const member = record.snapshot.members.find(
                  (entry) => entry.memberId === delivery.memberId,
                )!;
                rows.push(
                  this.dependencies.store.append(record, {
                    sourceKey,
                    kind: "assistant",
                    text,
                    source,
                    speaker: this.speaker(member),
                    completed: false,
                  }),
                );
              }
            }
          });
          reconciled.add(agentId);
          for (const row of rows)
            this.notify(conversationId, { row, eventSeq: row.updatedSeq ?? row.seq });
          if (
            !Object.values(this.require(conversationId).deliveries).some(
              (delivery) => delivery.backendAgentId === agentId && delivery.status === "unknown",
            )
          )
            members.delete(agentId);
        } catch (error) {
          this.dependencies.logger.warn(
            { err: error, conversationId, agentId },
            "Task member reconciliation failed",
          );
        }
      }
      this.dependencies.store.update(conversationId, (record) => {
        record.recoveryMembers = [...members];
      });
      this.notifySnapshot(conversationId);
      return reconciled;
    })();
    this.recoveryOperations.set(conversationId, operation);
    void operation
      .finally(() => this.recoveryOperations.delete(conversationId))
      .catch(() => undefined);
    return operation;
  }
  private require(conversationId: string): StoredTaskConversation {
    const record = this.dependencies.store.get(conversationId);
    if (!record) throw new Error("Task conversation is missing");
    return record;
  }
  private notifySnapshot(conversationId: string): void {
    this.notify(conversationId, { conversation: this.require(conversationId).snapshot });
  }
  private notify(conversationId: string, update: Update): void {
    for (const listener of this.listeners.get(conversationId) ?? []) {
      try {
        listener(update);
      } catch (error) {
        this.dependencies.logger.warn({ err: error }, "Task subscriber failed");
      }
    }
  }
  async close(): Promise<void> {
    this.unsubscribe();
    await Promise.allSettled(this.recoveryOperations.values());
    for (const conversationId of this.pendingProjections.keys())
      this.flushProjection(conversationId);
    await Promise.allSettled(this.projectionTails.values());
    this.dependencies.store.close();
  }
}
