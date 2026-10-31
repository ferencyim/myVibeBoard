import { beforeEach, describe, it, expect, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  values: new Map<string, string>(),
  online: false,
  callbacks: new Set<() => void>(),
  client: { listProjects: vi.fn(), invokePluginRpc: vi.fn() },
  plugins: ["vibe-board"],
  receivedBots: vi.fn(),
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
  botSnapshotCache: { received: mocks.receivedBots },
  pluginRegistry: {
    getSnapshot: () => mocks.plugins.map((id) => ({ id, serverId: "host" })),
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
    mocks.plugins = ["vibe-board"];
    mocks.client.invokePluginRpc.mockReset();
    mocks.client.listProjects.mockReset();
    mocks.receivedBots.mockReset();
  });
  it("polls every 60 seconds", async () => {
    vi.useFakeTimers();
    mocks.online = true;
    mocks.client.listProjects.mockResolvedValue({ projects: [] });
    const runtime = await import("./project-documents");
    const stop = runtime.startProjectDocumentSync();
    try {
      await runtime.flushProjectDocuments();
      expect(mocks.client.listProjects).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(59999);
      expect(mocks.client.listProjects).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(mocks.client.listProjects).toHaveBeenCalledTimes(2);
    } finally {
      stop();
      vi.useRealTimers();
    }
  });
  it("flushes a newly queued outbox change immediately, even during a flush", async () => {
    mocks.online = true;
    let release!: (value: { projects: never[] }) => void;
    mocks.client.listProjects
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValue({ projects: [] });
    mocks.client.invokePluginRpc.mockResolvedValue({ documents: [], pending: [] });
    const runtime = await import("./project-documents");
    const stop = runtime.startProjectDocumentSync();
    try {
      await vi.waitFor(() => expect(release).toBeDefined());
      const cache = runtime.getProjectDocumentCache("host", "project");
      await runtime.loadProjectDocumentCache(cache);
      const change = {
        id: "queued",
        documents: [{ path: "AGENTS.md" as const, content: "edit", baseRevision: "old" }],
        createdAt: "2026-10-28T00:00:00Z",
      };
      await cache.queue(change);
      release({ projects: [] });
      await vi.waitFor(() =>
        expect(mocks.client.invokePluginRpc).toHaveBeenCalledWith(
          "vibe-board",
          "vibe.project.brief.submit",
          { projectId: "project", id: change.id, documents: change.documents },
        ),
      );
      await vi.waitFor(() => expect(cache.snapshot().outbox).toEqual([]));
      await runtime.flushProjectDocuments();
      const calls = mocks.client.listProjects.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(mocks.client.listProjects).toHaveBeenCalledTimes(calls);
    } finally {
      stop();
    }
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
  it("refreshes every bot and its personal memories after reconnect without opening a bot page", async () => {
    mocks.plugins = ["vibe-bots"];
    const snapshot = { bots: [{ id: "bot", memories: [{ text: "个人偏好" }] }] };
    mocks.client.invokePluginRpc.mockResolvedValue(snapshot);
    mocks.receivedBots.mockResolvedValue(undefined);
    const runtime = await import("./project-documents");
    const stop = runtime.startProjectDocumentSync();
    try {
      await runtime.flushProjectDocuments();
      expect(mocks.client.invokePluginRpc).not.toHaveBeenCalled();
      mocks.online = true;
      for (const fn of mocks.callbacks) fn();
      await runtime.flushProjectDocuments();
      expect(mocks.client.invokePluginRpc).toHaveBeenCalledWith("vibe-bots", "bots.list", {
        includeArchived: true,
      });
      expect(mocks.receivedBots).toHaveBeenCalledWith("host", { includeArchived: true }, snapshot);
    } finally {
      stop();
    }
  });
});
