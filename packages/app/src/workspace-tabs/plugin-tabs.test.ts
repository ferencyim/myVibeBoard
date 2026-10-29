import { describe, expect, it } from "vitest";
import {
  collectAllTabs,
  openTabInLayoutBackground,
  createDefaultLayout,
} from "@/stores/workspace-layout-actions";
import { mergePluginWorkspaceTabs, type PluginWorkspaceTabs } from "./plugin-tabs";

function contributions(): PluginWorkspaceTabs[] {
  return [
    {
      pluginId: "board",
      providerId: "roles",
      tabs: [6, 2, 4, 1, 5, 3].map((order) => ({
        id: String(order),
        title: "#" + order,
        order,
        disabled: order === 3,
        agentId: order === 1 ? "main" : undefined,
      })),
    },
  ];
}
function merge(
  layout: Parameters<typeof mergePluginWorkspaceTabs>[0]["layout"],
  entries = contributions(),
) {
  return mergePluginWorkspaceTabs({
    layout,
    contributions: entries,
    cwd: "/repo",
    now: 1,
    explorerSidebarPaneId: null,
  })!;
}

describe("plugin workspace tabs", () => {
  it("shows all six roles without presets or successful provisioning and orders real and placeholder tabs together", () => {
    const layout = merge(null);
    const tabs = collectAllTabs(layout.root);
    expect(tabs).toHaveLength(6);
    expect(
      tabs.map((tab) => (tab.target.kind === "draft" ? tab.target.placeholder?.order : 1)),
    ).toEqual([1, 2, 3, 4, 5, 6]);
    const scout = tabs[2]!.target;
    expect(scout.kind === "draft" && scout.placeholder?.disabled).toBe(true);
    expect(merge(layout)).toBe(layout);
  });

  it("preserves fixed flow metadata when a role is provisioned", () => {
    const entries = contributions();
    entries[0]!.providerId = "task-flow";
    const initial = merge(null, entries);
    entries[0]!.tabs = entries[0]!.tabs.map((tab) =>
      tab.order === 4
        ? Object.assign(tab, { agentId: "worker", title: "#4 执行 · model · 忙碌" })
        : tab,
    );
    const provisioned = merge(initial, entries);
    const target = collectAllTabs(provisioned.root)[3]!.target;
    expect(target.kind === "agent" && target.flowTab?.title).toBe("#4 执行 · model · 忙碌");
    expect(merge(provisioned, entries)).toBe(provisioned);
    entries[0]!.tabs = entries[0]!.tabs.map((tab) =>
      tab.order === 4
        ? Object.assign(tab, { title: "#4 执行 · model · 待审批", disabled: true })
        : tab,
    );
    const updated = collectAllTabs(merge(provisioned, entries).root)[3]!.target;
    expect(updated.kind === "agent" && updated.flowTab?.title).toBe("#4 执行 · model · 待审批");
    expect(updated.kind === "agent" && updated.flowTab?.disabled).toBe(true);
  });

  it("replaces a placeholder with its provisioned agent while preserving six tabs", () => {
    const initial = merge(null);
    const entries = contributions();
    entries[0]!.tabs = entries[0]!.tabs.map((tab) =>
      tab.order === 4 ? Object.assign(tab, { agentId: "worker" }) : tab,
    );
    const layout = merge(initial, entries);
    const tabs = collectAllTabs(layout.root);
    expect(tabs).toHaveLength(6);
    expect(tabs[3]!.target).toEqual({ kind: "agent", agentId: "worker" });
  });

  it("deduplicates an agent auto-opened before its placeholder resolves", () => {
    const initial = merge(null);
    const opened = openTabInLayoutBackground({
      layout: initial,
      target: { kind: "agent", agentId: "worker" },
      now: 2,
      placement: { mode: "ambient" },
      explorerSidebarPaneId: null,
    })!;
    const entries = contributions();
    entries[0]!.tabs = entries[0]!.tabs.map((tab) =>
      tab.order === 4 ? Object.assign(tab, { agentId: "worker" }) : tab,
    );
    expect(collectAllTabs(merge(opened.layout, entries).root)).toHaveLength(6);
  });

  it("keeps a newly created role real while its provider query is still cached", () => {
    const initial = merge(null);
    const opened = openTabInLayoutBackground({
      layout: initial,
      target: { kind: "agent", agentId: "worker" },
      now: 2,
      placement: { mode: "ambient" },
      explorerSidebarPaneId: null,
    })!;
    const layout = mergePluginWorkspaceTabs({
      layout: opened.layout,
      contributions: contributions(),
      cwd: "/repo",
      now: 3,
      explorerSidebarPaneId: null,
      agentTabOrderKeys: new Map([["worker", "4"]]),
    })!;
    const tabs = collectAllTabs(layout.root);
    expect(tabs).toHaveLength(6);
    expect(tabs[3]!.target).toEqual({ kind: "agent", agentId: "worker" });
  });

  it("shows a placeholder until a provisioned agent reaches the active directory", () => {
    const layout = mergePluginWorkspaceTabs({
      layout: null,
      contributions: contributions(),
      cwd: "/repo",
      now: 1,
      explorerSidebarPaneId: null,
      activeAgentIds: new Set(),
    })!;
    const tabs = collectAllTabs(layout.root);
    expect(tabs).toHaveLength(6);
    expect(tabs.every((tab) => tab.target.kind === "draft")).toBe(true);
  });

  it("keeps an unsent placeholder draft mounted after its agent is created", () => {
    const initial = merge(null);
    const worker = collectAllTabs(initial.root)[3]!.target;
    if (worker.kind !== "draft") throw new Error("Expected worker placeholder");
    const entries = contributions();
    entries[0]!.tabs = entries[0]!.tabs.map((tab) =>
      tab.order === 4 ? Object.assign(tab, { agentId: "worker" }) : tab,
    );
    const layout = mergePluginWorkspaceTabs({
      layout: initial,
      contributions: entries,
      cwd: "/repo",
      now: 2,
      explorerSidebarPaneId: null,
      pendingDraftIds: new Set([worker.draftId]),
    })!;
    expect(layout).toBe(initial);
    expect(collectAllTabs(layout.root)[3]!.target.kind).toBe("draft");
  });

  it("leaves ordinary workspaces unchanged when plugins return no roles", () => {
    const layout = createDefaultLayout();
    const originalLayout = structuredClone(layout);
    expect(merge(layout, [])).toBe(layout);
    expect(layout).toEqual(originalLayout);
  });
});
