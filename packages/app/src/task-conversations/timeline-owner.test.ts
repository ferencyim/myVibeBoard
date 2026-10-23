import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  TaskConversationPage,
  TaskConversationRow,
  SessionOutboundMessage,
  TaskConversationSnapshot,
} from "@getpaseo/protocol/messages";
import { observeTaskConversationTimeline } from "./timeline-owner";
import { taskConversationKey, useTaskConversationStore } from "./store";
import { createTaskConversationNavigation, useTaskConversationNavigationStore } from "./navigation";
import { taskConversationHasLiveCache } from "@/composer/task-conversation-selection";

vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({
    readTaskConversationReplica: async () => undefined,
    commitTaskConversationReplica: () => {},
  }),
}));

type Owned = ReturnType<DaemonClient["observeTaskConversation"]>;
type Observer = Parameters<Owned["subscribe"]>[0];
type Snapshot = Parameters<Observer["snapshot"]>[0];

function row(seq: number, updatedSeq = seq): TaskConversationRow {
  return {
    id: `row-${seq}`,
    sourceKey: `source-${seq}`,
    seq,
    updatedSeq,
    epoch: "epoch",
    kind: "assistant",
    text: `消息${updatedSeq}`,
    createdAt: "2026-10-23T12:00:00Z",
  };
}
function page(
  rows: TaskConversationRow[],
  first: number,
  last: number,
  hasNewer = false,
): TaskConversationPage {
  return {
    conversationId: "conversation",
    rows,
    epoch: "epoch",
    startCursor: { epoch: "epoch", seq: first },
    endCursor: { epoch: "epoch", seq: last },
    sourceSeqRanges: [{ start: first, end: last }],
    hasOlder: false,
    hasNewer,
  };
}

function testClient() {
  const observers = new Set<Observer>();
  const initial: Snapshot = {
    requestId: "request",
    error: null,
    subscriptionId: "sub",
    conversation: null,
    page: page([row(1)], 1, 1),
  };
  const release = vi.fn(async () => {});
  const owned: Owned = {
    subscriptionId: "sub",
    ready: Promise.resolve(initial),
    release,
    subscribe(observer) {
      observers.add(observer);
      observer.snapshot(initial);
      return () => observers.delete(observer);
    },
  };
  const fetchTaskConversation = vi.fn<DaemonClient["fetchTaskConversation"]>();
  const client = {
    isConnected: true,
    observeTaskConversation: vi.fn(() => owned),
    fetchTaskConversation,
    subscribeConnectionStatus: vi.fn<DaemonClient["subscribeConnectionStatus"]>(() => () => {}),
  };
  return {
    client,
    fetchTaskConversation,
    release,
    snapshot(snapshot: Snapshot) {
      for (const observer of observers) observer.snapshot(snapshot);
    },
    update(message: SessionOutboundMessage) {
      for (const observer of observers) observer.update(message);
    },
  };
}

beforeEach(() =>
  useTaskConversationStore.setState({ conversations: new Map(), timelines: new Map() }),
);

describe("task conversation timeline owner", () => {
  it("preserves history on an empty same-epoch resubscription page but clears a new epoch", async () => {
    const test = testClient();
    const release = observeTaskConversationTimeline(test.client, "resize-host", "conversation");
    await vi.waitFor(() => expect(test.client.observeTaskConversation).toHaveBeenCalledOnce());
    test.snapshot({
      requestId: "resize",
      error: null,
      subscriptionId: "sub-resize",
      conversation: null,
      page: { ...page([], 0, 0), startCursor: null, endCursor: null },
    });
    const current = () =>
      useTaskConversationStore
        .getState()
        .timelines.get(taskConversationKey("resize-host", "conversation"));
    expect(current()?.rows.map((item) => item.id)).toEqual(["row-1"]);
    expect(current()?.endSeq).toBe(1);
    expect(current()?.sync).toBe("ready");
    test.snapshot({
      requestId: "new-epoch",
      error: null,
      subscriptionId: "sub-epoch",
      conversation: null,
      page: { ...page([], 0, 0), epoch: "new-epoch", startCursor: null, endCursor: null },
    });
    expect(current()?.rows).toEqual([]);
    expect(current()?.epoch).toBe("new-epoch");
    release();
  });
  it("waits for hello when mounted during restart and recovers synchronous subscription failure", async () => {
    const test = testClient();
    test.client.isConnected = false;
    let connectionChanged: Parameters<DaemonClient["subscribeConnectionStatus"]>[0] = () => {};
    test.client.subscribeConnectionStatus.mockImplementation((listener) => {
      connectionChanged = listener;
      listener({ status: "connecting", attempt: 0 });
      return () => {};
    });
    const release = observeTaskConversationTimeline(test.client, "restart-host", "conversation");
    await vi.waitFor(() => expect(test.client.subscribeConnectionStatus).toHaveBeenCalledOnce());
    await Promise.resolve();
    await Promise.resolve();
    expect(test.client.observeTaskConversation).not.toHaveBeenCalled();
    expect(
      useTaskConversationStore
        .getState()
        .timelines.get(taskConversationKey("restart-host", "conversation"))?.sync,
    ).toBe("reconnecting");

    test.client.observeTaskConversation.mockImplementationOnce(() => {
      throw new Error("Subscription unavailable during restart");
    });
    test.client.isConnected = true;
    expect(() => connectionChanged({ status: "connected" })).not.toThrow();
    await vi.waitFor(() =>
      expect(
        useTaskConversationStore
          .getState()
          .timelines.get(taskConversationKey("restart-host", "conversation"))?.sync,
      ).toBe("error"),
    );
    test.client.isConnected = false;
    connectionChanged({ status: "disconnected" });
    test.client.isConnected = true;
    connectionChanged({ status: "connected" });
    await vi.waitFor(() => expect(test.client.observeTaskConversation).toHaveBeenCalledTimes(2));
    expect(
      useTaskConversationStore
        .getState()
        .timelines.get(taskConversationKey("restart-host", "conversation"))?.sync,
    ).toBe("ready");
    release();
    expect(test.release).toHaveBeenCalledOnce();
  });
  it("shares one owned subscription and pages every gap through the event watermark", async () => {
    const test = testClient();
    test.fetchTaskConversation
      .mockResolvedValueOnce({
        requestId: "r",
        error: null,
        page: page([row(2), row(1, 3)], 2, 3, true),
      })
      .mockResolvedValueOnce({ requestId: "r", error: null, page: page([row(4), row(5)], 4, 5) });
    const first = observeTaskConversationTimeline(test.client, "host", "conversation");
    const second = observeTaskConversationTimeline(test.client, "host", "conversation");
    await vi.waitFor(() => expect(test.client.observeTaskConversation).toHaveBeenCalledTimes(1));
    test.update({
      type: "task.conversation.update",
      payload: { subscriptionId: "sub", conversationId: "conversation", eventSeq: 5, row: row(5) },
    });
    await vi.waitFor(() =>
      expect(
        useTaskConversationStore
          .getState()
          .timelines.get(taskConversationKey("host", "conversation"))?.endSeq,
      ).toBe(5),
    );
    expect(test.fetchTaskConversation.mock.calls.map(([request]) => request.cursor?.seq)).toEqual([
      1, 3,
    ]);
    expect(
      useTaskConversationStore.getState().timelines.get(taskConversationKey("host", "conversation"))
        ?.rows[0].text,
    ).toBe("消息3");
    first();
    expect(test.release).not.toHaveBeenCalled();
    second();
    expect(test.release).toHaveBeenCalledTimes(1);
  });
  it("reconciles reconnect snapshots without duplicating rows or shrinking the covered tail", async () => {
    const test = testClient();
    const release = observeTaskConversationTimeline(test.client, "host", "conversation");
    await vi.waitFor(() => expect(test.client.observeTaskConversation).toHaveBeenCalledTimes(1));
    test.update({
      type: "task.conversation.update",
      payload: { subscriptionId: "sub", conversationId: "conversation", eventSeq: 2, row: row(2) },
    });
    test.snapshot({
      requestId: "reconnected",
      error: null,
      subscriptionId: "sub2",
      conversation: null,
      page: page([row(1)], 1, 1),
    });
    const state = useTaskConversationStore
      .getState()
      .timelines.get(taskConversationKey("host", "conversation"));
    expect(state?.endSeq).toBe(2);
    expect(state?.rows.map((item) => item.id)).toEqual(["row-1", "row-2"]);
    release();
  });
});

describe("plugin task conversation navigation", () => {
  function fixture() {
    const conversation: TaskConversationSnapshot = {
      conversationId: "conversation",
      workspaceId: "workspace",
      anchorAgentId: "agent",
      ownerPluginId: "owner",
      status: "active",
      epoch: "epoch",
      lastSeq: 3,
      createdAt: "2026-10-23T12:00:00Z",
      updatedAt: "2026-10-23T12:00:00Z",
      members: [
        {
          memberId: "worker",
          backendAgentId: "agent",
          role: "worker",
          config: { provider: "codex", model: "cheap", cwd: "/repo" },
          seenConversationSeq: 0,
          status: "idle",
          lastRequestAt: "2026-10-23T12:00:00Z",
        },
      ],
    };
    useTaskConversationStore.getState().setConversation("host", conversation);
    useTaskConversationStore
      .getState()
      .applyPage("host", { ...page([row(3)], 3, 3), hasOlder: true }, "tail");
    const client = {
      queryTaskConversationSource: vi.fn<DaemonClient["queryTaskConversationSource"]>(async () => ({
        requestId: "q",
        error: null,
        row: row(1),
      })),
      fetchTaskConversation: vi.fn<DaemonClient["fetchTaskConversation"]>(async () => ({
        requestId: "f",
        error: null,
        page: page([row(1), row(2)], 1, 2),
      })),
    };
    const controller = new AbortController();
    const input = {
      serverId: "host",
      pluginId: "owner",
      signal: controller.signal,
      getClient: () => client,
      hasWorkspace: (id: string) => id === "workspace",
    };
    return { client, controller, input, navigation: createTaskConversationNavigation(input) };
  }

  it("loads earlier public rows before locating the source inside its conversation", async () => {
    const test = fixture();
    await test.navigation.openTaskConversationSource({
      conversationId: "conversation",
      sourceKey: "source-1",
    });
    expect(test.client.fetchTaskConversation).toHaveBeenCalledWith({
      conversationId: "conversation",
      direction: "before",
      cursor: { epoch: "epoch", seq: 3 },
      limit: 100,
    });
    expect(
      useTaskConversationNavigationStore
        .getState()
        .targets.get(taskConversationKey("host", "conversation")),
    ).toEqual({ kind: "source", messageId: "row-1" });
  });

  it("expands an existing member without creating an agent tab", async () => {
    const test = fixture();
    await test.navigation.openTaskConversationMember({
      conversationId: "conversation",
      memberId: "worker",
    });
    expect(
      useTaskConversationNavigationStore
        .getState()
        .targets.get(taskConversationKey("host", "conversation")),
    ).toEqual({ kind: "member", details: { memberId: "worker", backendAgentId: "agent" } });
    expect(test.client.fetchTaskConversation).not.toHaveBeenCalled();
    await expect(
      test.navigation.openTaskConversationMember({
        conversationId: "conversation",
        memberId: "foreign",
      }),
    ).rejects.toThrow("成员不属于");
  });

  it("rejects mismatched source identity and revokes a pending request on plugin unload", async () => {
    const test = fixture();
    await expect(
      test.navigation.openTaskConversationSource({
        conversationId: "conversation",
        sourceKey: "foreign-source",
      }),
    ).rejects.toThrow("来源与请求不一致");
    test.client.queryTaskConversationSource.mockImplementationOnce(async () => {
      test.controller.abort();
      return { requestId: "q", error: null, row: row(1) };
    });
    await expect(
      test.navigation.openTaskConversationSource({
        conversationId: "conversation",
        sourceKey: "source-1",
      }),
    ).rejects.toThrow();
    expect(test.client.fetchTaskConversation).not.toHaveBeenCalled();
  });

  it("rejects another host, workspace, owner and unloaded plugin before reading sources", async () => {
    const test = fixture();
    const target = { conversationId: "conversation", sourceKey: "source-1" };
    await expect(
      createTaskConversationNavigation({
        ...test.input,
        serverId: "other",
      }).openTaskConversationSource(target),
    ).rejects.toThrow("当前宿主");
    await expect(
      createTaskConversationNavigation({
        ...test.input,
        hasWorkspace: () => false,
      }).openTaskConversationSource(target),
    ).rejects.toThrow("工作区");
    await expect(
      createTaskConversationNavigation({
        ...test.input,
        pluginId: "other",
      }).openTaskConversationSource(target),
    ).rejects.toThrow("另一个插件");
    test.controller.abort();
    await expect(test.navigation.openTaskConversationSource(target)).rejects.toThrow();
    expect(test.client.queryTaskConversationSource).not.toHaveBeenCalled();
  });

  it("does not misattribute a manual model change's prompt cache", () => {
    const recipient = {
      role: "worker",
      presetId: "cheap",
      config: { provider: "codex" as const, model: "cheap", cwd: "/repo" },
    };
    const options = [{ id: "worker", label: "执行", recipient, cacheExpiresAt: 2000 }];
    expect(taskConversationHasLiveCache(options, recipient, 1000)).toBe(true);
    expect(taskConversationHasLiveCache(options, recipient, 2000)).toBe(false);
    expect(
      taskConversationHasLiveCache(
        options,
        { ...recipient, config: { ...recipient.config, model: "other" } },
        1000,
      ),
    ).toBe(false);
  });
});
