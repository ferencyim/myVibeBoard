import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { taskPanelQueryKey, taskPanelRefreshInterval } from "../client/task-panel-query";

describe("任务面板查询", () => {
  it("同一工作区共用在途请求和短期缓存，不混用其他工作区", async () => {
    const client = new QueryClient();
    const fetch = vi.fn(async () => ({ task: "snapshot" }));
    const options = (id: string) => ({
      queryKey: taskPanelQueryKey(id), queryFn: fetch, staleTime: taskPanelRefreshInterval,
    });
    await Promise.all([client.fetchQuery(options("a")), client.fetchQuery(options("a"))]);
    await client.fetchQuery(options("a"));
    expect(fetch).toHaveBeenCalledTimes(1);
    await client.fetchQuery(options("b"));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(taskPanelRefreshInterval).toBe(15_000);
    client.clear();
  });
});
