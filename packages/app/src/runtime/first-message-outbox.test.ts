import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreationSnapshot } from "@getpaseo/protocol/messages";
import { FIRST_MESSAGE_OUTBOX_STORAGE_KEY, FirstMessageOutbox } from "@/composer/outbox/queue";

const host = vi.hoisted(() => {
  const connection = { online: true };
  const runtimeListeners = new Set<() => void>();
  const hostListeners = new Set<() => void>();
  const client = {
    isConnected: true,
    getLastServerInfoMessage: vi.fn(() => ({
      features: { creationLifecycle: true, taskConversations: true },
    })),
    getWorkspaceCreation: vi.fn<(key: string) => Promise<CreationSnapshot | null>>(),
    createWorkspace: vi.fn(),
  };
  return {
    connection,
    client,
    runtimeListeners,
    hostListeners,
    store: {
      getHosts: () => [{ serverId: "host-one" }],
      getSnapshot: () => ({ connectionStatus: connection.online ? "online" : "offline", client }),
      acceptWorkspaceSnapshots: vi.fn(),
      subscribeAll: (listener: () => void) => {
        runtimeListeners.add(listener);
        return () => runtimeListeners.delete(listener);
      },
      subscribeHostList: (listener: () => void) => {
        hostListeners.add(listener);
        return () => hostListeners.delete(listener);
      },
    },
  };
});

// Exercise the real durable queue and startup loop without native attachment or host bootstrapping.
vi.mock("expo-crypto", () => ({ randomUUID: () => "unused-new-intent" }));
vi.mock("@/runtime/host-runtime", () => ({ getHostRuntimeStore: () => host.store }));
vi.mock("@/composer/outbox/attachments", () => ({
  prepareOutboxAttachments: vi.fn(async () => ({})),
}));
vi.mock("@/stores/session-store", () => ({ normalizeWorkspaceDescriptor: vi.fn() }));

const completed: CreationSnapshot = {
  kind: "workspace",
  idempotencyKey: "intent-one",
  phase: "completed",
  revision: 2,
  workspaceId: "workspace-one",
  agentId: "agent-one",
  conversationId: "conversation-one",
  memberId: "planner-one",
  error: null,
};

async function restart(status: "sending" | "unknown" = "sending") {
  const { default: storage } = await import("@react-native-async-storage/async-storage");
  await storage.clear();
  const previous = new FirstMessageOutbox({ storage, requestId: () => "intent-one" });
  const entry = await previous.enqueue({
    id: "draft-one",
    hostId: "host-one",
    projectId: "project-one",
    source: { kind: "worktree", projectId: "project-one", cwd: "/repo" },
    owner: { pluginId: "vibe-board", initialRole: "planner" },
    config: { provider: "codex", cwd: "/repo", model: "planning-model" },
    text: "先规划，等待我确认方案。",
    attachments: [],
  });
  await storage.setItem(
    FIRST_MESSAGE_OUTBOX_STORAGE_KEY,
    JSON.stringify({ version: 1, entries: [{ ...entry, status, submitted: true }] }),
  );
  const runtime = await import("./first-message-outbox");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  return { storage, runtime };
}

let stop: (() => void) | undefined;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  host.connection.online = true;
  host.client.isConnected = true;
  host.client.getLastServerInfoMessage.mockReturnValue({
    features: { creationLifecycle: true, taskConversations: true },
  });
  host.client.getWorkspaceCreation.mockReset().mockResolvedValue(completed);
  host.client.createWorkspace.mockReset();
});

afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
});

describe("首消息 outbox 冷重启自动恢复", () => {
  it.each(["sending", "unknown"] as const)(
    "启动自动查询持久化的 %s 并保存成功结果，不重新创建",
    async (status) => {
      const { runtime, storage } = await restart(status);
      stop = runtime.startFirstMessageOutbox();
      await runtime.flushFirstMessageOutbox();
      expect(host.client.getWorkspaceCreation).toHaveBeenCalledWith("intent-one");
      expect(host.client.createWorkspace).not.toHaveBeenCalled();
      expect(runtime.firstMessageOutbox.getSnapshot()[0]).toMatchObject({
        status: "sent",
        result: {
          workspaceId: "workspace-one",
          agentId: "agent-one",
          conversationId: "conversation-one",
          memberId: "planner-one",
        },
      });
      expect(
        JSON.parse((await storage.getItem(FIRST_MESSAGE_OUTBOX_STORAGE_KEY))!).entries[0].status,
      ).toBe("sent");
      const queries = host.client.getWorkspaceCreation.mock.calls.length;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(host.client.getWorkspaceCreation).toHaveBeenCalledTimes(queries);
    },
  );

  it("主机仍在创建时自动轮询到完成，重复连接事件不重复创建", async () => {
    const { runtime } = await restart();
    host.client.getWorkspaceCreation.mockResolvedValue({
      ...completed,
      phase: "agent_ready",
      revision: 1,
    });
    stop = runtime.startFirstMessageOutbox();
    await runtime.flushFirstMessageOutbox();
    expect(runtime.firstMessageOutbox.getSnapshot()[0].status).toBe("unknown");
    host.client.getWorkspaceCreation.mockResolvedValue(completed);
    for (const listener of host.runtimeListeners) listener();
    for (const listener of host.hostListeners) listener();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runtime.firstMessageOutbox.getSnapshot()[0].status).toBe("sent");
    expect(host.client.createWorkspace).not.toHaveBeenCalled();
  });

  it("查询返回 null 才用原幂等键和 clientMessageId 恢复首发", async () => {
    const { runtime } = await restart();
    host.client.getWorkspaceCreation.mockResolvedValue(null);
    host.client.createWorkspace.mockResolvedValue({
      creation: completed,
      workspace: null,
      error: null,
    });
    stop = runtime.startFirstMessageOutbox();
    await runtime.flushFirstMessageOutbox();
    expect(host.client.getWorkspaceCreation).toHaveBeenCalledWith("intent-one");
    expect(host.client.createWorkspace).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        idempotencyKey: "intent-one",
        requestId: "intent-one",
        taskConversation: expect.objectContaining({
          ownerPluginId: "vibe-board",
          initialRecipient: expect.objectContaining({ role: "planner" }),
          initialMessage: expect.objectContaining({
            clientMessageId: "intent-one:initial-message",
            text: "先规划，等待我确认方案。",
          }),
        }),
      }),
    );
    expect(runtime.firstMessageOutbox.getSnapshot()[0].status).toBe("sent");
  });

  it("查询异常保留结果未知和正文，稍后自动查询成功，不盲目重建", async () => {
    const { runtime } = await restart();
    host.client.getWorkspaceCreation.mockRejectedValue(new Error("连接中断"));
    stop = runtime.startFirstMessageOutbox();
    await runtime.flushFirstMessageOutbox();
    expect(runtime.firstMessageOutbox.getSnapshot()[0]).toMatchObject({
      status: "unknown",
      text: "先规划，等待我确认方案。",
      error: "无法核对上次发送结果，内容已保留：连接中断",
    });
    expect(host.client.createWorkspace).not.toHaveBeenCalled();
    host.client.getWorkspaceCreation.mockResolvedValue(completed);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runtime.firstMessageOutbox.getSnapshot()[0].status).toBe("sent");
    expect(host.client.createWorkspace).not.toHaveBeenCalled();
  });

  it("离线启动先保留，联网事件自动查询；停止后不再轮询或监听", async () => {
    const { runtime } = await restart();
    host.connection.online = false;
    host.client.isConnected = false;
    stop = runtime.startFirstMessageOutbox();
    await runtime.flushFirstMessageOutbox();
    expect(host.client.getWorkspaceCreation).not.toHaveBeenCalled();
    expect(runtime.firstMessageOutbox.getSnapshot()[0].status).toBe("unknown");
    host.connection.online = true;
    host.client.isConnected = true;
    for (const listener of host.runtimeListeners) listener();
    await runtime.flushFirstMessageOutbox();
    expect(runtime.firstMessageOutbox.getSnapshot()[0].status).toBe("sent");
    expect(host.client.createWorkspace).not.toHaveBeenCalled();
    stop();
    stop = undefined;
    expect(host.runtimeListeners.size).toBe(0);
    expect(host.hostListeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

it("宿主缺少任务群聊能力时不创建普通 agent，保留首消息并提示升级", async () => {
  const { runtime } = await restart();
  await runtime.firstMessageOutbox.enqueue({
    id: "new-draft",
    owner: { pluginId: "vibe-board", initialRole: "planner" },
    hostId: "host-one",
    projectId: "project-one",
    source: { kind: "worktree", projectId: "project-one", cwd: "/repo" },
    config: { provider: "codex", cwd: "/repo" },
    text: "离线正文",
    attachments: [],
  });
  host.client.getLastServerInfoMessage.mockReturnValue({
    features: { creationLifecycle: true, taskConversations: false },
  });
  await runtime.flushFirstMessageOutbox();
  expect(host.client.createWorkspace).not.toHaveBeenCalled();
  expect(host.client.getWorkspaceCreation).not.toHaveBeenCalled();
  expect(
    runtime.firstMessageOutbox.getSnapshot().find((entry) => entry.id === "new-draft"),
  ).toMatchObject({
    status: "failed",
    text: "离线正文",
    submitted: false,
    error: expect.stringContaining("升级"),
  });
});

it("停用任务插件后，即使旧任务尚未发出，缺群聊能力的主机仍能创建普通 agent", async () => {
  const { runtime } = await restart();
  await runtime.firstMessageOutbox.enqueue({
    id: "ordinary-draft",
    hostId: "host-one",
    projectId: "project-one",
    source: { kind: "directory", projectId: "project-one", path: "/repo" },
    config: { provider: "codex", cwd: "/repo" },
    text: "普通新会话",
    attachments: [],
  });
  host.client.getLastServerInfoMessage.mockReturnValue({
    features: { creationLifecycle: true, taskConversations: false },
  });
  host.client.createWorkspace.mockResolvedValue({
    creation: {
      ...completed,
      idempotencyKey: "unused-new-intent",
      conversationId: undefined,
      memberId: undefined,
    },
    workspace: null,
    error: null,
  });
  await runtime.flushFirstMessageOutbox();
  expect(host.client.createWorkspace).toHaveBeenCalledOnce();
  expect(host.client.createWorkspace.mock.calls[0][0].taskConversation).toBeUndefined();
  expect(
    runtime.firstMessageOutbox.getSnapshot().find((entry) => entry.id === "ordinary-draft")?.status,
  ).toBe("sent");
});
