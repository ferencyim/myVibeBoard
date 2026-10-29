import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compactProviderSnapshot } from "@getpaseo/protocol/provider-snapshot-codec";
import type { CreationSnapshot } from "@getpaseo/protocol/messages";
import { FIRST_MESSAGE_OUTBOX_STORAGE_KEY, FirstMessageOutbox } from "@/composer/outbox/queue";

const host = vi.hoisted(() => {
  const connection = { online: true };
  const runtimeListeners = new Set<() => void>();
  const hostListeners = new Set<() => void>();
  const client = {
    isConnected: true,
    getLastServerInfoMessage: vi.fn(() => ({ features: { creationLifecycle: true } })),
    getWorkspaceCreation: vi.fn<(key: string) => Promise<CreationSnapshot | null>>(),
    createWorkspace: vi.fn(),
    getProvidersSnapshot: vi.fn(),
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
const resolveModel = vi.hoisted(() => vi.fn());
const catalog = vi.hoisted(() => ({ installed: true, resolver: true }));
vi.mock("@/plugins/registry", () => ({
  getFirstMessageModelResolver: () => (catalog.resolver ? resolveModel : null),
  hasInstalledPluginCatalog: () => catalog.installed,
}));
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
  resolveModel.mockReset();
  catalog.installed = true;
  catalog.resolver = true;
  host.client.getProvidersSnapshot.mockReset().mockResolvedValue({ entries: [] });
  host.connection.online = true;
  host.client.isConnected = true;
  host.client.getLastServerInfoMessage.mockReturnValue({ features: { creationLifecycle: true } });
  host.client.getWorkspaceCreation.mockReset().mockResolvedValue(completed);
  host.client.createWorkspace.mockReset();
});

afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
});

describe("首消息 outbox 冷重启自动恢复", () => {
  it.each([true, false])(
    "unconfigured defaults use the first enabled ready provider with its catalog default model (plugin resolver: %s)",
    async (hasResolver) => {
      const { default: storage } = await import("@react-native-async-storage/async-storage");
      await storage.clear();
      const runtime = await import("./first-message-outbox");
      catalog.resolver = hasResolver;
      resolveModel.mockResolvedValue(null);
      host.client.getProvidersSnapshot.mockResolvedValue({
        entries: [
          { provider: "disabled", enabled: false, status: "ready" },
          { provider: "loading", enabled: true, status: "loading" },
          {
            provider: "codex",
            enabled: true,
            status: "ready",
            models: [
              { provider: "codex", id: "other-model", label: "Other" },
              {
                provider: "codex",
                id: "internal-model",
                label: "Internal",
                isDefault: true,
                isSelectable: false,
              },
              { provider: "codex", id: "default-model", label: "Default", isDefault: true },
            ],
          },
        ],
      });
      host.client.createWorkspace.mockImplementation(async (input) => ({
        creation: { ...completed, idempotencyKey: input.idempotencyKey },
      }));
      await runtime.firstMessageOutbox.enqueue({
        id: "default-draft",
        hostId: "host-one",
        projectId: "project-one",
        source: { kind: "worktree", projectId: "project-one", cwd: "/repo" },
        modelSelection: "default",
        text: "离线首消息",
        attachments: [],
      });
      await runtime.flushFirstMessageOutbox();
      expect(host.client.createWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({
          agent: expect.objectContaining({
            config: { provider: "codex", model: "default-model", cwd: "/repo" },
          }),
        }),
      );
    },
  );

  it("expands compact provider snapshots before selecting the fallback provider", async () => {
    const { default: storage } = await import("@react-native-async-storage/async-storage");
    await storage.clear();
    const runtime = await import("./first-message-outbox");
    resolveModel.mockResolvedValue(null);
    host.client.getProvidersSnapshot.mockResolvedValue({
      entries: [],
      snapshotHash: "compact-fallback",
      generatedAt: "2026-01-01T00:00:00Z",
      compactSnapshot: compactProviderSnapshot([
        {
          provider: "codex",
          enabled: true,
          status: "ready",
          models: [
            { provider: "codex", id: "other-model", label: "Other" },
            { provider: "codex", id: "default-model", label: "Default", isDefault: true },
          ],
        },
      ]),
    });
    host.client.createWorkspace.mockImplementation(async (input) => ({
      creation: { ...completed, idempotencyKey: input.idempotencyKey },
    }));
    await runtime.firstMessageOutbox.enqueue({
      id: "default-draft",
      hostId: "host-one",
      projectId: "project-one",
      source: { kind: "worktree", projectId: "project-one", cwd: "/repo" },
      modelSelection: "default",
      text: "离线首消息",
      attachments: [],
    });
    await runtime.flushFirstMessageOutbox();
    expect(host.client.createWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: expect.objectContaining({
          config: { provider: "codex", model: "default-model", cwd: "/repo" },
        }),
      }),
    );
  });

  it("uses the first selectable model when the provider has no marked default", async () => {
    const { default: storage } = await import("@react-native-async-storage/async-storage");
    await storage.clear();
    const runtime = await import("./first-message-outbox");
    resolveModel.mockResolvedValue(null);
    host.client.getProvidersSnapshot.mockResolvedValue({
      entries: [
        {
          provider: "codex",
          enabled: true,
          status: "ready",
          models: [
            { provider: "codex", id: "internal", label: "Internal", isSelectable: false },
            { provider: "codex", id: "available", label: "Available" },
          ],
        },
      ],
    });
    host.client.createWorkspace.mockImplementation(async (input) => ({
      creation: { ...completed, idempotencyKey: input.idempotencyKey },
    }));
    await runtime.firstMessageOutbox.enqueue({
      id: "default-draft",
      hostId: "host-one",
      projectId: "project-one",
      source: { kind: "worktree", projectId: "project-one", cwd: "/repo" },
      modelSelection: "default",
      text: "首消息",
      attachments: [],
    });
    await runtime.flushFirstMessageOutbox();
    expect(host.client.createWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: expect.objectContaining({
          config: { provider: "codex", model: "available", cwd: "/repo" },
        }),
      }),
    );
  });

  it.each([
    { models: [] },
    { models: [{ provider: "codex", id: "internal", label: "Internal", isSelectable: false }] },
  ])(
    "missing selectable fallback models retain the first message and guide to task defaults ($models)",
    async ({ models }) => {
      const { default: storage } = await import("@react-native-async-storage/async-storage");
      await storage.clear();
      const runtime = await import("./first-message-outbox");
      resolveModel.mockResolvedValue(null);
      host.client.getProvidersSnapshot.mockResolvedValue({
        entries: [{ provider: "codex", enabled: true, status: "ready", models }],
      });
      await runtime.firstMessageOutbox.enqueue({
        id: "default-draft",
        hostId: "host-one",
        projectId: "project-one",
        source: { kind: "worktree", projectId: "project-one", cwd: "/repo" },
        modelSelection: "default",
        text: "离线首消息",
        attachments: [],
      });
      await runtime.flushFirstMessageOutbox();
      expect(host.client.createWorkspace).not.toHaveBeenCalled();
      expect(runtime.firstMessageOutbox.getSnapshot()[0]).toMatchObject({
        text: "离线首消息",
        error: expect.stringContaining("任务默认模型"),
      });
    },
  );

  it("waits for a plugin catalog and then a ready provider before automatically sending", async () => {
    const { default: storage } = await import("@react-native-async-storage/async-storage");
    await storage.clear();
    const runtime = await import("./first-message-outbox");
    catalog.installed = false;
    catalog.resolver = false;
    await runtime.firstMessageOutbox.enqueue({
      id: "default-draft",
      hostId: "host-one",
      projectId: "project-one",
      source: { kind: "worktree", projectId: "project-one", cwd: "/repo" },
      modelSelection: "default",
      text: "离线首消息",
      attachments: [],
    });
    await runtime.flushFirstMessageOutbox();
    expect(host.client.getProvidersSnapshot).not.toHaveBeenCalled();
    catalog.installed = true;
    await runtime.flushFirstMessageOutbox();
    expect(runtime.firstMessageOutbox.getSnapshot()[0]).toMatchObject({
      status: "queued",
      submitted: false,
    });
    host.client.getProvidersSnapshot.mockResolvedValue({
      entries: [
        {
          provider: "codex",
          enabled: true,
          status: "ready",
          models: [
            { provider: "codex", id: "other-model", label: "Other" },
            { provider: "codex", id: "default-model", label: "Default", isDefault: true },
          ],
        },
      ],
    });
    host.client.createWorkspace.mockImplementation(async (input) => ({
      creation: { ...completed, idempotencyKey: input.idempotencyKey },
    }));
    await runtime.flushFirstMessageOutbox();
    expect(runtime.firstMessageOutbox.getSnapshot()[0].status).toBe("sent");
  });

  it("flush uses the current project default for a saved default model intent", async () => {
    const { default: storage } = await import("@react-native-async-storage/async-storage");
    await storage.clear();
    const runtime = await import("./first-message-outbox");
    resolveModel.mockResolvedValue({
      provider: "claude",
      model: "current-project-model",
      thinkingOptionId: "high",
    });
    host.client.createWorkspace.mockImplementation(async (input) => ({
      creation: { ...completed, idempotencyKey: input.idempotencyKey },
    }));
    await runtime.firstMessageOutbox.enqueue({
      id: "default-draft",
      hostId: "host-one",
      projectId: "project-one",
      source: { kind: "worktree", projectId: "project-one", cwd: "/repo" },
      modelSelection: "default",
      text: "离线首消息",
      attachments: [],
    });
    await runtime.flushFirstMessageOutbox();
    expect(resolveModel).toHaveBeenCalledExactlyOnceWith({ projectId: "project-one" });
    expect(host.client.createWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: expect.objectContaining({
          config: {
            provider: "claude",
            model: "current-project-model",
            thinkingOptionId: "high",
            cwd: "/repo",
          },
        }),
      }),
    );
  });
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
        result: { workspaceId: "workspace-one", agentId: "agent-one" },
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
        agent: expect.objectContaining({
          clientMessageId: "intent-one:initial-message",
          initialPrompt: "先规划，等待我确认方案。",
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
