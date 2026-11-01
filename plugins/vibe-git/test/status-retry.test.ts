import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostReconnected, statusFailureMessage, statusRetryDelay } from "../client/status-retry";

afterEach(() => vi.useRealTimers());

describe("Git 面板状态重试", () => {
  it("退避有上限，只有主机恢复在线时立即重试", () => {
    expect([0, 1, 2, 3, 4].map(statusRetryDelay)).toEqual([2_000, 5_000, 15_000, 30_000, 30_000]);
    expect(hostReconnected("offline", "online")).toBe(true);
    expect(hostReconnected("online", "online")).toBe(false);
    expect(hostReconnected("online", "offline")).toBe(false);
    expect(statusFailureMessage(true)).toContain("状态更新失败");
    expect(statusFailureMessage(false)).toContain("状态读取失败");
  });

  it("请求失败时保留旧数据，退避后成功自动更新", async () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const queryKey = ["status"];
    client.setQueryData(queryKey, "旧数据");
    const fetch = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue("新数据");
    const observer = new QueryObserver(client, { queryKey, queryFn: fetch, retry: true, retryDelay: statusRetryDelay });
    const unsubscribe = observer.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(observer.getCurrentResult().data).toBe("旧数据");
    expect(observer.getCurrentResult().failureReason).toBeTruthy();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(observer.getCurrentResult().data).toBe("新数据");
    expect(observer.getCurrentResult().failureReason).toBeNull();
    unsubscribe();
    client.clear();
  });
});
