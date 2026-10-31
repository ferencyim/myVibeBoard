import { describe, expect, it, vi } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { associateHostProjects, cacheHostRead, listHostProjects } from "../server/host-data";

import { createBoardService, openBoardRuntime } from "../server/service";

describe("host data cache", () => {
  it("coalesces readers and starts the TTL after the host request completes", async () => {
    let time = 0;
    let finish!: (value: number) => void;
    const load = vi.fn(() => new Promise<number>((resolve) => { finish = resolve; }));
    const read = cacheHostRead(load, 30_000, () => time);
    const readers = Array.from({ length: 20 }, () => read());
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    time = 7_000;
    finish(42);
    expect(await Promise.all(readers)).toEqual(Array(20).fill(42));
    time = 36_999;
    expect(await read()).toBe(42);
    expect(load).toHaveBeenCalledTimes(1);
    time = 37_000;
    expect(await read()).toBe(42);
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(2);
    const expired = read(true);
    finish(43);
    expect(await expired).toBe(43);
    expect(await read()).toBe(43);
  });

  it("releases a rejected single flight and allows retry", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("unavailable")).mockResolvedValue(1);
    const read = cacheHostRead(load, 30_000);
    const first = read();
    expect(read()).toBe(first);
    await expect(first).rejects.toThrow("unavailable");
    expect(await read()).toBe(1);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("coalesces forced refreshes and retains the last success if refresh fails", async () => {
    let finish!: (value: number) => void;
    const load = vi.fn().mockResolvedValueOnce(1)
      .mockImplementationOnce(() => new Promise<number>((resolve) => { finish = resolve; }))
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce(3);
    const read = cacheHostRead<number>(load, 30_000);
    expect(await read()).toBe(1);
    const refresh = read(true);
    expect(read(true)).toBe(refresh);
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(2);
    finish(2);
    expect(await refresh).toBe(2);
    await expect(read(true)).rejects.toThrow("unavailable");
    expect(await read()).toBe(2);
    expect(await read(true)).toBe(3);
  });

  it("serves stale data during a failed background refresh and retries", async () => {
    let time = 0;
    const load = vi.fn().mockResolvedValueOnce(1)
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce(2);
    const read = cacheHostRead<number>(load, 10, () => time);
    expect(await read()).toBe(1);
    time = 10;
    expect(await read()).toBe(1);
    await expect(read(true)).rejects.toThrow("unavailable");
    expect(await read()).toBe(1);
    expect(load).toHaveBeenCalledTimes(2);
    time += 5_000;
    expect(await read()).toBe(1);
    expect(await read(true)).toBe(2);
    expect(await read()).toBe(2);
  });

  it("shares projects across consumers while keeping host API instances separate", async () => {
    const first = { projects: { list: vi.fn(async () => ({ projects: [] })) } };
    const second = { projects: { list: vi.fn(async () => ({ projects: [] })) } };
    await Promise.all(Array.from({ length: 10 }, () => listHostProjects(first as unknown as PaseoApi)));
    await listHostProjects(first as unknown as PaseoApi);
    await listHostProjects(second as unknown as PaseoApi);
    expect(first.projects.list).toHaveBeenCalledTimes(1);
    expect(second.projects.list).toHaveBeenCalledTimes(1);
  });
  it("associates every listed native project, including on subsequent reads", async () => {
    const runtime = openBoardRuntime({ path: ":memory:" });
    try {
      const board = createBoardService(runtime);
      const list = vi.spyOn(board.store.projects, "list");
      const host = { projects: { list: vi.fn(async () => ({ projects: [
        { projectId: "one", projectDisplayName: "项目一", projectRootPath: "/one" },
        { projectId: "two", projectDisplayName: "项目二", projectRootPath: "/two" },
      ] })) } } as unknown as PaseoApi;
      await associateHostProjects(host, board);
      const callsAfterSync = list.mock.calls.length;
      await listHostProjects(host);
      expect(list).toHaveBeenCalledTimes(callsAfterSync);
      expect(board.store.projects.list(true).map((p) => p.paseoProjectId).sort()).toEqual(["one", "two"]);
    } finally {
      runtime.close();
    }
  });

  it("isolates an ambiguous legacy project and refreshes newly created native projects", async () => {
    const runtime = openBoardRuntime({ path: ":memory:" });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const board = createBoardService(runtime);
      board.store.projects.create({ name: "旧一", prefix: "OLD1", repoPath: "/same" });
      board.store.projects.create({ name: "旧二", prefix: "OLD2", repoPath: "/same" });
      const entries = [
        { projectId: "bad", projectDisplayName: "冲突", projectRootPath: "/same" },
        { projectId: "good", projectDisplayName: "正常", projectRootPath: "/good" },
      ];
      const host = { projects: { list: vi.fn(async () => ({ projects: [...entries] })) } } as unknown as PaseoApi;
      await associateHostProjects(host, board);
      expect(board.store.projects.list(true).some((p) => p.paseoProjectId === "good")).toBe(true);
      entries.push({ projectId: "new", projectDisplayName: "新增", projectRootPath: "/new" });
      await listHostProjects(host, true);
      expect(board.store.projects.list(true).some((p) => p.paseoProjectId === "new")).toBe(true);
    } finally {
      log.mockRestore();
      runtime.close();
    }
  });

});
