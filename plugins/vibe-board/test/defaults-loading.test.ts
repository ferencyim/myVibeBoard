import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultsLoadingState, withDefaultsTimeout } from "../client/presets/defaults-loading";

afterEach(() => vi.useRealTimers());

describe("task role loading", () => {
  it("shows either failure while the other request is pending, then becomes ready after retry", () => {
    const pending = { error: null, isPending: true };
    const loaded = { error: null, isPending: false };
    const error = new Error("加载失败");
    const failed = { error, isPending: false };
    expect(defaultsLoadingState(failed, pending)).toEqual({ status: "error", error });
    expect(defaultsLoadingState(pending, failed)).toEqual({ status: "error", error });
    expect(defaultsLoadingState(pending, loaded)).toEqual({ status: "loading" });
    expect(defaultsLoadingState(loaded, loaded)).toEqual({ status: "ready" });
  });
  it("reports a stalled request and allows a fresh attempt to succeed", async () => {
    vi.useFakeTimers();
    const request = vi.fn<() => Promise<string>>()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce("loaded");
    const first = withDefaultsTimeout(request);
    const failure = expect(first).rejects.toThrow("加载任务角色超时，请重试");
    await vi.advanceTimersByTimeAsync(15_000);
    await failure;
    await expect(withDefaultsTimeout(request)).resolves.toBe("loaded");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("propagates failures and clears timers when a request settles", async () => {
    vi.useFakeTimers();
    await expect(withDefaultsTimeout(() => Promise.reject(new Error("连接失败"))))
      .rejects.toThrow("连接失败");
    await vi.runAllTimersAsync();
    expect(vi.getTimerCount()).toBe(0);
  });
});
