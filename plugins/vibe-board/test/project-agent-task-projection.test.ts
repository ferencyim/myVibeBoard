import { describe, expect, it, vi } from "vitest";
import type { PluginClientContext, PluginSidebarWorkspaceProvider } from "@getpaseo/plugin/client";
import { contributeTaskSidebarProjection } from "../client/project-agent-task-projection";
import { taskPanelRpc } from "../shared/task-tabs";

describe("task sidebar projection", () => {
  it("queries every workspace and retains registered task details", async () => {
    let provider: PluginSidebarWorkspaceProvider | undefined;
    const rpc = vi.fn(async (contract: unknown, input: { workspaceId: string }) => {
      if (contract === taskPanelRpc) return input.workspaceId === "task"
        ? { isTask: true, phaseLabel: "执行", blockingReason: "等待资源" }
        : { isTask: false, phaseLabel: "", blockingReason: null };
      throw new Error("unexpected RPC");
    });
    const client = { addSidebarWorkspaceProvider(value: PluginSidebarWorkspaceProvider) { provider = value; return () => {}; }, rpc } as unknown as PluginClientContext;
    contributeTaskSidebarProjection(client);
    await expect(provider!.resolve({ projectId: "project", workspaceIds: ["other", "task"] })).resolves.toEqual([
      { workspaceId: "task", kind: "task", phaseLabel: "执行", blockingReason: "等待资源" },
    ]);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("propagates failures so the host does not classify unknown workspaces as ordinary", async () => {
    let provider: PluginSidebarWorkspaceProvider | undefined;
    const client = { addSidebarWorkspaceProvider(value: PluginSidebarWorkspaceProvider) { provider = value; return () => {}; }, rpc: async () => { throw new Error("offline"); } } as unknown as PluginClientContext;
    contributeTaskSidebarProjection(client);
    await expect(provider!.resolve({ projectId: "project", workspaceIds: ["task"] })).rejects.toThrow("offline");
  });

  it("limits simultaneous panel requests across projects", async () => {
    let provider: PluginSidebarWorkspaceProvider | undefined;
    const pending: Array<(value: { isTask: boolean }) => void> = [];
    const rpc = vi.fn(() => new Promise<{ isTask: boolean }>((resolve) => pending.push(resolve)));
    const client = { addSidebarWorkspaceProvider(value: PluginSidebarWorkspaceProvider) { provider = value; return () => {}; }, rpc } as unknown as PluginClientContext;
    contributeTaskSidebarProjection(client);
    const requests = Array.from({ length: 5 }, (_, i) => provider!.resolve({ projectId: String(i), workspaceIds: [String(i)] }));
    expect(rpc).toHaveBeenCalledTimes(4);
    pending.shift()!({ isTask: false });
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(5));
    for (const finish of pending) finish({ isTask: false });
    await Promise.all(requests);
  });
});
