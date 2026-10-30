import { describe, expect, it, vi } from "vitest";
import { createSingleFlight } from "../server/cache";

describe("状态请求缓存", () => {
  it("合并同时请求，缓存十秒，并允许强制刷新", async () => {
    let finish!: (value: number) => void;
    const load = vi.fn(() => new Promise<number>((resolve) => { finish = resolve; }));
    const cache = createSingleFlight(10000, load);
    const first = cache.get("workspace");
    const second = cache.get("workspace", true);
    expect(load).toHaveBeenCalledTimes(1);
    finish(1);
    expect(await Promise.all([first, second])).toEqual([1, 1]);
    expect(await cache.get("workspace")).toBe(1);
    const forced = cache.get("workspace", true);
    expect(load).toHaveBeenCalledTimes(2);
    finish(2);
    expect(await forced).toBe(2);
  });
});
