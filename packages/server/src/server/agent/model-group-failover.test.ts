import { describe, expect, test, vi } from "vitest";
import { isModelGroupFailoverError, registerModelGroupFailover } from "./model-group-failover.js";
import type { AgentManager, AgentSubscriber } from "./agent-manager.js";
import type pino from "pino";

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

function setup(nextProvider = "codex") {
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
    getUsage: async () => [],
    logger: { warn: vi.fn() } as unknown as pino.Logger,
  });
  return {
    manager,
    fail: (error = "quota exceeded") =>
      subscriber({
        type: "agent_stream",
        agentId: "a",
        event: { type: "turn_failed", provider: "codex", error, turnId: "t" },
      }),
  };
}

test("switches the same provider and retries the failed message", async () => {
  const { manager, fail } = setup();
  fail();
  await vi.waitFor(() => expect(manager.streamAgent).toHaveBeenCalled());
  expect(manager.setAgentModel).toHaveBeenCalledWith("a", "two");
  expect(manager.updateAgentMetadata).toHaveBeenCalledWith("a", {
    labels: { "paseo.model-group": "g", "paseo.model-group-order": "2" },
  });
  expect(manager.streamAgent).toHaveBeenCalledWith("a", "try this", expect.any(Object));
});

test("creates a successor in the workspace and forwards the message", async () => {
  const { manager, fail } = setup("claude");
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
  expect(manager.appendTimelineItem).toHaveBeenCalledTimes(2);
});

test("leaves unrelated errors untouched", async () => {
  const { manager, fail } = setup();
  fail("invalid API key");
  await Promise.resolve();
  expect(manager.getForegroundPrompt).not.toHaveBeenCalled();
});
