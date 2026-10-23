import { beforeEach, expect, it, vi } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { VibeDb, VibeStore } from "../server/vibe/db";
import { registerTaskRuntime } from "../server/task-runtime";

const mocks = vi.hoisted(() => {
  const turn = { turnId: "turn", isCurrent: vi.fn(() => true), release: vi.fn() };
  return {
    turn,
    host: {
      hooks: {},
      isCompacting: vi.fn(() => false),
      registerPrompts: vi.fn(),
      resolveRoles: vi.fn(),
      resolveRecipient: vi.fn(),
      releaseAgent: vi.fn(),
      noteTurnStarted: vi.fn(),
      takeTurn: vi.fn((): typeof turn | undefined => turn),
      reconcileAnchor: vi.fn(),
      handleAdmission: vi.fn(),
      close: vi.fn(),
    },
    flow: {
      onTurnCompleted: vi.fn(),
      recoverCompletedSources: vi.fn(),
      publishPendingArtifacts: vi.fn(),
      handleEvent: vi.fn(),
      command: vi.fn(),
    },
  };
});
vi.mock("../server/task-host", () => ({ createTaskHost: () => mocks.host }));
vi.mock("../server/task-conversation/service", () => ({
  createTaskConversationService: () => mocks.flow,
}));
vi.mock("../server/task-panel", () => ({ createTaskPanelReader: () => vi.fn() }));
vi.mock("../server/vibe/db", () => ({
  resolveVibeHome: () => "D:/devRepoCaches/r5-115-home/vibe",
  createEventConsumer: () => ({ start: vi.fn(), stop: vi.fn() }),
}));

type EndedHandler = (
  event: {
    agent: { id: string };
    turnId: string | null;
    outcome: { kind: "completed" | "failed" };
  },
  context: { paseo: PaseoApi },
) => Promise<void>;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.host.isCompacting.mockReturnValue(false);
  mocks.host.takeTurn.mockReturnValue(mocks.turn);
  mocks.turn.isCurrent.mockReturnValue(true);
});

it("keeps native compaction turn events out of task completion and lease release", async () => {
  const handlers = new Map<string, EndedHandler>();
  const server = {
    registerTaskConversationHooks: () => vi.fn(),
    on: (name: string, handler: EndedHandler) => {
      handlers.set(name, handler);
      return vi.fn();
    },
    handle: vi.fn(),
  } as unknown as PluginServerContext;
  const store = {
    tasks: {
      list: () => [],
      get: () => ({ workspaceId: "workspace", conversationId: "conversation" }),
    },
    sessions: { getByAgent: () => ({ workspaceId: "workspace", cardId: null }) },
  } as unknown as VibeStore;
  const paseo = {} as PaseoApi;
  const runtime = registerTaskRuntime(server, {
    db: {} as VibeDb,
    store,
    getPaseo: () => paseo,
    onPaseo: vi.fn(),
  });
  try {
    const ended = handlers.get("agent.turn_ended")!;
    const started = handlers.get("agent.turn_started")!;
    mocks.host.isCompacting.mockReturnValue(true);
    await started(
      { agent: { id: "planner" }, turnId: "compact", outcome: { kind: "completed" } },
      { paseo },
    );
    expect(mocks.host.noteTurnStarted).not.toHaveBeenCalled();
    await ended(
      { agent: { id: "planner" }, turnId: "turn", outcome: { kind: "completed" } },
      { paseo },
    );
    await ended(
      { agent: { id: "planner" }, turnId: "turn", outcome: { kind: "failed" } },
      { paseo },
    );
    expect(mocks.host.releaseAgent).not.toHaveBeenCalled();
    expect(mocks.host.reconcileAnchor).not.toHaveBeenCalled();
    expect(mocks.flow.onTurnCompleted).not.toHaveBeenCalled();

    mocks.host.isCompacting.mockReturnValue(false);
    await started(
      { agent: { id: "planner" }, turnId: "turn", outcome: { kind: "completed" } },
      { paseo },
    );
    expect(mocks.host.noteTurnStarted).toHaveBeenCalledExactlyOnceWith("planner", "turn");
    await ended(
      { agent: { id: "planner" }, turnId: "turn", outcome: { kind: "completed" } },
      { paseo },
    );
    expect(mocks.host.reconcileAnchor).toHaveBeenCalledWith("workspace", "conversation");
    expect(mocks.flow.onTurnCompleted).toHaveBeenCalledExactlyOnceWith("planner", mocks.turn);
    await ended(
      { agent: { id: "planner" }, turnId: "turn", outcome: { kind: "failed" } },
      { paseo },
    );
    expect(mocks.turn.release).toHaveBeenCalledOnce();
    mocks.host.takeTurn.mockReturnValue(undefined);
    await ended(
      { agent: { id: "planner" }, turnId: null, outcome: { kind: "completed" } },
      { paseo },
    );
    mocks.host.takeTurn.mockReturnValue(mocks.turn);
    mocks.turn.isCurrent.mockReturnValue(false);
    await ended(
      { agent: { id: "planner" }, turnId: "old", outcome: { kind: "completed" } },
      { paseo },
    );
    await ended(
      { agent: { id: "planner" }, turnId: "old", outcome: { kind: "failed" } },
      { paseo },
    );
    expect(mocks.flow.onTurnCompleted).toHaveBeenCalledTimes(1);
    expect(mocks.turn.release).toHaveBeenCalledTimes(1);
    mocks.turn.isCurrent.mockReturnValue(true);
    mocks.host.reconcileAnchor.mockImplementationOnce(() => {
      mocks.turn.isCurrent.mockReturnValue(false);
    });
    await ended(
      { agent: { id: "planner" }, turnId: "turn", outcome: { kind: "completed" } },
      { paseo },
    );
    expect(mocks.flow.onTurnCompleted).toHaveBeenCalledTimes(1);
  } finally {
    await runtime.close();
  }
});
