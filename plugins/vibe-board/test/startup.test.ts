import { afterEach, expect, it, vi } from "vitest";
import type { PluginServerContext } from "@getpaseo/plugin/server";

const state = vi.hoisted(() => ({
  initialize: vi.fn(),
  close: vi.fn(),
  closeTasks: vi.fn(),
}));
vi.mock("../server/service", () => ({
  openBoardRuntime: () => ({ db: {}, store: {}, close: state.close }),
  createBoardService: () => ({}),
}));
vi.mock("../server/task-runtime", () => ({
  registerTaskRuntime: () => ({
    flow: { registerPrompts: state.initialize },
    close: state.closeTasks,
  }),
}));
vi.mock("../server/rpc", () => ({
  registerBoardRpcs: (server: PluginServerContext) => server.handle({} as never, () => "response"),
}));
vi.mock("../server/evidence", () => ({ createTaskEvidenceReader: () => ({}) }));
vi.mock("../server/resource-tool", () => ({ registerResourceTool: vi.fn() }));
vi.mock("../server/tabs/board-tools", () => ({ registerBoardTools: vi.fn() }));
import contribute from "../index.server";

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it("reports ready without waiting for background recovery and protects an early RPC", async () => {
  vi.useFakeTimers();
  let finish!: () => void;
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
    handle: (_rpc: unknown, handler: () => Promise<unknown>) => handlers.push(handler),
    registerAgentTool: vi.fn(),
  } as unknown as PluginServerContext;
  const close = contribute(server);
  expect(typeof close).toBe("function");
  await Promise.resolve();
  expect(state.initialize).not.toHaveBeenCalled();
  let answered = false;
  const request = handlers[0]!().then((value) => {
    answered = true;
    return value;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(state.initialize).toHaveBeenCalledOnce();
  expect(answered).toBe(false);
  finish();
  await expect(request).resolves.toBe("response");
  await close();
  expect(state.closeTasks).toHaveBeenCalledOnce();
  expect(state.close).toHaveBeenCalledOnce();
});
