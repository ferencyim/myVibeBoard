import { afterEach, describe, expect, it, vi } from "vitest";
import { registerTaskRecipients } from "../client/task-conversation/recipients";
import { TaskConversationPanelSchema } from "../shared/task-conversation";

function harness() {
  let id: string | null = "directory";
  let observer: { snapshot(value: unknown): void; update(value: unknown): void };
  const agent = {
    id: "planner-agent",
    workspaceId: "workspace",
    taskConversationId: "conversation",
  };
  const initial = { entries: [{ agent }], pageInfo: { nextCursor: null, hasMore: false } };
  const release = vi.fn(async () => {});
  const subscription = {
    get subscriptionId() {
      return id;
    },
    ready: Promise.resolve(initial),
    subscribe: vi.fn((next) => {
      observer = next;
      next.snapshot(initial);
      return vi.fn();
    }),
    release,
  };
  let snapshot = TaskConversationPanelSchema.parse({
    task: {
      workspaceId: "workspace",
      anchorAgentId: "planner-agent",
      phase: "planning",
      plan: null,
      confirmedAt: null,
      rolesSnapshot: null,
      subtaskRuns: [],
      summary: "",
    },
    blockers: [],
    artifacts: [],
    subtasks: [],
    conversationStatus: "active",
    members: [
      {
        memberId: "planner",
        backendAgentId: "planner-agent",
        role: "planner",
        presetId: "preset",
        provider: "codex",
        model: "cheap",
        lastRequestAt: "2026-10-23T12:00:00Z",
        status: "idle",
      },
    ],
    recipients: ["planner", "worker"].map((role) => ({
      id: role,
      role,
      label: role,
      recipient: {
        role,
        presetId: "preset",
        config: { provider: "codex", model: "cheap", cwd: "/task" },
      },
    })),
    suggestedRecipientId: "planner",
    cache: { ttlSecondsByProvider: { codex: 300 }, fallbackTtlSeconds: 60, autoCompact: true },
  });
  const rpc = vi.fn(async () => snapshot);
  const list = vi.fn(async () => ({ ...initial, subscription }));
  const setRecipients = vi.fn();
  const client = {
    paseo: { agents: { list } },
    rpc,
    setTaskConversationRecipients: setRecipients,
  } as unknown as Parameters<typeof registerTaskRecipients>[0];
  return {
    client,
    list,
    rpc,
    release,
    setRecipients,
    agent,
    snapshot,
    disconnect() {
      id = null;
    },
    reconnect() {
      id = "restored";
      observer.snapshot(initial);
    },
    update(next: typeof agent) {
      observer.update({ type: "agent_update", payload: { kind: "upsert", agent: next } });
    },
  };
}

async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
afterEach(() => vi.useRealTimers());

describe("后台任务接手选项生命周期", () => {
  it("不用打开面板也注册已有和新增任务，刷新保留手选且仅阶段变化才建议接手者", async () => {
    vi.useFakeTimers();
    const h = harness();
    const cleanup = registerTaskRecipients(h.client);
    await flush();
    expect(h.setRecipients).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "conversation", selectedRecipientId: "planner" }),
    );
    expect(h.setRecipients.mock.calls[0]![0].recipients[0].cacheExpiresAt).toBe(
      Date.parse("2026-10-23T12:00:00Z") + 300000,
    );
    await vi.advanceTimersByTimeAsync(4000);
    expect(h.setRecipients.mock.lastCall![0]).not.toHaveProperty("selectedRecipientId");
    h.snapshot.task!.phase = "executing";
    h.snapshot.suggestedRecipientId = "worker";
    await vi.advanceTimersByTimeAsync(4000);
    expect(h.setRecipients.mock.lastCall![0].selectedRecipientId).toBe("worker");
    h.update({
      id: "second",
      workspaceId: "other-workspace",
      taskConversationId: "other-conversation",
    });
    await flush();
    expect(h.setRecipients).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "other-conversation" }),
    );
    await cleanup();
  });

  it("断线停止后台RPC，重连恢复；清理中止订阅和定时器", async () => {
    vi.useFakeTimers();
    const h = harness();
    const cleanup = registerTaskRecipients(h.client);
    await flush();
    const before = h.rpc.mock.calls.length;
    h.disconnect();
    await vi.advanceTimersByTimeAsync(12000);
    expect(h.rpc).toHaveBeenCalledTimes(before);
    h.reconnect();
    await flush();
    expect(h.rpc.mock.calls.length).toBeGreaterThan(before);
    await cleanup();
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.list.mock.calls[0]![0].signal.aborted).toBe(true);
    const cleaned = h.rpc.mock.calls.length;
    await vi.advanceTimersByTimeAsync(12000);
    expect(h.rpc).toHaveBeenCalledTimes(cleaned);
  });

  it("归档后清除接手选项并停止轮询，不因已结束请求晚回而重注册", async () => {
    vi.useFakeTimers();
    const h = harness();
    const cleanup = registerTaskRecipients(h.client);
    await flush();
    h.snapshot.conversationStatus = "archived";
    await vi.advanceTimersByTimeAsync(4000);
    expect(h.setRecipients.mock.lastCall![0].recipients).toEqual([]);
    const archived = h.rpc.mock.calls.length;
    h.update(h.agent);
    await vi.advanceTimersByTimeAsync(8000);
    expect(h.rpc).toHaveBeenCalledTimes(archived);
    await cleanup();
  });

  it("清理后忽略在途RPC结果，不把选项写回已卸载插件", async () => {
    vi.useFakeTimers();
    const h = harness();
    let finish: (value: typeof h.snapshot) => void = () => {};
    h.rpc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const cleanup = registerTaskRecipients(h.client);
    await flush();
    await cleanup();
    finish(h.snapshot);
    await flush();
    expect(h.setRecipients).not.toHaveBeenCalled();
  });
});
