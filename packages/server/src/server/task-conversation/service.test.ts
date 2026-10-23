import { tmpdir } from "node:os";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginTaskConversationPrepareRequest } from "@getpaseo/plugin/server";
import type { TaskConversationRecipient } from "@getpaseo/protocol/messages";
import type {
  AgentManager,
  AgentManagerEvent,
  CreateAgentOptions,
} from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type {
  AgentPromptInput,
  AgentRunOptions,
  AgentSessionConfig,
  AgentStreamEvent,
} from "../agent/agent-sdk-types.js";
import type { PluginService } from "../plugins/index.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";
import { TaskConversationService } from "./service.js";
import { TaskConversationStore } from "./store.js";
import { TASK_CONVERSATION_ID_LABEL, TASK_CONVERSATION_MEMBER_ID_LABEL } from "./identity.js";

const services = new Set<TaskConversationService>();

function assistantEvent(
  agentId: string,
  seq: number,
  text: string,
  messageId = "one",
): AgentManagerEvent {
  return {
    type: "agent_stream",
    agentId,
    epoch: "native",
    seq,
    event: { type: "timeline", item: { type: "assistant_message", text, messageId } },
  };
}
const recipient: TaskConversationRecipient = {
  role: "planner",
  config: { provider: "claude", cwd: tmpdir(), model: "cheap-test-model" },
};

function fixture(store = new TaskConversationStore({ filePath: ":memory:" })) {
  const agents = new Map<string, { config: AgentSessionConfig; runtimeInfo: { model?: string } }>();
  const prepareRequests: PluginTaskConversationPrepareRequest[] = [];
  const controls = {
    admitted: true,
    ready: true,
    receiptUnknown: false,
    onPrepare: undefined as ((input: PluginTaskConversationPrepareRequest) => void) | undefined,
    onCreate: undefined as ((config: AgentSessionConfig) => AgentSessionConfig) | undefined,
  };
  let service!: TaskConversationService;
  const manager = {
    subscribe: vi.fn((_listener: (event: AgentManagerEvent) => void) => () => undefined),
    getAgent: vi.fn((agentId: string) => agents.get(agentId)),
    hasInFlightRun: vi.fn((_agentId: string) => false),
    createAgent: vi.fn(
      async (config: AgentSessionConfig, agentId: string, options: CreateAgentOptions) => {
        const actual = controls.onCreate?.(config) ?? config;
        service.assertAgentCreation(agentId, actual, options);
        agents.set(agentId, { config: actual, runtimeInfo: { model: actual.model } });
        return agents.get(agentId);
      },
    ),
    streamAgent: vi.fn((agentId: string, _prompt: AgentPromptInput, options?: AgentRunOptions) => {
      // AgentManager performs this check synchronously before returning its generator.
      service.assertAgentRun(agentId, options);
      const provider = agents.get(agentId)!.config.provider;
      return (async function* (): AsyncGenerator<AgentStreamEvent> {
        if (controls.receiptUnknown) throw new Error("Provider receipt unavailable");
        yield {
          type: "turn_started",
          provider,
          turnId: `turn-${manager.streamAgent.mock.calls.length}`,
        };
      })();
    }),
    replaceAgentRun: vi.fn(
      async (agentId: string, prompt: AgentPromptInput, options?: AgentRunOptions) => {
        service.assertAgentMutation(agentId, "replace");
        return manager.streamAgent(agentId, prompt, options);
      },
    ),
    cancelAgentRun: vi.fn(async (_agentId: string) => ({ status: "canceled" })),
    getTimelineRows: vi.fn(
      async (
        _agentId: string,
      ): Promise<
        Array<{
          turnId?: string;
          seq: number;
          item: { type: string; clientMessageId?: string; text?: string };
        }>
      > => [],
    ),
    fetchTimeline: vi.fn((_agentId: string) => ({ epoch: "native-epoch" })),
  };
  const before = vi.fn(async (name: string, request: unknown) => {
    if (name === "task.conversation.prepare") {
      const input = request as PluginTaskConversationPrepareRequest;
      prepareRequests.push(input);
      controls.onPrepare?.(input);
      return { ...input, ready: controls.ready, config: input.recipient.config };
    }
    if (name === "task.conversation.admit") {
      return { ...(request as object), admitted: controls.admitted, reason: "测试准入拒绝" };
    }
    return request;
  });
  service = new TaskConversationService({
    store,
    agentManager: manager as unknown as AgentManager,
    agentStorage: { get: vi.fn(async () => null) } as unknown as AgentStorage,
    workspaceRegistry: {
      get: async (workspaceId: string) => ({ workspaceId, cwd: tmpdir(), archivedAt: null }),
    } as unknown as Pick<WorkspaceRegistry, "get">,
    plugins: { before, hasBefore: () => false } as unknown as Pick<
      PluginService,
      "before" | "hasBefore"
    >,
    logger: pino({ enabled: false }),
  });
  services.add(service);
  return { service, store, manager, prepareRequests, controls };
}

async function createConversation(service: TaskConversationService) {
  return service.create({
    workspaceId: "workspace",
    ownerPluginId: "test-plugin",
    idempotencyKey: "create",
  });
}

async function* terminalBeforeReceipt(
  store: TaskConversationStore,
  conversationId: string,
): AsyncGenerator<AgentStreamEvent> {
  // A short provider turn can project its terminal state before the send receipt commits.
  store.update(conversationId, (record) => {
    record.snapshot.members[0]!.status = "idle";
  });
  yield { type: "turn_started", provider: "claude", turnId: "already-finished" };
}

afterEach(async () => {
  for (const service of services) {
    await service.close();
    services.delete(service);
  }
});

describe("TaskConversationService", () => {
  it("accepts trusted MCP injection while retaining the admitted member identity", async () => {
    const { service, controls } = fixture();
    controls.onCreate = (config) => ({
      ...config,
      mcpServers: { host: { type: "stdio", command: "host-plugin" } },
    });
    const conversation = await createConversation(service);
    const first = await service.send({
      conversationId: conversation.conversationId,
      recipient,
      clientMessageId: "mcp-one",
      text: "首条",
    });
    const second = await service.send({
      conversationId: conversation.conversationId,
      recipient,
      clientMessageId: "mcp-two",
      text: "继续",
    });
    expect(first.status).toBe("accepted");
    expect(second.backendAgentId).toBe(first.backendAgentId);
    expect(
      service.resolve({ conversationId: conversation.conversationId })!.members[0]!.config
        .mcpServers,
    ).toHaveProperty("host");
  });

  it.each(["Agent not found", "Agent already has an active run", "synchronous failure"])(
    "rejects known pre-provider failures and excludes the marked message from later context: %s",
    async (message) => {
      const { service, manager, prepareRequests } = fixture();
      const conversation = await createConversation(service);
      const pushedText: string[] = [];
      const release = service.subscribe(conversation.conversationId, (update) => {
        if (update.row) pushedText.push(update.row.text);
      });
      manager.streamAgent.mockImplementationOnce(() => {
        throw new Error(message);
      });
      const result = await service.send({
        conversationId: conversation.conversationId,
        recipient,
        clientMessageId: "not-sent",
        text: "不能进入上下文",
      });
      expect(result.status).toBe("rejected");
      expect(pushedText.at(-1)).toBe("[未投递] 不能进入上下文");
      expect(service.fetch({ conversationId: conversation.conversationId }).rows[0]!.text).toBe(
        "[未投递] 不能进入上下文",
      );
      await service.send({
        conversationId: conversation.conversationId,
        recipient,
        clientMessageId: "next",
        text: "可继续",
      });
      expect(prepareRequests[1]!.publicContext).toEqual([]);
      release();
    },
  );

  it("reconciles an unknown in-process member repeatedly and only clears it on explicit stopped rejection", async () => {
    const { service, manager, controls } = fixture();
    const conversation = await createConversation(service);
    controls.receiptUnknown = true;
    const delivery = await service.send({
      conversationId: conversation.conversationId,
      recipient,
      clientMessageId: "unknown",
      text: "等待核对",
    });
    expect(delivery.status).toBe("unknown");
    await service.stop({
      conversationId: conversation.conversationId,
      memberId: delivery.memberId,
    });
    expect(
      service.getDelivery({
        conversationId: conversation.conversationId,
        clientMessageId: "unknown",
      })!.status,
    ).toBe("unknown");
    await expect(
      service.stop({
        conversationId: conversation.conversationId,
        memberId: delivery.memberId,
        reconcileDelivery: { clientMessageId: "unknown", resolution: "accepted" },
      }),
    ).rejects.toThrow("no confirmed provider receipt");
    await service.stop({
      conversationId: conversation.conversationId,
      memberId: delivery.memberId,
      reconcileDelivery: { clientMessageId: "unknown", resolution: "rejected" },
    });
    expect(manager.getTimelineRows).toHaveBeenCalledTimes(3);
    expect(
      service.getDelivery({
        conversationId: conversation.conversationId,
        clientMessageId: "unknown",
      })!.status,
    ).toBe("rejected");
    controls.receiptUnknown = false;
    expect(
      (
        await service.send({
          conversationId: conversation.conversationId,
          recipient,
          clientMessageId: "retry-new",
          text: "确认后新发",
        })
      ).status,
    ).toBe("accepted");
  });

  it("accepts native receipts during explicit member reconciliation without resending", async () => {
    const { service, manager, controls } = fixture();
    const conversation = await createConversation(service);
    await service.publish({
      conversationId: conversation.conversationId,
      sourceKey: "prior-context",
      kind: "artifact",
      text: "此前公开上下文",
    });
    controls.receiptUnknown = true;
    const delivery = await service.send({
      conversationId: conversation.conversationId,
      recipient,
      clientMessageId: "receipt",
      text: "有原始回执",
    });
    manager.getTimelineRows.mockResolvedValue([
      { seq: 1, turnId: "native-turn", item: { type: "user_message", clientMessageId: "receipt" } },
    ]);
    await service.stop({
      conversationId: conversation.conversationId,
      memberId: delivery.memberId,
      reconcileDelivery: { clientMessageId: "receipt", resolution: "accepted" },
    });
    expect(
      service.getDelivery({
        conversationId: conversation.conversationId,
        clientMessageId: "receipt",
      })!.status,
    ).toBe("accepted");
    expect(manager.streamAgent).toHaveBeenCalledTimes(1);
    expect(
      service.resolve({ conversationId: conversation.conversationId })!.members[0]!
        .seenConversationSeq,
    ).toBe(delivery.throughSeq);
    expect(delivery.throughSeq).toBeGreaterThan(0);
  });

  it.each(["active", "paused"] as const)(
    "replaces an existing member run after approval while task is %s",
    async (status) => {
      const { service, manager, store } = fixture();
      const conversation = await createConversation(service);
      const delivery = await service.send({
        conversationId: conversation.conversationId,
        recipient,
        clientMessageId: "approval-initial",
        text: "需要审批",
      });
      store.update(conversation.conversationId, (record) => {
        record.snapshot.status = status;
      });
      manager.hasInFlightRun.mockReturnValue(true);
      await service.continuePermission(delivery.backendAgentId, "批准后接续", "approval");
      expect(manager.replaceAgentRun).toHaveBeenCalledTimes(1);
      expect(
        service.getDelivery({
          conversationId: conversation.conversationId,
          clientMessageId: `permission:${delivery.backendAgentId}:approval`,
        })!.status,
      ).toBe("accepted");
      expect(service.resolve({ conversationId: conversation.conversationId })!.status).toBe(
        "active",
      );
      expect(() =>
        service.assertAgentRun(delivery.backendAgentId, manager.streamAgent.mock.calls[1]![2]),
      ).toThrow("route_required");
    },
  );

  it.each(["delivery", "control"])(
    "blocks approval before loading its provider with unknown %s",
    async (kind) => {
      const { service, store, manager } = fixture();
      const conversation = await createConversation(service);
      const delivery = await service.send({
        conversationId: conversation.conversationId,
        recipient,
        clientMessageId: "approval-unknown",
        text: "等待审批",
      });
      store.update(conversation.conversationId, (record) => {
        if (kind === "delivery") record.deliveries[delivery.clientMessageId]!.status = "unknown";
        else record.control = { status: "unknown" };
      });
      manager.getAgent.mockClear();
      await expect(service.preparePermissionResponse(delivery.backendAgentId)).rejects.toThrow(
        "blocked",
      );
      expect(manager.getAgent).not.toHaveBeenCalled();
    },
  );

  it("does not reconcile idle unused members or reload settled members when tabs reopen", async () => {
    const { service, manager, store } = fixture();
    const conversation = await createConversation(service);
    const one = await service.send({
      conversationId: conversation.conversationId,
      recipient,
      clientMessageId: "used",
      text: "使用过",
    });
    const two = await service.send({
      conversationId: conversation.conversationId,
      recipient: { ...recipient, role: "reviewer" },
      clientMessageId: "unused",
      text: "已完成",
    });
    store.update(conversation.conversationId, (record) => {
      record.snapshot.members[0]!.status = "running";
      record.snapshot.members[1]!.status = "idle";
    });
    const loaded = manager.getAgent(one.backendAgentId);
    manager.getAgent.mockImplementation((id) => (id === two.backendAgentId ? undefined : loaded));
    await service.stop({ conversationId: conversation.conversationId });
    expect(manager.getTimelineRows.mock.calls.map(([id]) => id)).toEqual([one.backendAgentId]);
    manager.getAgent.mockReturnValue(undefined);
    for (let i = 0; i < 3; i++) {
      const release = service.subscribe(conversation.conversationId, () => undefined);
      await Promise.resolve();
      release();
    }
    expect(manager.getTimelineRows).toHaveBeenCalledTimes(1);
  });

  it("recovers prepared deliveries as rejected without starting providers", async () => {
    const original = fixture();
    const conversation = await createConversation(original.service);
    await original.service.send({
      conversationId: conversation.conversationId,
      recipient,
      clientMessageId: "prepared",
      text: "重启前尚未派发",
    });
    original.store.update(conversation.conversationId, (record) => {
      record.deliveries.prepared!.status = "prepared";
      record.snapshot.members[0]!.status = "idle";
    });
    const recovered = fixture(original.store);
    // Both services use this in-memory store; close it once in afterEach.
    services.delete(original.service);
    expect(
      recovered.service.getDelivery({
        conversationId: conversation.conversationId,
        clientMessageId: "prepared",
      })!.status,
    ).toBe("rejected");
    expect(recovered.manager.streamAgent).not.toHaveBeenCalled();
    expect(
      recovered.service.fetch({ conversationId: conversation.conversationId }).rows[0]!.text,
    ).toContain("[未投递]");
  });

  it("preserves a terminal member state projected before dispatch acknowledgement", async () => {
    const { service, manager, store } = fixture();
    const conversation = await createConversation(service);
    manager.streamAgent.mockImplementationOnce((agentId, _prompt, options) => {
      service.assertAgentRun(agentId, options);
      return terminalBeforeReceipt(store, conversation.conversationId);
    });
    expect(
      (
        await service.send({
          conversationId: conversation.conversationId,
          recipient,
          clientMessageId: "fast",
          text: "短回复",
        })
      ).status,
    ).toBe("accepted");
    expect(
      service.resolve({ conversationId: conversation.conversationId })!.members[0]!.status,
    ).toBe("idle");
  });

  it("isolates a failed member reconciliation and continues checking other members", async () => {
    const { service, manager, store } = fixture();
    const conversation = await createConversation(service);
    const one = await service.send({
      conversationId: conversation.conversationId,
      recipient,
      clientMessageId: "recover-one",
      text: "第一成员",
    });
    const two = await service.send({
      conversationId: conversation.conversationId,
      recipient: { ...recipient, role: "worker" },
      clientMessageId: "recover-two",
      text: "第二成员",
    });
    store.update(conversation.conversationId, (record) => {
      record.deliveries[one.clientMessageId]!.status = "unknown";
      record.deliveries[two.clientMessageId]!.status = "unknown";
    });
    manager.getTimelineRows.mockRejectedValueOnce(new Error("单个成员记录损坏"));
    manager.getTimelineRows.mockResolvedValueOnce([
      {
        seq: 1,
        turnId: "recovered-two",
        item: { type: "user_message", clientMessageId: two.clientMessageId },
      },
    ]);
    await service.stop({ conversationId: conversation.conversationId });
    expect(
      service.getDelivery({
        conversationId: conversation.conversationId,
        clientMessageId: one.clientMessageId,
      })!.status,
    ).toBe("unknown");
    expect(
      service.getDelivery({
        conversationId: conversation.conversationId,
        clientMessageId: two.clientMessageId,
      })!.status,
    ).toBe("accepted");
    expect(manager.getTimelineRows).toHaveBeenCalledTimes(2);
  });

  it("keeps archived conversations archived during startup recovery", async () => {
    const original = fixture();
    const conversation = await createConversation(original.service);
    await original.service.send({
      conversationId: conversation.conversationId,
      recipient,
      clientMessageId: "archived",
      text: "已归档",
    });
    original.store.update(conversation.conversationId, (record) => {
      record.snapshot.status = "archived";
      record.snapshot.members[0]!.status = "running";
    });
    const recovered = fixture(original.store);
    services.delete(original.service);
    expect(recovered.service.resolve({ conversationId: conversation.conversationId })!.status).toBe(
      "archived",
    );
    expect(recovered.manager.streamAgent).not.toHaveBeenCalled();
  });

  it("retains a member's older output recovery when its latest unknown delivery is rejected", async () => {
    const { service, manager, store } = fixture();
    const conversation = await createConversation(service);
    const one = await service.send({
      conversationId: conversation.conversationId,
      recipient,
      clientMessageId: "older-accepted",
      text: "旧轮次",
    });
    const two = await service.send({
      conversationId: conversation.conversationId,
      recipient,
      clientMessageId: "latest-unknown",
      text: "新轮次",
    });
    store.update(conversation.conversationId, (record) => {
      record.deliveries[two.clientMessageId]!.status = "unknown";
    });
    manager.getTimelineRows.mockRejectedValueOnce(new Error("原生历史暂时不可用"));
    await service.stop({
      conversationId: conversation.conversationId,
      reconcileDelivery: { clientMessageId: two.clientMessageId, resolution: "rejected" },
    });
    expect(store.get(conversation.conversationId)!.recoveryMembers).toEqual([one.backendAgentId]);
    const turnId = store.get(conversation.conversationId)!.deliveries[one.clientMessageId]!
      .sourceTurnId!;
    manager.getTimelineRows.mockResolvedValue([
      { seq: 1, turnId, item: { type: "assistant_message", text: "旧轮次仍补回" } },
    ]);
    await service.stop({ conversationId: conversation.conversationId });
    expect(service.fetch({ conversationId: conversation.conversationId }).rows.at(-1)?.text).toBe(
      "旧轮次仍补回",
    );
    expect(store.get(conversation.conversationId)!.recoveryMembers).toEqual([]);
  });

  it("retains another member's failed recovery across explicit rejection and restart", async () => {
    const original = fixture();
    const conversation = await createConversation(original.service);
    const one = await original.service.send({
      conversationId: conversation.conversationId,
      recipient,
      clientMessageId: "reject-one",
      text: "第一成员",
    });
    const two = await original.service.send({
      conversationId: conversation.conversationId,
      recipient: { ...recipient, role: "worker" },
      clientMessageId: "recover-other",
      text: "第二成员",
    });
    original.store.update(conversation.conversationId, (record) => {
      record.deliveries[one.clientMessageId]!.status = "unknown";
    });
    original.manager.getTimelineRows.mockImplementation(async (agentId) => {
      if (agentId === two.backendAgentId) throw new Error("暂时无法核对");
      return [];
    });
    await original.service.stop({
      conversationId: conversation.conversationId,
      reconcileDelivery: { clientMessageId: one.clientMessageId, resolution: "rejected" },
    });
    expect(original.store.get(conversation.conversationId)!.recoveryMembers).toEqual([
      two.backendAgentId,
    ]);
    const turnId = original.store.get(conversation.conversationId)!.deliveries[two.clientMessageId]!
      .sourceTurnId!;
    const recovered = fixture(original.store);
    services.delete(original.service);
    recovered.manager.getAgent.mockReturnValue({ config: recipient.config, runtimeInfo: {} });
    recovered.manager.getTimelineRows.mockResolvedValue([
      { seq: 1, turnId, item: { type: "assistant_message", text: "失败后重启补回" } },
    ]);
    await recovered.service.stop({ conversationId: conversation.conversationId });
    expect(recovered.manager.getTimelineRows.mock.calls.map(([id]) => id)).toEqual([
      two.backendAgentId,
    ]);
    expect(
      recovered.service.fetch({ conversationId: conversation.conversationId }).rows.at(-1)?.text,
    ).toBe("失败后重启补回");
    expect(recovered.store.get(conversation.conversationId)!.recoveryMembers).toEqual([]);
  });

  it("recovers accepted native output after a crash before the first projection batch", async () => {
    const original = fixture();
    const conversation = await createConversation(original.service);
    const delivery = await original.service.send({
      conversationId: conversation.conversationId,
      recipient,
      clientMessageId: "before-first-batch",
      text: "首批前崩溃",
    });
    expect(
      original.service.fetch({ conversationId: conversation.conversationId }).rows,
    ).toHaveLength(1);
    const recovered = fixture(original.store);
    services.delete(original.service);
    recovered.manager.getAgent.mockReturnValue({ config: recipient.config, runtimeInfo: {} });
    const turnId = original.store.get(conversation.conversationId)!.deliveries[
      delivery.clientMessageId
    ]!.sourceTurnId!;
    recovered.manager.getTimelineRows.mockResolvedValue([
      { seq: 1, turnId, item: { type: "assistant_message", text: "原生历史完整补回" } },
    ]);
    await recovered.service.stop({ conversationId: conversation.conversationId });
    expect(
      recovered.service.fetch({ conversationId: conversation.conversationId }).rows.at(-1),
    ).toMatchObject({ text: "原生历史完整补回", completed: true });
    expect(recovered.manager.streamAgent).not.toHaveBeenCalled();
  });

  it("closes recovered output after a settled stop and does not pause it on the next startup", async () => {
    const original = fixture();
    const conversation = await createConversation(original.service);
    const delivery = await original.service.send({
      conversationId: conversation.conversationId,
      recipient,
      clientMessageId: "recover-stop",
      text: "崩溃前的请求",
    });
    const sourceTurnId = original.store.get(conversation.conversationId)!.deliveries[
      delivery.clientMessageId
    ]!.sourceTurnId!;
    original.store.update(conversation.conversationId, (record) => {
      record.snapshot.members[0]!.status = "running";
      original.store.append(record, {
        sourceKey: `assistant:${delivery.memberId}:${sourceTurnId}`,
        kind: "assistant",
        text: "部分",
        source: {
          memberId: delivery.memberId,
          backendAgentId: delivery.backendAgentId,
          sourceTurnId,
        },
        completed: false,
      });
    });
    const recovered = fixture(original.store);
    services.delete(original.service);
    recovered.manager.getAgent.mockReturnValue({
      config: recipient.config,
      runtimeInfo: { model: recipient.config.model },
    });
    recovered.manager.getTimelineRows.mockResolvedValue([
      {
        seq: 1,
        turnId: sourceTurnId,
        item: { type: "user_message", clientMessageId: delivery.clientMessageId },
      },
      {
        seq: 2,
        turnId: sourceTurnId,
        item: { type: "assistant_message", text: "部分以及恢复的完整正文" },
      },
    ]);
    const stopped = await recovered.service.stop({
      conversationId: conversation.conversationId,
      memberId: delivery.memberId,
    });
    expect(stopped.members[0]!.status).toBe("idle");
    expect(
      recovered.service
        .fetch({ conversationId: conversation.conversationId })
        .rows.find((row) => row.kind === "assistant"),
    ).toMatchObject({ text: "部分以及恢复的完整正文", completed: true });
    recovered.store.update(conversation.conversationId, (record) => {
      record.snapshot.status = "active";
    });
    const restarted = fixture(recovered.store);
    services.delete(recovered.service);
    expect(restarted.service.resolve({ conversationId: conversation.conversationId })!.status).toBe(
      "active",
    );
    expect(restarted.manager.streamAgent).not.toHaveBeenCalled();
  });

  it("reserves task identity labels while preserving ordinary labels and parent relationships", () => {
    const { service } = fixture();
    for (const label of [TASK_CONVERSATION_ID_LABEL, TASK_CONVERSATION_MEMBER_ID_LABEL]) {
      expect(() => service.assertAgentLabels("ordinary-agent", { [label]: "forged" })).toThrow(
        "task_conversation_reserved_labels",
      );
      expect(() => service.assertAgentLabels("ordinary-agent", { [label]: null })).toThrow(
        "task_conversation_reserved_labels",
      );
      expect(() =>
        service.assertAgentCreation("ordinary-agent", recipient.config, {
          workspaceId: "workspace",
          labels: { [label]: "forged" },
        }),
      ).toThrow("task_conversation_reserved_labels");
    }
    const ordinaryLabels = {
      "ordinary.label": "value",
      "paseo.parent-agent-id": "ordinary-parent",
    };
    expect(() => service.assertAgentLabels("ordinary-agent", ordinaryLabels)).not.toThrow();
    expect(() =>
      service.assertAgentCreation("ordinary-agent", recipient.config, {
        workspaceId: "workspace",
        labels: ordinaryLabels,
      }),
    ).not.toThrow();
  });
  it("keeps equal child configurations distinct and routes later messages to the selected member", async () => {
    const { service, manager } = fixture();
    const conversation = await createConversation(service);
    const parent = await service.send({
      conversationId: conversation.conversationId,
      recipient,
      clientMessageId: "parent",
      text: "主任务",
    });
    const busy = new Set<string>();
    manager.hasInFlightRun.mockImplementation((agentId: string) => busy.has(agentId));
    const childRecipient = { ...recipient, role: "subagent", parentMemberId: parent.memberId };
    const one = await service.send({
      conversationId: conversation.conversationId,
      recipient: { ...childRecipient, memberId: "child-one" },
      clientMessageId: "child-one-initial",
      text: "第一项",
    });
    busy.add(one.backendAgentId);
    const two = await service.send({
      conversationId: conversation.conversationId,
      recipient: { ...childRecipient, memberId: "child-two" },
      clientMessageId: "child-two-initial",
      text: "第二项",
    });
    expect(one.memberId).toBe("child-one");
    expect(two.memberId).toBe("child-two");
    expect(two.backendAgentId).not.toBe(one.backendAgentId);
    busy.add(two.backendAgentId);
    await expect(
      service.send({
        conversationId: conversation.conversationId,
        recipient: { ...childRecipient, memberId: "child-one" },
        clientMessageId: "child-one-busy",
        text: "等当前轮次",
      }),
    ).rejects.toThrow("already running");
    busy.delete(one.backendAgentId);
    const continued = await service.send({
      conversationId: conversation.conversationId,
      recipient: { ...childRecipient, memberId: "child-one" },
      clientMessageId: "child-one-next",
      text: "补充第一项",
    });
    expect(continued.backendAgentId).toBe(one.backendAgentId);
    expect(manager.createAgent).toHaveBeenCalledTimes(3);
    expect(service.resolve({ conversationId: conversation.conversationId })?.members).toHaveLength(
      3,
    );
  });

  it("rejects selected member identities with changed role, parent, configuration or conversation", async () => {
    const { service, manager } = fixture();
    const conversation = await createConversation(service);
    const target = { ...recipient, memberId: "selected-member" };
    await service.send({
      conversationId: conversation.conversationId,
      recipient: target,
      clientMessageId: "selected-initial",
      text: "原配置",
    });
    const changed = [
      { ...target, role: "worker" },
      { ...target, parentMemberId: "different-parent" },
      { ...target, config: { ...target.config, model: "different-model" } },
    ];
    for (const [index, changedRecipient] of changed.entries()) {
      await expect(
        service.send({
          conversationId: conversation.conversationId,
          recipient: changedRecipient,
          clientMessageId: `changed-${index}`,
          text: "不能改已有身份",
        }),
      ).rejects.toThrow(/does not match/);
    }
    const other = await service.create({
      workspaceId: "other-workspace",
      ownerPluginId: "test-plugin",
      idempotencyKey: "other-create",
    });
    await expect(
      service.send({
        conversationId: other.conversationId,
        recipient: target,
        clientMessageId: "wrong-conversation",
        text: "不能误路由",
      }),
    ).rejects.toThrow("another conversation");
    expect(manager.createAgent).toHaveBeenCalledTimes(1);
    expect(manager.streamAgent).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["provider", (config: AgentSessionConfig) => ({ ...config, provider: "codex" })],
    ["model", (config: AgentSessionConfig) => ({ ...config, model: "different" })],
    ["mode", (config: AgentSessionConfig) => ({ ...config, modeId: "bypassPermissions" })],
    ["features", (config: AgentSessionConfig) => ({ ...config, featureValues: { write: true } })],
    [
      "tools",
      (config: AgentSessionConfig) => ({
        ...config,
        toolPolicy: {
          preapproved: [{ kind: "mcp" as const, server: "unexpected", tool: "write" }],
        },
      }),
    ],
  ])("rejects ordinary creation hooks changing admitted %s", async (_name, transform) => {
    const { service, manager, controls } = fixture();
    const conversation = await createConversation(service);
    controls.onCreate = transform;
    const result = await service.send({
      conversationId: conversation.conversationId,
      recipient,
      clientMessageId: "sensitive",
      text: "讨论",
    });
    expect(result.status).toBe("rejected");
    expect(result.error).toContain("sensitive configuration changed");
    expect(manager.streamAgent).not.toHaveBeenCalled();
  });

  it("persists ordinary system context injection without changing the prepared configuration identity", async () => {
    const { service, manager, controls, store } = fixture();
    const conversation = await createConversation(service);
    controls.onCreate = (config) => ({ ...config, systemPrompt: "项目公开上下文" });
    const first = await service.send({
      conversationId: conversation.conversationId,
      recipient,
      clientMessageId: "system-one",
      text: "首条",
    });
    expect(first.status).toBe("accepted");
    const stored = store.get(conversation.conversationId)!;
    expect(stored.snapshot.members[0]?.config.systemPrompt).toBe("项目公开上下文");
    expect(stored.memberConfigs[first.memberId]?.preparedConfig).not.toHaveProperty("internal");
    const second = await service.send({
      conversationId: conversation.conversationId,
      recipient,
      clientMessageId: "system-two",
      text: "继续",
    });
    expect(second.backendAgentId).toBe(first.backendAgentId);
    const selected = await service.send({
      conversationId: conversation.conversationId,
      recipient: {
        ...recipient,
        memberId: first.memberId,
        config: stored.snapshot.members[0]!.config,
      },
      clientMessageId: "system-selected",
      text: "指定已有成员",
    });
    expect(selected.backendAgentId).toBe(first.backendAgentId);
    expect(manager.createAgent).toHaveBeenCalledTimes(1);
  });
  it("creates members only on admitted handover and reuses the same effective member", async () => {
    const { service, manager } = fixture();
    const conversation = await createConversation(service);
    expect(conversation.members).toEqual([]);
    expect(manager.createAgent).not.toHaveBeenCalled();
    const first = await service.send({
      conversationId: conversation.conversationId,
      recipient,
      clientMessageId: "one",
      text: "开始规划",
    });
    const next = await service.send({
      conversationId: conversation.conversationId,
      recipient,
      clientMessageId: "two",
      text: "补充要求",
    });
    expect(first.status).toBe("accepted");
    expect(next.memberId).toBe(first.memberId);
    expect(manager.createAgent).toHaveBeenCalledTimes(1);
    const worker = await service.send({
      conversationId: conversation.conversationId,
      recipient: {
        role: "worker",
        config: { provider: "codex", cwd: tmpdir(), model: "other-cheap-model" },
      },
      clientMessageId: "three",
      text: "接着讨论",
    });
    expect(worker.status).toBe("accepted");
    expect(worker.backendAgentId).not.toBe(first.backendAgentId);
    expect(service.resolve({ conversationId: conversation.conversationId })?.members).toHaveLength(
      2,
    );
    expect(manager.createAgent).toHaveBeenCalledTimes(2);
    expect(service.resolve({ conversationId: conversation.conversationId })?.anchorAgentId).toBe(
      first.backendAgentId,
    );
  });

  it("does not create a provider, human row, or receipt when preparation or admission rejects", async () => {
    const { service, manager, controls } = fixture();
    const conversation = await createConversation(service);
    const input = {
      conversationId: conversation.conversationId,
      recipient,
      clientMessageId: "blocked",
      text: "等待准入",
    };
    controls.ready = false;
    await expect(service.send(input)).rejects.toThrow("preparation");
    controls.ready = true;
    controls.admitted = false;
    await expect(service.send(input)).rejects.toThrow("测试准入拒绝");
    expect(service.getDelivery(input)).toBeNull();
    expect(service.fetch({ conversationId: conversation.conversationId }).rows).toEqual([]);
    expect(manager.createAgent).not.toHaveBeenCalled();
    expect(manager.streamAgent).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent human submissions and durable source publications, including prototype-like IDs", async () => {
    const { service, manager, store } = fixture();
    const conversation = await createConversation(service);
    const input = {
      conversationId: conversation.conversationId,
      recipient,
      clientMessageId: "__proto__",
      text: "只发送一次",
    };
    const [first, duplicate] = await Promise.all([service.send(input), service.send(input)]);
    expect(duplicate).toEqual(first);
    expect(first.status).toBe("accepted");
    const privateReceipt = store.get(conversation.conversationId)!.deliveries[
      input.clientMessageId
    ]!;
    expect(privateReceipt).toHaveProperty("requestFingerprint");
    expect(privateReceipt).not.toHaveProperty("prompt");
    expect(privateReceipt).toHaveProperty("sourceTurnId");
    const retry = await service.send(input);
    for (const response of [first, duplicate, retry, service.getDelivery(input)]) {
      expect(response).not.toHaveProperty("requestFingerprint");
      expect(response).not.toHaveProperty("prompt");
      expect(response).not.toHaveProperty("sourceTurnId");
    }
    expect(service.getDelivery(input)?.clientMessageId).toBe("__proto__");
    expect(manager.streamAgent).toHaveBeenCalledTimes(1);
    await expect(service.send({ ...input, text: "不能复用同ID改正文" })).rejects.toThrow(
      "task_message_id_conflict",
    );
    const source = {
      conversationId: conversation.conversationId,
      sourceKey: "artifact:stable",
      kind: "artifact" as const,
      text: "保留结论",
    };
    const published = await service.publish(source);
    expect(await service.publish({ ...source, text: "不能覆盖" })).toEqual(published);
    expect(
      service.querySource({
        conversationId: conversation.conversationId,
        sourceKey: source.sourceKey,
      })?.text,
    ).toBe("保留结论");
    expect(service.fetch({ conversationId: conversation.conversationId }).rows).toHaveLength(2);
  });

  it("advances the member context only through the fixed pre-send boundary", async () => {
    const { service, store, controls, prepareRequests } = fixture();
    const conversation = await createConversation(service);
    controls.onPrepare = (input) => {
      store.update(input.conversationId, (record) => {
        store.append(record, {
          sourceKey: "concurrent-artifact",
          kind: "artifact",
          text: "准备期间新增结论",
        });
      });
    };
    const first = await service.send({
      conversationId: conversation.conversationId,
      recipient,
      clientMessageId: "one",
      text: "首条消息",
    });
    expect(first.throughSeq).toBe(0);
    expect(
      service.resolve({ conversationId: conversation.conversationId })?.members[0]
        ?.seenConversationSeq,
    ).toBe(0);
    expect(
      service.resolve({ conversationId: conversation.conversationId })?.members[0]?.lastRequestAt,
    ).toEqual(expect.any(String));
    controls.onPrepare = undefined;
    const second = await service.send({
      conversationId: conversation.conversationId,
      recipient,
      clientMessageId: "two",
      text: "下一条",
    });
    expect(second.throughSeq).toBe(2);
    expect(prepareRequests[1]?.publicContext.map((row) => row.text)).toEqual(["准备期间新增结论"]);
    expect(
      service.resolve({ conversationId: conversation.conversationId })?.members[0]
        ?.seenConversationSeq,
    ).toBe(2);
  });

  it("retains unknown receipts, pauses, and refuses both automatic retry and replacement writers", async () => {
    const { service, manager, controls } = fixture();
    const conversation = await createConversation(service);
    controls.receiptUnknown = true;
    const input = {
      conversationId: conversation.conversationId,
      recipient,
      clientMessageId: "uncertain",
      text: "结果不明",
    };
    const unknown = await service.send(input);
    expect(unknown.status).toBe("unknown");
    expect(service.resolve({ conversationId: conversation.conversationId })?.status).toBe("paused");
    expect(await service.send(input)).toEqual(unknown);
    await expect(service.send({ ...input, clientMessageId: "replacement" })).rejects.toThrow(
      "unknown delivery",
    );
    expect(manager.streamAgent).toHaveBeenCalledTimes(1);
    expect(manager.createAgent).toHaveBeenCalledTimes(1);
  });

  it("routes managed members through admission while ordinary agents retain their native entry", async () => {
    const { service, manager } = fixture();
    const conversation = await createConversation(service);
    const accepted = await service.send({
      conversationId: conversation.conversationId,
      recipient,
      clientMessageId: "message",
      text: "受管发送",
    });
    expect(() => service.assertAgentRun(accepted.backendAgentId)).toThrow(
      "task_conversation_route_required",
    );
    const options = manager.streamAgent.mock.calls[0]![2];
    expect(() => service.assertAgentRun(accepted.backendAgentId, options)).toThrow(
      "task_conversation_route_required",
    );
    expect(() => service.assertAgentRun("ordinary-agent")).not.toThrow();
    expect(() => service.assertAgentMutation(accepted.backendAgentId, "detach")).toThrow(
      "task_conversation_control_required",
    );
    expect(() =>
      service.assertAgentLabels(accepted.backendAgentId, { "paseo.parent-agent-id": "other" }),
    ).toThrow("task_conversation_control_required");
  });
});

describe("TaskConversationService streaming durability", () => {
  it("coalesces fragments, separates messages and pushes only durable changed rows", async () => {
    vi.useFakeTimers();
    try {
      const { service, store, manager } = fixture();
      const conversation = await createConversation(service);
      const delivery = await service.send({
        conversationId: conversation.conversationId,
        recipient,
        clientMessageId: "stream",
        text: "长流",
      });
      const updates: { conversation?: unknown; row?: { text: string; completed?: boolean } }[] = [];
      const release = service.subscribe(conversation.conversationId, (update) =>
        updates.push(update),
      );
      const emit = manager.subscribe.mock.calls[0]![0];
      const write = vi.spyOn(store, "update");
      for (let seq = 1; seq <= 100; seq++) emit(assistantEvent(delivery.backendAgentId, seq, "字"));
      emit(assistantEvent(delivery.backendAgentId, 100, "重复不得显示"));
      expect(write).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(300);
      expect(write).toHaveBeenCalledTimes(1);
      expect(updates.filter((update) => update.row)).toHaveLength(1);
      const changed = updates.find((update) => update.row)!;
      expect(changed.conversation).toBeUndefined();
      expect(changed.row?.text).toBe("字".repeat(100));
      expect(service.fetch({ conversationId: conversation.conversationId }).rows.at(-1)?.text).toBe(
        "字".repeat(100),
      );
      emit(assistantEvent(delivery.backendAgentId, 1, "旧回放"));
      emit(assistantEvent(delivery.backendAgentId, 101, "下一段", "two"));
      emit({
        type: "agent_stream",
        agentId: delivery.backendAgentId,
        event: { type: "turn_completed", provider: "claude", turnId: "turn-1" },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(
        service.fetch({ conversationId: conversation.conversationId }).rows.at(-1),
      ).toMatchObject({ text: "字".repeat(100) + "\n\n下一段", completed: true });
      expect(
        Object.keys(store.get(conversation.conversationId)!.sources).filter((key) =>
          key.startsWith("fragment:"),
        ),
      ).toEqual([]);
      release();
    } finally {
      vi.useRealTimers();
    }
  });

  it("throttles interleaved native-rate members in one transaction without unrelated flushes", async () => {
    vi.useFakeTimers();
    try {
      const { service, store, manager } = fixture();
      const conversation = await createConversation(service);
      const deliveries = [];
      for (const role of ["planner", "worker", "reviewer"])
        deliveries.push(
          await service.send({
            conversationId: conversation.conversationId,
            recipient: { ...recipient, role },
            clientMessageId: role,
            text: role,
          }),
        );
      await vi.advanceTimersByTimeAsync(0);
      const emit = manager.subscribe.mock.calls[0]![0];
      const write = vi.spyOn(store, "update");
      for (let tick = 1; tick <= 10; tick++) {
        for (const delivery of deliveries) {
          emit(assistantEvent(delivery.backendAgentId, tick, "字"));
          emit({
            type: "agent_stream",
            agentId: delivery.backendAgentId,
            event: { type: "timeline", item: { type: "user_message", text: "ignored" } },
          } as AgentManagerEvent);
          emit({
            type: "agent_state",
            agent: {
              ...manager.getAgent(delivery.backendAgentId),
              id: delivery.backendAgentId,
              lifecycle: "running",
              pendingPermissions: new Map(),
            },
          } as unknown as AgentManagerEvent);
        }
        await vi.advanceTimersByTimeAsync(60);
      }
      expect(write).toHaveBeenCalledTimes(2);
      const rows = service
        .fetch({ conversationId: conversation.conversationId })
        .rows.filter((row) => row.kind === "assistant");
      expect(rows.map((row) => row.text)).toEqual([
        "字".repeat(10),
        "字".repeat(10),
        "字".repeat(10),
      ]);
      for (const delivery of deliveries) emit(assistantEvent(delivery.backendAgentId, 11, "尾"));
      emit({
        type: "agent_stream",
        agentId: deliveries[0]!.backendAgentId,
        event: { type: "turn_completed", provider: "claude", turnId: "turn-1" },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(write).toHaveBeenCalledTimes(3);
      expect(
        service
          .fetch({ conversationId: conversation.conversationId })
          .rows.filter((row) => row.kind === "assistant")
          .map((row) => row.text),
      ).toEqual(["字".repeat(10) + "尾", "字".repeat(10), "字".repeat(10)]);
      await vi.advanceTimersByTimeAsync(300);
      expect(write).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes queued chunks on close and skips ordinary events without loading history", async () => {
    const { service, store, manager } = fixture();
    const conversation = await createConversation(service);
    const delivery = await service.send({
      conversationId: conversation.conversationId,
      recipient,
      clientMessageId: "stream-close",
      text: "流",
    });
    const emit = manager.subscribe.mock.calls[0]![0];
    const find = vi.spyOn(store, "find");
    for (let seq = 0; seq < 100; seq++) emit(assistantEvent(`ordinary-${seq}`, seq, "普通"));
    expect(find).not.toHaveBeenCalled();
    emit(assistantEvent(delivery.backendAgentId, 1, "关闭前正文"));
    const published: string[] = [];
    const release = service.subscribe(conversation.conversationId, (update) => {
      if (update.row) published.push(update.row.text);
    });
    await service.close();
    services.delete(service);
    expect(published).toEqual(["关闭前正文"]);
    release();
  });
});

describe("Task conversation recovery boundaries", () => {
  it("does not duplicate overlapping buffered chunks during native reconciliation", async () => {
    vi.useFakeTimers();
    try {
      const { service, manager, controls, store } = fixture();
      const conversation = await createConversation(service);
      controls.receiptUnknown = true;
      const delivery = await service.send({
        conversationId: conversation.conversationId,
        recipient,
        clientMessageId: "overlap",
        text: "核对输出",
      });
      Object.assign(manager.getAgent(delivery.backendAgentId)!, {
        activeForegroundTurnId: "native-turn",
      });
      manager.fetchTimeline.mockReturnValue({ epoch: "native" });
      const emit = manager.subscribe.mock.calls[0]![0];
      emit(assistantEvent(delivery.backendAgentId, 1, "A"));
      await vi.advanceTimersByTimeAsync(300);
      manager.getTimelineRows.mockImplementationOnce(async () => {
        emit(assistantEvent(delivery.backendAgentId, 2, "B"));
        emit(assistantEvent(delivery.backendAgentId, 3, "C"));
        return [
          {
            seq: 0,
            turnId: "native-turn",
            item: { type: "user_message", clientMessageId: "overlap" },
          },
          { seq: 2, turnId: "native-turn", item: { type: "assistant_message", text: "AB" } },
        ];
      });
      const release = service.subscribe(conversation.conversationId, () => undefined);
      await vi.advanceTimersByTimeAsync(300);
      expect(
        store.querySource(conversation.conversationId, {
          sourceKey: `assistant:${delivery.memberId}:native-turn`,
        })?.text,
      ).toBe("ABC");
      emit(assistantEvent(delivery.backendAgentId, 2, "B"));
      emit(assistantEvent(delivery.backendAgentId, 4, "D"));
      await vi.advanceTimersByTimeAsync(300);
      expect(
        store.querySource(conversation.conversationId, {
          sourceKey: `assistant:${delivery.memberId}:native-turn`,
        })?.text,
      ).toBe("ABCD");
      release();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps indexed ownership guards when damaged metadata cannot be loaded", async () => {
    const { service, manager, store } = fixture();
    const conversation = await createConversation(service);
    const delivery = await service.send({
      conversationId: conversation.conversationId,
      recipient,
      clientMessageId: "ownership",
      text: "成员",
    });
    vi.spyOn(store, "find").mockReturnValue(null);
    expect(() => service.assertAgentRun(delivery.backendAgentId)).toThrow("route_required");
    expect(() => service.assertAgentMutation(delivery.backendAgentId, "stop")).toThrow(
      "control_required",
    );
    expect(() =>
      service.assertAgentCreation(delivery.backendAgentId, recipient.config, {}),
    ).toThrow("admission_required");
    expect(() =>
      service.assertAgentLabels(delivery.backendAgentId, { "paseo.parent-agent-id": "forged" }),
    ).toThrow("control_required");
    expect(manager.streamAgent).toHaveBeenCalledTimes(1);
  });
});

describe("Task conversation shutdown recovery", () => {
  it("waits for in-flight native reconciliation before closing its durable store", async () => {
    const { service, manager, controls, store } = fixture();
    const conversation = await createConversation(service);
    controls.receiptUnknown = true;
    await service.send({
      conversationId: conversation.conversationId,
      recipient,
      clientMessageId: "closing-recovery",
      text: "核对后关闭",
    });
    let finish!: () => void;
    manager.getTimelineRows.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve([]);
        }),
    );
    const release = service.subscribe(conversation.conversationId, () => undefined);
    await vi.waitFor(() => expect(manager.getTimelineRows).toHaveBeenCalledTimes(1));
    const close = vi.spyOn(store, "close");
    const closing = service.close();
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();
    finish();
    await closing;
    expect(close).toHaveBeenCalledTimes(1);
    services.delete(service);
    release();
  });
});

it("keeps original durable plan approval visible while its member closes and resumes", async () => {
  const { service, store, manager } = fixture();
  const conversation = await createConversation(service);
  const delivery = await service.send({
    conversationId: conversation.conversationId,
    recipient,
    clientMessageId: "durable-plan",
    text: "计划",
  });
  const plan = {
    id: "original-plan-request",
    provider: "codex",
    name: "CodexPlanApproval",
    kind: "plan" as const,
    input: { plan: "只输出标记" },
  };
  store.update(conversation.conversationId, (record) => {
    record.snapshot.status = "paused";
    record.snapshot.members[0]!.pendingPermissions = [plan];
  });
  const emit = manager.subscribe.mock.calls[0]![0];
  for (const lifecycle of ["closed", "initializing"] as const) {
    emit({
      type: "agent_state",
      agent: {
        ...manager.getAgent(delivery.backendAgentId),
        id: delivery.backendAgentId,
        lifecycle,
        pendingPermissions: new Map(),
      },
    } as unknown as AgentManagerEvent);
    await vi.waitFor(() =>
      expect(
        service.resolve({ conversationId: conversation.conversationId })!.members[0]!.status,
      ).toBe(lifecycle),
    );
    expect(
      service.resolve({ conversationId: conversation.conversationId })!.members[0]!
        .pendingPermissions,
    ).toEqual([plan]);
  }
  await expect(service.preparePermissionResponse(delivery.backendAgentId)).resolves.toBeUndefined();
  expect(manager.streamAgent).toHaveBeenCalledTimes(1);
});
