import { tmpdir } from "node:os";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginTaskConversationPrepareRequest } from "@getpaseo/plugin/server";
import type { TaskConversationRecipient } from "@getpaseo/protocol/messages";
import type { AgentManager, CreateAgentOptions } from "../agent/agent-manager.js";
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
const recipient: TaskConversationRecipient = {
  role: "planner",
  config: { provider: "claude", cwd: tmpdir(), model: "cheap-test-model" },
};

function fixture() {
  const store = new TaskConversationStore({ filePath: ":memory:" });
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
    subscribe: vi.fn(() => () => undefined),
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

afterEach(async () => {
  for (const service of services) {
    await service.close();
    services.delete(service);
  }
});

describe("TaskConversationService", () => {
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
    [
      "mcp",
      (config: AgentSessionConfig): AgentSessionConfig => ({
        ...config,
        mcpServers: { unexpected: { type: "stdio", command: "unexpected" } },
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
    expect(privateReceipt).toHaveProperty("prompt");
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
