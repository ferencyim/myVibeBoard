/** @vitest-environment jsdom */
import React, { type PropsWithChildren } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginWorkspaceTabDescriptor } from "@getpaseo/plugin/client";
import {
  collectAllTabs,
  createDefaultLayout,
  findPaneById,
  reconcileWorkspaceTabs,
} from "@/stores/workspace-layout-actions";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { usePluginWorkspaceTabs } from "./workspace-tabs";

const { resolve } = vi.hoisted(() => ({
  resolve: vi.fn<() => Promise<PluginWorkspaceTabDescriptor[]>>(),
}));

vi.mock("./registry", () => ({
  useInstalledPlugins: () => [
    {
      id: "board",
      serverId: "host",
      workspaceTabProviders: [{ id: "flow", resolve }],
    },
  ],
}));

vi.mock("@/stores/workspace-layout-store", async () => {
  const { create } = await import("zustand");
  return {
    useWorkspaceLayoutStore: create<
      Pick<
        ReturnType<typeof useWorkspaceLayoutStore.getState>,
        "layoutByWorkspace" | "explorerSidebarPaneIdByWorkspace"
      >
    >()(() => ({ layoutByWorkspace: {}, explorerSidebarPaneIdByWorkspace: {} })),
  };
});

let queryClient: QueryClient;
const input = {
  serverId: "host",
  workspaceId: "workspace",
  workspaceKey: "host:workspace",
  cwd: "/repo",
  enabled: true,
  isRouteFocused: true,
  hasHydratedAgents: true,
};

function Wrapper({ children }: PropsWithChildren) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function tabs() {
  return collectAllTabs(
    useWorkspaceLayoutStore.getState().layoutByWorkspace[input.workspaceKey]!.root,
  );
}

beforeEach(() => {
  queryClient = new QueryClient();
  resolve.mockReset();
  // The same host reconciliation used by workspace-screen must work before either
  // terminal discovery or a plugin placeholder request has completed.
  const { layout } = reconcileWorkspaceTabs(
    { layout: createDefaultLayout(), explorerSidebarPaneId: null },
    {
      agentsHydrated: false,
      terminalsHydrated: false,
      activeAgentIds: ["project-agent"],
      autoOpenAgentIds: ["project-agent"],
      standaloneTerminalIds: [],
    },
  );
  useWorkspaceLayoutStore.setState({
    layoutByWorkspace: { [input.workspaceKey]: layout },
    explorerSidebarPaneIdByWorkspace: {},
  });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

describe("workspace plugin placeholder resolution", () => {
  it("renders host agents while resolve is pending and merges late placeholders without changing focus", async () => {
    let complete: (descriptors: PluginWorkspaceTabDescriptor[]) => void = () => {};
    resolve.mockImplementation(
      () =>
        new Promise((done) => {
          complete = done;
        }),
    );
    const initialLayout = useWorkspaceLayoutStore.getState().layoutByWorkspace[input.workspaceKey]!;
    renderHook(() => usePluginWorkspaceTabs(input), { wrapper: Wrapper });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(tabs().map((tab) => tab.target)).toEqual([{ kind: "agent", agentId: "project-agent" }]);
    expect(useWorkspaceLayoutStore.getState().layoutByWorkspace[input.workspaceKey]).toBe(
      initialLayout,
    );

    await act(async () => complete([{ id: "worker", title: "Worker", order: 4 }]));
    await waitFor(() => expect(tabs()).toHaveLength(2));
    const merged = useWorkspaceLayoutStore.getState().layoutByWorkspace[input.workspaceKey]!;
    expect(merged.focusedPaneId).toBe(initialLayout.focusedPaneId);
    expect(tabs()[0]!.target).toEqual({ kind: "agent", agentId: "project-agent" });
    expect(findPaneById(merged.root, merged.focusedPaneId)?.focusedTabId).toBe(tabs()[0]!.tabId);
  });

  it("keeps the host agent visible when resolve fails or times out without immediate retries", async () => {
    resolve.mockRejectedValue(new Error("Plugin RPC timed out"));
    renderHook(() => usePluginWorkspaceTabs(input), { wrapper: Wrapper });
    await waitFor(() =>
      expect(
        queryClient.getQueryState(["plugin-workspace-tabs", "host", "board", "flow", "workspace"])
          ?.status,
      ).toBe("error"),
    );
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(tabs().map((tab) => tab.target)).toEqual([{ kind: "agent", agentId: "project-agent" }]);
  });

  it("shares pending resolution across consumers and polls at most twice per minute", () => {
    resolve.mockImplementation(() => new Promise(() => {}));
    renderHook(
      () => {
        usePluginWorkspaceTabs(input);
        usePluginWorkspaceTabs(input);
      },
      { wrapper: Wrapper },
    );
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryCache().getAll()).toHaveLength(1);
    expect(queryClient.getQueryCache().getAll()[0]!.options).toMatchObject({
      refetchInterval: 30000,
      retry: false,
    });
  });

  it("waits for the host directory and disables placeholder requests on unfocused routes", () => {
    resolve.mockResolvedValue([]);
    const { rerender } = renderHook((props) => usePluginWorkspaceTabs(props), {
      wrapper: Wrapper,
      initialProps: { ...input, hasHydratedAgents: false },
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(tabs()).toHaveLength(1);
    rerender({ ...input, isRouteFocused: false });
    expect(resolve).not.toHaveBeenCalled();
    rerender(input);
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});
