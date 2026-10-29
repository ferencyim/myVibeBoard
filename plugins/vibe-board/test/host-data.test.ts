import { describe, expect, it, vi } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { cacheHostRead, listHostProjects } from "../server/host-data";

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
    const expired = read();
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(2);
    finish(43);
    expect(await expired).toBe(43);
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

  it("shares projects across consumers while keeping host API instances separate", async () => {
    const first = { projects: { list: vi.fn(async () => ({ projects: [] })) } };
    const second = { projects: { list: vi.fn(async () => ({ projects: [] })) } };
    await Promise.all(Array.from({ length: 10 }, () => listHostProjects(first as unknown as PaseoApi)));
    await listHostProjects(first as unknown as PaseoApi);
    await listHostProjects(second as unknown as PaseoApi);
    expect(first.projects.list).toHaveBeenCalledTimes(1);
    expect(second.projects.list).toHaveBeenCalledTimes(1);
  });
});
