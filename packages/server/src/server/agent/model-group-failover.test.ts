import { describe, expect, test, vi } from "vitest";
import { isModelGroupFailoverError, registerModelGroupFailover } from "./model-group-failover.js";
import type { AgentManager, AgentSubscriber } from "./agent-manager.js";
import type pino from "pino";
import type { ProviderUsage } from "@getpaseo/protocol/messages";

describe("model group failover errors", () => {
  test.each([
    "quota exceeded",
    "Rate limit reached",
    "HTTP 429",
    "server overloaded",
    "model is unavailable",
    "模型不可用",
  ])("recognizes %s", (error) => {
    expect(isModelGroupFailoverError(error)).toBe(true);
  });
  test.each(["invalid API key", "network timeout", "permission denied", "file not found"])(
    "ignores %s",
    (error) => {
      expect(isModelGroupFailoverError(error)).toBe(false);
    },
  );
});

const EXHAUSTED_USAGE = [
  {
    providerId: "codex",
    displayName: "Codex",
    status: "ok",
    planLabel: null,
    windows: [{ id: "5h", label: "5h", remainingPct: 0, resetsAt: "2999-01-01T00:00:00Z" }],
  },
] as unknown as ProviderUsage[];

function setup(nextProvider = "codex", usage: ProviderUsage[] = []) {
  let subscriber!: AgentSubscriber;
  const agent = {
    id: "a",
    provider: "codex",
    workspaceId: "w",
    lifecycle: "error",
    owner: undefined,
    labels: { "paseo.model-group": "g", "paseo.model-group-order": "1" },
    config: { provider: "codex", model: "one", cwd: "/work" },
  };
  const manager = {
    subscribe: vi.fn((callback: AgentSubscriber) => {
      subscriber = callback;
      return () => {};
    }),
    getAgent: vi.fn(() => agent),
    getForegroundPrompt: vi.fn(() => "try this"),
    getForegroundPromptGeneration: vi.fn(() => 1),
    getProviderAvailability: vi.fn(async () => ({ available: true, error: null })),
    setAgentModel: vi.fn(async () => {}),
    setAgentThinkingOption: vi.fn(async () => {}),
    updateAgentMetadata: vi.fn(async () => {}),
    createAgent: vi.fn(async () => ({ id: "b" })),
    appendTimelineItem: vi.fn(async () => ({})),
    streamAgent: vi.fn(async function* () {}),
  };
  registerModelGroupFailover({
    agentManager: manager as unknown as AgentManager,
    getGroups: () => [
      {
        id: "g",
        name: "group",
        entries: [
          { order: 1, provider: "codex", model: "one" },
          { order: 2, provider: nextProvider, model: "two" },
        ],
      },
    ],
    getUsage: async () => usage,
    logger: { warn: vi.fn() } as unknown as pino.Logger,
    retryDelaysMs: [1, 1],
    sleep: async () => {},
  });
  const fail = (error = "server overloaded") =>
    subscriber({
      type: "agent_stream",
      agentId: "a",
      event: { type: "turn_failed", provider: "codex", error, turnId: "t" },
    });
  manager.streamAgent.mockImplementation(async function* (id: string) {
    if (id === "a" && manager.setAgentModel.mock.calls.length === 0) fail();
    yield* [];
  });
  return {
    manager,
    fail: (error = "server overloaded") =>
      subscriber({
        type: "agent_stream",
        agentId: "a",
        event: { type: "turn_failed", provider: "codex", error, turnId: "t" },
      }),
  };
}

test("retries an overloaded model before switching", async () => {
  const { manager, fail } = setup();
  fail();
  await vi.waitFor(() => expect(manager.setAgentModel).toHaveBeenCalledWith("a", "two"));
  const sameAgentStreams = manager.streamAgent.mock.calls.filter(([id]) => id === "a");
  // two retries on the failing entry, then one send after switching
  expect(sameAgentStreams).toHaveLength(3);
  expect(manager.updateAgentMetadata).toHaveBeenCalledWith("a", {
    labels: { "paseo.model-group": "g", "paseo.model-group-order": "2" },
  });
});

test("creates a successor in the workspace and forwards the message", async () => {
  const { manager, fail } = setup("claude", EXHAUSTED_USAGE);
  manager.streamAgent.mockImplementation(async function* () {});
  const prompt = [{ type: "image" as const, data: "image-data", mimeType: "image/png" }];
  manager.getForegroundPrompt.mockReturnValue(prompt as unknown as string);
  fail();
  await vi.waitFor(() => expect(manager.streamAgent).toHaveBeenCalled());
  expect(manager.createAgent).toHaveBeenCalledWith(
    expect.objectContaining({ provider: "claude", model: "two", cwd: "/work" }),
    undefined,
    expect.objectContaining({ workspaceId: "w" }),
  );
  expect(manager.streamAgent).toHaveBeenCalledWith("b", prompt, expect.any(Object));
  // The usage report already shows the quota is gone, so there is no retry on the old agent.
  expect(manager.streamAgent).not.toHaveBeenCalledWith("a", expect.anything(), expect.anything());
  expect(manager.appendTimelineItem).toHaveBeenCalledTimes(2);
});

test("leaves unrelated errors untouched", async () => {
  const { manager, fail } = setup();
  fail("invalid API key");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(manager.streamAgent).not.toHaveBeenCalled();
  expect(manager.setAgentModel).not.toHaveBeenCalled();
});
