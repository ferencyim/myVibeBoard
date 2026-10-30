import { describe, expect, it, vi } from "vitest";
import {
  createFailureWindow,
  diagnosticText,
  environmentFailure,
  timelineFailureText,
} from "../server/environment/detection";
import { registerEnvironmentMonitor } from "../server/environment";

describe("环境故障监控", () => {
  it("detects pre-process failures, model capacity and startup failures with bounded cooldown", () => {
    expect(environmentFailure("Failed to create unified exec process: helper_unknown_error")).toBe(
      "process_start",
    );
    expect(environmentFailure("model is unavailable due to capacity")).toBe("model_unavailable");
    expect(environmentFailure("failed to start provider session")).toBe("agent_start");
    expect(environmentFailure("unit test failed with exit code 1")).toBeNull();
    let time = 0;
    const allow = createFailureWindow(() => time, 100);
    expect(allow("a", "process_start")).toBe(true);
    expect(allow("a", "process_start")).toBe(false);
    expect(allow("b", "process_start")).toBe(true);
    expect(allow("a", "model_unavailable")).toBe(true);
    time = 100;
    expect(allow("a", "process_start")).toBe(true);
  });
  it("does not treat commands, quotes or read files as environment errors", () => {
    expect(
      timelineFailureText({
        type: "tool_call",
        name: "read_file",
        detail: { type: "read", content: "helper_unknown_error" },
      }),
    ).toBeNull();
    expect(
      timelineFailureText({
        type: "tool_call",
        name: "exec_command",
        detail: { type: "shell", command: "echo helper_unknown_error", output: "ok" },
      }),
    ).toBe("ok");
    expect(
      timelineFailureText({
        type: "tool_call",
        name: "exec_command",
        detail: { type: "shell", output: "helper_unknown_error" },
      }),
    ).toBe("helper_unknown_error");
  });
  it("redacts credentials, addresses and user directories", () => {
    const value = diagnosticText(
      "token=private-value https://example.test/error 127.0.0.1 /home/example/path",
    );
    expect(value).not.toContain("private-value");
    expect(value).not.toContain("example.test");
    expect(value).not.toContain("127.0.0.1");
    expect(value).not.toContain("/home/example");
    expect(
      diagnosticText(
        JSON.stringify({ token: "private", apiKey: "key", authorization: "Bearer secret" }),
      ),
    ).not.toMatch(/private|Bearer secret|"key"/);
  });
  it("rejects task callers and cross-project targets, and marks a failed project agent without recursive delivery", async () => {
    const tools = new Map<
      string,
      { handler: (input: unknown, context: { callerAgentId: string }) => Promise<unknown> }
    >();
    const sendProject = vi.fn();
    const setError = vi.fn();
    const appendStatus = vi.fn();
    const agent = { id: "project", workspaceId: null, provider: "codex", model: "m" };
    const handle = { refresh: async () => ({ agent }), current: () => agent };
    const api = { agents: { ref: () => handle, subscribe: () => () => {} } };
    const monitor = registerEnvironmentMonitor(
      {
        on: () => () => {},
        registerAgentTool: (tool: { name: string; handler: never }) => tools.set(tool.name, tool),
      } as never,
      {
        store: {} as never,
        getPaseo: () => api as never,
        projects: {
          projectForAgent: async (id) => (id === "project" ? "p" : "q"),
          callerProject: async (id) => {
            if (id !== "project") throw new Error("仅项目 agent");
            return "p";
          },
          sendProject,
          setError,
          appendStatus,
        },
      },
    );
    const diagnose = tools.get("vibe_env_diagnose")!;
    await expect(
      diagnose.handler({ agentId: "project" }, { callerAgentId: "task" }),
    ).rejects.toThrow("仅项目 agent");
    await expect(
      diagnose.handler({ agentId: "other" }, { callerAgentId: "project" }),
    ).rejects.toThrow("本项目");
    await monitor.report("project", "helper_unknown_error");
    await monitor.report("project", "helper_unknown_error");
    expect(setError).toHaveBeenCalledTimes(1);
    expect(appendStatus).toHaveBeenCalledTimes(1);
    expect(sendProject).not.toHaveBeenCalled();
    monitor.close();
  });
  it("retries with plugin provenance, refuses active turns, and advances only to preset fallback candidates", async () => {
    const tools = new Map<
      string,
      { handler: (input: unknown, context: { callerAgentId: string }) => Promise<unknown> }
    >();
    let active = false;
    const send = vi.fn(async () => {});
    const resume = vi.fn(async () => {});
    const created = vi.fn(async () => ({ id: "replacement" }));
    const handoff = vi.fn(async () => {});
    const ensureTab = vi.fn(async () => {});
    const agent = { id: "target", workspaceId: "w", provider: "codex", model: "first" };
    const handle = {
      refresh: async () => ({ agent }),
      current: () => agent,
      get activeTurn() {
        return active ? { id: "turn" } : null;
      },
      pendingPermissions: [],
      send,
      resume,
    };
    const api = {
      agents: { ref: () => handle, subscribe: () => () => {} },
      workspaces: {
        ref: () => ({ refresh: async () => ({ projectId: "p" }), agents: { create: created } }),
      },
    };
    const task = {
      tabs: [
        {
          agentId: "target",
          number: 1,
          role: "main",
          presetId: "preset",
          provider: "codex",
          model: "first",
        },
      ],
    };
    const monitor = registerEnvironmentMonitor(
      {
        on: () => () => {},
        registerAgentTool: (tool: { name: string; handler: never }) => tools.set(tool.name, tool),
      } as never,
      {
        store: {
          tasks: { get: () => task },
          presets: {
            get: () => ({
              fastMode: true,
              models: [
                { provider: "codex", model: "first" },
                { provider: "claude", model: "next" },
              ],
            }),
          },
        } as never,
        getPaseo: () => api as never,
        tasks: { tabs: { ensureTab }, flow: { handoff } } as never,
        projects: {
          projectForAgent: async (id) => (id === "project" ? "p" : null),
          callerProject: async () => "p",
          sendProject: vi.fn(),
          setError: vi.fn(),
          appendStatus: vi.fn(),
        },
      },
    );
    const recover = tools.get("vibe_env_recover")!;
    await recover.handler({ agentId: "target", action: "retry" }, { callerAgentId: "project" });
    expect(send).toHaveBeenCalledWith(expect.any(String), { sourceAgentId: "project" });
    active = true;
    await expect(
      recover.handler({ agentId: "target", action: "fallback" }, { callerAgentId: "project" }),
    ).rejects.toThrow("会话运行中");
    expect(created).not.toHaveBeenCalled();
    active = false;
    await recover.handler({ agentId: "target", action: "fallback" }, { callerAgentId: "project" });
    expect(created).toHaveBeenCalledWith(
      expect.objectContaining({
        config: { provider: "claude/next", featureValues: { fast_mode: true } },
      }),
    );
    expect(ensureTab).toHaveBeenCalledWith("replacement");
    expect(handoff).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "w",
        agentId: "replacement",
        reason: expect.stringContaining("#1"),
      }),
    );
    monitor.close();
  });
  it("owns one timeline subscription across concurrent hooks and invalidates pending watches on archive or close", async () => {
    const hooks = new Map<string, (event: unknown, context: unknown) => unknown>();
    const releases = new Map<string, () => void>();
    const subscribe = vi.fn(() => Object.assign(vi.fn(), { ready: Promise.resolve() }));
    const api = {
      agents: {
        subscribe: () => () => {},
        ref: (id: string) => ({
          refresh: () =>
            new Promise((resolve) => {
              releases.set(id, () => resolve({ agent: { workspaceId: "w" } }));
            }),
          timeline: { subscribe },
        }),
      },
      workspaces: { ref: () => ({ refresh: async () => ({ projectId: "p" }) }) },
    };
    const monitor = registerEnvironmentMonitor(
      {
        on: (name: string, hook: (event: unknown, context: unknown) => unknown) => {
          hooks.set(name, hook);
          return () => {};
        },
        registerAgentTool: () => {},
      } as never,
      {
        store: {
          tasks: {
            get: () => ({
              tabs: ["one", "archived", "closed"].map((agentId) => ({ agentId, number: 1 })),
            }),
          },
        } as never,
        getPaseo: () => api as never,
        projects: {
          projectForAgent: async () => null,
          callerProject: async () => "p",
          sendProject: vi.fn(),
          setError: vi.fn(),
          appendStatus: vi.fn(),
        },
      },
    );
    const created = hooks.get("agent.created")!;
    const started = hooks.get("agent.turn_started")!;
    const context = { paseo: api };
    created({ agent: { id: "one" } }, context);
    started({ agent: { id: "one" } }, context);
    await vi.waitFor(() => expect(releases.has("one")).toBe(true));
    releases.get("one")!();
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1));
    created({ agent: { id: "archived" } }, context);
    await vi.waitFor(() => expect(releases.has("archived")).toBe(true));
    hooks.get("agent.archived")!({ agent: { id: "archived" } }, context);
    releases.get("archived")!();
    created({ agent: { id: "closed" } }, context);
    await vi.waitFor(() => expect(releases.has("closed")).toBe(true));
    monitor.close();
    releases.get("closed")!();
    await Promise.resolve();
    await Promise.resolve();
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(subscribe.mock.results[0].value).toHaveBeenCalledTimes(1);
  });
});
