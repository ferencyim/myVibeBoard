import pino from "pino";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { CLIENT_CAPS } from "@getpaseo/protocol/client-capabilities";
import type {
  CreationSnapshot,
  SessionInboundMessage,
  SessionOutboundMessage,
  TaskConversationPage,
  TaskConversationRow,
  TaskConversationSnapshot,
  WorkspaceDescriptorPayload,
} from "@getpaseo/protocol/messages";
import { CreationService, type CreationInput } from "./creation/index.js";
import { Session } from "./session.js";
import { OWNER_PERMISSIONS, SessionAuthorization } from "./authorization/index.js";
import { SessionDelivery } from "./session/owned-subscriptions/index.js";
import { asInternals, createStub } from "./test-utils/class-mocks.js";
import { createPluginClientId } from "./plugins/plugin-session-identity.js";
import type { TaskConversationService } from "./task-conversation/service.js";

const logger = pino({ level: "silent" });
const workspace: WorkspaceDescriptorPayload = {
  id: "wks_0123456789abcdef",
  projectId: "project",
  projectDisplayName: "Project",
  projectRootPath: "/project",
  workspaceDirectory: "/project/worktree",
  projectKind: "git",
  workspaceKind: "worktree",
  name: "Worktree",
  status: "running",
  statusEnteredAt: null,
  activityAt: null,
  archivingAt: null,
  scripts: [],
};
const conversation: TaskConversationSnapshot = {
  conversationId: "conversation",
  workspaceId: workspace.id,
  anchorAgentId: null,
  ownerPluginId: "test-owner",
  status: "active",
  epoch: "epoch",
  lastSeq: 0,
  members: [],
  createdAt: "2026-10-23T00:00:00Z",
  updatedAt: "2026-10-23T00:00:00Z",
};
const bound: TaskConversationSnapshot = {
  ...conversation,
  anchorAgentId: "backend",
  members: [
    {
      memberId: "member",
      backendAgentId: "backend",
      role: "planner",
      config: { provider: "codex", cwd: "/project/worktree" },
      seenConversationSeq: 0,
      lastRequestAt: null,
      status: "idle",
    },
  ],
};
const page: TaskConversationPage = {
  conversationId: conversation.conversationId,
  epoch: conversation.epoch,
  rows: [],
  startCursor: null,
  endCursor: null,
  hasOlder: false,
  hasNewer: false,
  sourceSeqRanges: [],
};
const row: TaskConversationRow = {
  id: "row",
  epoch: "epoch",
  seq: 1,
  sourceKey: "test-artifact",
  kind: "artifact",
  text: "公开产物",
  createdAt: conversation.createdAt,
};

async function journalFixture() {
  const root =
    process.env.PASEO_TEST_HOME ?? join(process.cwd(), ".dev", "task-conversation-tests");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "journal-"));
  const service = new CreationService(directory, logger);
  const input: CreationInput = {
    kind: "workspace",
    key: "first-message",
    request: { taskConversation: { idempotencyKey: "container", ownerPluginId: "test-owner" } },
    workspaceId: workspace.id,
    hasAgent: false,
    hasPrompt: true,
    exists: async () => false,
    provision: async () => ({ workspace }),
  };
  return { directory, service, input };
}

test("creation commits the container and first member before the initial dispatch and returns the same receipt after restart", async () => {
  const f = await journalFixture();
  let dispatches = 0;
  const updates: CreationSnapshot[] = [];
  f.input.createConversation = async (_workspace, onReady) => {
    await onReady(conversation);
    expect(
      (await f.service.subscribe("workspace", f.input.key, () => {})).snapshot?.conversationId,
    ).toBe(conversation.conversationId);
    await onReady(bound);
    const observation = await f.service.subscribe("workspace", f.input.key, () => {});
    expect(observation.snapshot).toMatchObject({
      conversationId: "conversation",
      memberId: "member",
      agentId: "backend",
    });
    observation.unsubscribe();
    dispatches++;
    return { conversation: bound };
  };
  const result = await f.service.create(f.input, (snapshot) => updates.push(snapshot));
  expect(result).toMatchObject({
    phase: "completed",
    conversationId: "conversation",
    memberId: "member",
    agentId: "backend",
  });
  expect(updates.findIndex((snapshot) => snapshot.memberId === "member")).toBeLessThan(
    updates.findIndex((snapshot) => snapshot.phase === "prompt_started"),
  );
  expect(await new CreationService(f.directory, logger).create(f.input)).toEqual(result);
  expect(dispatches).toBe(1);
});

test("unknown initial delivery preserves its conversation milestone and never repeats the dispatch", async () => {
  const f = await journalFixture();
  const createConversation = vi.fn(
    async (
      _workspace: WorkspaceDescriptorPayload | undefined,
      onReady: (snapshot: TaskConversationSnapshot) => Promise<void>,
    ) => {
      await onReady(bound);
      throw new Error("provider acknowledgement lost");
    },
  );
  f.input.createConversation = createConversation;
  const first = await f.service.create(f.input);
  expect(first).toMatchObject({
    phase: "failed",
    outcomeUnknown: true,
    failedStage: "prompt",
    conversationId: "conversation",
    memberId: "member",
  });
  expect(await new CreationService(f.directory, logger).create(f.input)).toEqual(first);
  expect(createConversation).toHaveBeenCalledTimes(1);
});

test("ordinary workspace creation retains its existing completed receipt", async () => {
  const f = await journalFixture();
  const provision = vi.fn(async () => ({ workspace }));
  const input = { ...f.input, hasPrompt: false, request: { ordinary: true }, provision };
  const completed = await f.service.create(input);
  expect(completed).toMatchObject({ phase: "completed", workspace });
  expect(completed.conversationId).toBeUndefined();
  expect(await new CreationService(f.directory, logger).create(input)).toEqual(completed);
  expect(provision).toHaveBeenCalledTimes(1);
});

type Update = Parameters<Parameters<TaskConversationService["subscribe"]>[1]>[0];
interface Internals {
  handleTaskConversationMessage(request: SessionInboundMessage, source?: object): Promise<void>;
  handleRequest(request: SessionInboundMessage, source?: object): Promise<void>;
  handleCancelAgentRequest(agentId: string, requestId: string): Promise<void>;
  archiveAgentForClose(agentId: string): Promise<{ agentId: string; archivedAt: string }>;
  handleDeleteAgentRequest(agentId: string, requestId: string): Promise<void>;
  taskConversationMessageAllowed(message: SessionOutboundMessage, source?: object): boolean;
}
function transportFixture(clientId = "client") {
  const messages: Array<{ source: object; message: SessionOutboundMessage }> = [];
  const listeners = new Set<(update: Update) => void>();
  const subscribe = vi.fn((_id: string, listener: (update: Update) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  const create = vi.fn<TaskConversationService["create"]>(async () => conversation);
  const send = vi.fn<TaskConversationService["send"]>(async () => ({
    deliveryId: "message",
    conversationId: "conversation",
    clientMessageId: "message",
    status: "accepted" as const,
    memberId: "member",
    backendAgentId: "backend",
    throughSeq: 0,
    error: null,
  }));
  const publish = vi.fn<TaskConversationService["publish"]>(async () => row);
  const stop = vi.fn<TaskConversationService["stop"]>(async () => ({ ...bound, status: "paused" }));
  const archive = vi.fn<TaskConversationService["archive"]>(async () => ({
    ...bound,
    status: "archived",
    archivedAt: "2026-10-23T02:00:00Z",
  }));
  const service = createStub<TaskConversationService>({
    create,
    send,
    publish,
    stop,
    archive,
    resolve: () => conversation,
    fetch: () => page,
    subscribe,
    getByAgentId: (id: string) => (id === "backend" ? bound : null),
  });
  const session = asInternals<Session>(Object.create(Session.prototype));
  const source = {};
  const other = {};
  const legacy = {};
  const delivery = new SessionDelivery((target, message) =>
    messages.push({ source: target, message }),
  );
  Object.assign(session, {
    delivery,
    taskConversations: service,
    agentManager: { getAgent: () => null },
    clientId,
    clientCapabilities: new Set(),
    clientSources: new Map([
      [source, { capabilities: new Set([CLIENT_CAPS.taskConversations]) }],
      [other, { capabilities: new Set([CLIENT_CAPS.taskConversations]) }],
      [legacy, { capabilities: new Set() }],
    ]),
    authorization: new SessionAuthorization(OWNER_PERMISSIONS),
    sessionLogger: logger,
    inflightRequests: 0,
    peakInflightRequests: 0,
    emitSubscribedEvent: () => true,
    dispatchInboundMessage: vi.fn(async () => {}),
    onMessageToSource: (target: object, message: SessionOutboundMessage) =>
      messages.push({ source: target, message }),
  });
  const internals = asInternals<Internals>(session);
  for (const target of [source, other, legacy]) delivery.attach(target, true);
  const request = (message: SessionInboundMessage, target = source) =>
    delivery.request(target, message, () =>
      internals.handleTaskConversationMessage(message, target),
    );
  return {
    session,
    service,
    source,
    other,
    legacy,
    delivery,
    request,
    internals,
    messages,
    listeners,
    create,
    send,
    publish,
    subscribe,
    stop,
    archive,
  };
}

test("task RPCs require capability and omit transport identity from creation and delivery fingerprints", async () => {
  const f = transportFixture();
  const input = {
    type: "task.conversation.create.request" as const,
    requestId: "one",
    workspaceId: workspace.id,
    idempotencyKey: "key",
    ownerPluginId: "test-owner",
  };
  await expect(f.request(input, f.legacy)).rejects.toThrow("升级");
  expect(f.create).not.toHaveBeenCalled();
  await f.request(input);
  await f.request({ ...input, requestId: "retry" });
  expect(f.create.mock.calls.map((args) => args[0])).toEqual([
    { workspaceId: workspace.id, idempotencyKey: "key", ownerPluginId: "test-owner" },
    { workspaceId: workspace.id, idempotencyKey: "key", ownerPluginId: "test-owner" },
  ]);
  await f.request({
    type: "task.conversation.send.request",
    requestId: "send",
    conversationId: "conversation",
    recipient: bound.members[0],
    clientMessageId: "message",
    text: "请接手",
  });
  expect(f.send.mock.calls[0][0]).not.toHaveProperty("requestId");
  expect(f.send.mock.calls[0][0]).not.toHaveProperty("type");
});

test("conversation subscriptions belong to their source and release on detach before reconnect", async () => {
  const f = transportFixture();
  await f.request({
    type: "task.conversation.subscribe.request",
    requestId: "subscribe",
    conversationId: "conversation",
  });
  const response = f.messages.find(
    (entry) => entry.message.type === "task.conversation.subscribe.response",
  )?.message;
  if (response?.type !== "task.conversation.subscribe.response")
    throw new Error("Missing subscribe response");
  expect(f.listeners.size).toBe(1);
  for (const listener of f.listeners) listener({ row });
  expect(f.messages.at(-1)).toMatchObject({
    source: f.source,
    message: {
      type: "task.conversation.update",
      payload: { subscriptionId: response.payload.subscriptionId, row },
    },
  });
  await f.request(
    {
      type: "task.conversation.unsubscribe.request",
      requestId: "foreign-release",
      subscriptionId: response.payload.subscriptionId,
    },
    f.other,
  );
  expect(f.listeners.size).toBe(1);
  await f.delivery.detach(f.source);
  expect(f.listeners.size).toBe(0);
  const count = f.messages.length;
  for (const listener of f.listeners) listener({ row });
  expect(f.messages).toHaveLength(count);
  const reconnected = {};
  f.delivery.attach(reconnected, true);
  asInternals<{ clientSources: Map<object, { capabilities: Set<string> }> }>(
    f.session,
  ).clientSources.set(reconnected, { capabilities: new Set([CLIENT_CAPS.taskConversations]) });
  await f.request(
    {
      type: "task.conversation.subscribe.request",
      requestId: "reconnect",
      conversationId: "conversation",
      cursor: { epoch: "epoch", seq: 0 },
    },
    reconnected,
  );
  expect(f.listeners.size).toBe(1);
  await f.delivery.close();
  expect(f.listeners.size).toBe(0);
});

test("only the owner plugin publishes artifacts, and old sockets never receive task/member traffic", async () => {
  const input = {
    type: "task.conversation.publish.request" as const,
    requestId: "publish",
    conversationId: "conversation",
    sourceKey: "artifact",
    kind: "artifact" as const,
    text: "产物",
  };
  const ordinary = transportFixture();
  await expect(ordinary.request(input)).rejects.toThrow("owner plugin");
  expect(ordinary.publish).not.toHaveBeenCalled();
  const owner = transportFixture(createPluginClientId("test-owner"));
  await owner.request(input);
  expect(owner.publish).toHaveBeenCalledTimes(1);
  const taskUpdate: SessionOutboundMessage = {
    type: "task.conversation.update",
    payload: { subscriptionId: "sub", conversationId: "conversation", row },
  };
  expect(owner.internals.taskConversationMessageAllowed(taskUpdate, owner.legacy)).toBe(false);
  expect(owner.internals.taskConversationMessageAllowed(taskUpdate, owner.source)).toBe(true);
  expect(
    owner.internals.taskConversationMessageAllowed(
      { type: "rpc_error", payload: { requestId: "ordinary", error: "ordinary failure" } },
      owner.legacy,
    ),
  ).toBe(true);
});

test("old sockets get an explicit upgrade error for managed open and send while ordinary requests dispatch", async () => {
  const f = transportFixture();
  for (const message of [
    { type: "fetch_agent_request" as const, requestId: "open", agentId: "backend" },
    {
      type: "send_agent_message_request" as const,
      requestId: "send",
      agentId: "backend",
      text: "不能绕过宿主",
    },
  ]) {
    await f.delivery.request(f.legacy, message, () => f.internals.handleRequest(message, f.legacy));
  }
  expect(f.messages.filter((entry) => entry.message.type === "rpc_error")).toHaveLength(2);
  expect(f.messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        source: f.legacy,
        message: expect.objectContaining({
          type: "rpc_error",
          payload: expect.objectContaining({ error: expect.stringContaining("升级") }),
        }),
      }),
    ]),
  );
  const dispatch = asInternals<{ dispatchInboundMessage: ReturnType<typeof vi.fn> }>(
    f.session,
  ).dispatchInboundMessage;
  expect(dispatch).not.toHaveBeenCalled();
  const ordinary = {
    type: "fetch_agent_request" as const,
    requestId: "ordinary",
    agentId: "ordinary",
  };
  await f.delivery.request(f.legacy, ordinary, () => f.internals.handleRequest(ordinary, f.legacy));
  expect(dispatch).toHaveBeenCalledWith(ordinary, f.legacy);
});

test("native member cancel and close use container controls and member deletion is rejected", async () => {
  const f = transportFixture();
  const request = { type: "cancel_agent_request" as const, requestId: "stop", agentId: "backend" };
  await f.delivery.request(f.source, request, () =>
    f.internals.handleCancelAgentRequest("backend", "stop"),
  );
  expect(f.stop).toHaveBeenCalledWith({ conversationId: "conversation" });
  expect(f.messages.at(-1)).toMatchObject({
    message: { type: "cancel_agent_response", payload: { requestId: "stop", error: null } },
  });
  expect(await f.internals.archiveAgentForClose("backend")).toEqual({
    agentId: "backend",
    archivedAt: "2026-10-23T02:00:00Z",
  });
  expect(f.archive).toHaveBeenCalledWith({ conversationId: "conversation" });
  await expect(f.internals.handleDeleteAgentRequest("backend", "delete")).rejects.toThrow(
    "archive the conversation",
  );
});
