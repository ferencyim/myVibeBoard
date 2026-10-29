import { afterEach, expect, it, vi } from "vitest";
import type { PluginServerContext } from "@getpaseo/plugin/server";

const state = vi.hoisted(() => ({
  initialize: vi.fn(),
  close: vi.fn(),
  closeTasks: vi.fn(),
  rpc: {},
  respond: vi.fn(() => "response"),
}));
vi.mock("../server/service", async () => {
  const { openBoardRuntime } =
    await vi.importActual<typeof import("../server/service")>("../server/service");
  return {
    openBoardRuntime: () => {
      const runtime = openBoardRuntime({ path: ":memory:" });
      state.close.mockImplementation(() => runtime.close());
      return { ...runtime, close: state.close };
    },
    createBoardService: () => ({}),
  };
});
vi.mock("../server/task-runtime", () => ({
  registerTaskRuntime: () => ({
    flow: { registerPrompts: state.initialize },
    close: state.closeTasks,
  }),
}));
vi.mock("../server/rpc", () => ({
  registerBoardRpcs: (server: PluginServerContext) => server.handle(state.rpc as never, state.respond),
}));
vi.mock("../server/evidence", () => ({ createTaskEvidenceReader: () => ({}) }));
vi.mock("../server/resource-tool", () => ({ registerResourceTool: vi.fn() }));
vi.mock("../server/tabs/board-tools", () => ({ registerBoardTools: vi.fn() }));
vi.mock("../server/project-agent/completion", () => ({
  createProjectCompletion: () => ({ close: async () => {} }),
}));
import contribute from "../index.server";

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it("reports ready without waiting for background recovery and protects an early RPC", async () => {
  vi.useFakeTimers();
  let finish: (() => void) | undefined;
  state.initialize.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const handlers: Array<() => Promise<unknown>> = [];
  const server = {
    paseo: null,
    registerSettings: () => ({
      read: async () => ({ status: "ready", values: {} }),
      subscribe: () => () => {},
    }),
    handle: (rpc: unknown, handler: () => Promise<unknown>) => {
      if (rpc === state.rpc) handlers.push(handler);
    },
    on: () => () => {},
    registerAgentTool: vi.fn(),
  } as unknown as PluginServerContext;
  const close = contribute(server);
  try {
    expect(typeof close).toBe("function");
    await Promise.resolve();
    expect(state.initialize).not.toHaveBeenCalled();
    expect(handlers).toHaveLength(1);
    let answered = false;
    const request = handlers[0]!().then((value) => {
      answered = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(state.initialize).toHaveBeenCalledOnce();
    expect(answered).toBe(false);
    expect(state.respond).not.toHaveBeenCalled();
    finish!();
    await expect(request).resolves.toBe("response");
    expect(state.respond).toHaveBeenCalledOnce();
  } finally {
    finish?.();
    await close();
  }
  expect(state.closeTasks).toHaveBeenCalledOnce();
  expect(state.close).toHaveBeenCalledOnce();
});
