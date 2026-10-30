import { describe, expect, it, vi } from "vitest";
import type { PluginServerContext } from "@getpaseo/plugin/server";

const captured = vi.hoisted(() => ({
  native: undefined as undefined | ((id: string) => Promise<unknown>),
}));
vi.mock("../server/runtime", () => ({
  DEFAULT_SETTINGS: {},
  createSchedulerRuntime: (options: { native: (id: string) => Promise<unknown> }) => {
    captured.native = options.native;
    // The hub is not under test here; every hub method is a no-op.
    return { hub: new Proxy({}, { get: () => () => undefined }) };
  },
}));
vi.mock("../server/directive-register", () => ({ registerDirectives: () => () => undefined }));
vi.mock("../server/vibe/db", () => ({
  openVibeDb: () => ({}),
  migrateOwner: () => undefined,
  resolveVibeHome: () => ".",
}));
import contribute from "../index.server";

function adapter(snapshot: unknown, metadata = true, failure = false) {
  const refresh = vi.fn(async () => {
    if (failure) throw new Error("宿主连接不可用");
    return snapshot;
  });
  const list = vi.fn();
  contribute({
    paseo: {
      workspaces: {
        ref: () => ({
          refresh,
          directory: metadata ? "repo" : null,
          projectId: metadata ? "project" : null,
        }),
      },
      agents: { list },
    },
    registerSettings: () => ({
      read: () => new Promise(() => undefined),
      subscribe: () => () => undefined,
    }),
    registerAgentTool: () => undefined,
    on: () => () => undefined,
    handle: () => undefined,
  } as unknown as PluginServerContext);
  return { native: captured.native!, refresh, list };
}

describe("native workspace recovery query", () => {
  it("仅成功查询确认缺失时返回 null", async () => {
    const query = adapter(null);
    expect(await query.native("gone")).toBeNull();
    expect(query.refresh).toHaveBeenCalledOnce();
    expect(query.list).not.toHaveBeenCalled();
  });
  it("查询失败和缺少 placement 都保留暂时不可用语义", async () => {
    await expect(adapter(null, false, true).native("waiting")).rejects.toThrow("宿主连接不可用");
    await expect(adapter({}, false).native("waiting")).rejects.toThrow("尚未就绪");
  });
  it.each([true, false])(
    "正在归档不等于归档完成，placement 可读=%s 时均等待重试",
    async (metadata) => {
      const query = adapter({ archivingAt: "2026-01-01T00:00:00Z" }, metadata);
      await expect(query.native("archiving")).rejects.toThrow("正在归档");
      expect(query.list).not.toHaveBeenCalled();
    },
  );
});
