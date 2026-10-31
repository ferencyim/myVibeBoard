/** @vitest-environment jsdom */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectAllTabs,
  createDefaultLayout,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { useConditionalExplorerPanels } from "./required-explorer-panels";

const { resolve, plugins } = vi.hoisted(() => {
  const predicate = vi.fn();
  return {
    resolve: predicate,
    plugins: [
      {
        id: "maintain",
        serverId: "host",
        paseo: {},
        workspacePanels: [
          { id: "rules", context: "agent", locations: ["explorer"], requiredForAgent: predicate },
        ],
      },
    ],
  };
});
vi.mock("@/plugins/registry", () => ({
  useInstalledPlugins: () => plugins,
  pluginRegistry: { getSnapshot: () => plugins },
}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => {}),
    removeItem: vi.fn(async () => {}),
  },
}));

const workspaceKey = "host:workspace";
const input = {
  serverId: "host",
  workspaceKey,
  enabled: true,
  agentId: "coordinator",
  botId: "master",
};
function tabs() {
  return collectAllTabs(useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root);
}
function panel() {
  return tabs().find(({ target }) => target.kind === "plugin" && target.pluginId === "maintain");
}

beforeEach(() => {
  resolve.mockReset().mockResolvedValue(true);
  useWorkspaceLayoutStore.setState({
    layoutByWorkspace: { [workspaceKey]: createDefaultLayout() },
    explorerSidebarPaneIdByWorkspace: {},
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("conditional explorer panel reconciliation", () => {
  it("adds in the background, immediately restores a closed tab, and removes it on agent switch", async () => {
    const { rerender } = renderHook((props) => useConditionalExplorerPanels(props), {
      initialProps: input,
    });
    await waitFor(() => expect(panel()).toBeDefined());
    const store = useWorkspaceLayoutStore.getState();
    const paneId = store.explorerSidebarPaneIdByWorkspace[workspaceKey]!;
    expect(store.layoutByWorkspace[workspaceKey].focusedPaneId).not.toBe(paneId);
    act(() => store.closeTab(workspaceKey, panel()!.tabId));
    await waitFor(() => expect(panel()).toBeDefined());
    resolve.mockResolvedValue(false);
    rerender({ ...input, agentId: "ordinary", botId: "other" });
    await waitFor(() => expect(panel()).toBeUndefined());
  });

  it("keeps an existing panel when a periodic identity lookup fails", async () => {
    vi.useFakeTimers();
    renderHook(() => useConditionalExplorerPanels(input));
    await act(async () => {});
    expect(panel()).toBeDefined();
    resolve.mockRejectedValue(new Error("offline"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(panel()).toBeDefined();
  });
});
