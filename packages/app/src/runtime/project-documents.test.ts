import { beforeEach, describe, it, expect, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  values: new Map<string, string>(),
  online: false,
  callbacks: new Set<() => void>(),
  client: { listProjects: vi.fn(), invokePluginRpc: vi.fn() },
}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getAllKeys: async () => [...mocks.values.keys()],
    getItem: async (k: string) => mocks.values.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      mocks.values.set(k, v);
    },
  },
}));
vi.mock("@/plugins/registry", () => ({
  pluginRegistry: {
    getSnapshot: () => [{ id: "vibe-board", serverId: "host" }],
    subscribe: (fn: () => void) => {
      mocks.callbacks.add(fn);
      return () => mocks.callbacks.delete(fn);
    },
  },
}));
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({
    getHosts: () => [{ serverId: "host" }],
    getSnapshot: () => ({
      connectionStatus: mocks.online ? "online" : "offline",
      client: mocks.client,
    }),
    subscribeAll: (fn: () => void) => {
      mocks.callbacks.add(fn);
      return () => mocks.callbacks.delete(fn);
    },
    subscribeHostList: () => () => {},
  }),
}));
describe("project document background reconnect", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.values.clear();
    mocks.callbacks.clear();
    mocks.online = false;
  });
  it("delivers persisted offline edits after reconnect without opening project settings", async () => {
    const key = "project-documents:v1:host:project";
    const change = {
      id: "offline",
      documents: [{ path: "AGENTS.md", content: "edit", baseRevision: "old" }],
      createdAt: "2026-10-28T00:00:00Z",
    };
    mocks.values.set(key, JSON.stringify({ documents: [], pending: [], outbox: [change] }));
    mocks.client.listProjects.mockResolvedValue({ projects: [] });
    mocks.client.invokePluginRpc.mockImplementation(async (_plugin, method) =>
      method.endsWith("submit")
        ? { documents: [], pending: [{ ...change, deliveredAt: null }] }
        : { documents: [], pending: [] },
    );
    const runtime = await import("./project-documents");
    const stop = runtime.startProjectDocumentSync();
    try {
      await runtime.flushProjectDocuments();
      expect(mocks.client.invokePluginRpc).not.toHaveBeenCalled();
      mocks.online = true;
      for (const fn of mocks.callbacks) fn();
      await runtime.flushProjectDocuments();
      expect(mocks.client.invokePluginRpc).toHaveBeenCalledWith(
        "vibe-board",
        "vibe.project.brief.submit",
        { projectId: "project", id: "offline", documents: change.documents },
      );
      expect(JSON.parse(mocks.values.get(key)!).outbox).toEqual([]);
      const discoveries = mocks.client.listProjects.mock.calls.length;
      for (const fn of mocks.callbacks) fn();
      await Promise.resolve();
      await Promise.resolve();
      expect(mocks.client.listProjects).toHaveBeenCalledTimes(discoveries);
    } finally {
      stop();
    }
  });
});
