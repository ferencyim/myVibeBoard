import type { PluginWorkspaceTabDescriptor } from "@getpaseo/plugin/client";
import {
  collectAllPanes,
  collectAllTabs,
  findPaneById,
  focusTabInLayout,
  convertDraftToAgentInLayout,
  createDefaultLayout,
  openTabInLayoutBackground,
  reorderPaneTabsInLayout,
  replaceTabTargetInLayout,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-actions";
import { workspaceTabTargetsEqual } from "./identity";
import type { WorkspaceTabTarget } from "./model";

export interface PluginWorkspaceTabs {
  pluginId: string;
  providerId: string;
  tabs: readonly PluginWorkspaceTabDescriptor[];
}

interface MergePluginWorkspaceTabsInput {
  layout: WorkspaceLayout | null;
  contributions: readonly PluginWorkspaceTabs[];
  cwd: string;
  now: number;
  explorerSidebarPaneId: string | null;
  agentTabOrderKeys?: ReadonlyMap<string, string>;
  activeAgentIds?: ReadonlySet<string>;
  pendingDraftIds?: ReadonlySet<string>;
}

export function mergePluginWorkspaceTabs(
  input: MergePluginWorkspaceTabsInput,
): WorkspaceLayout | null {
  if (!input.contributions.some((entry) => entry.tabs.length > 0)) return input.layout;
  let layout = input.layout ?? createDefaultLayout();
  const orders = new Map<string, number>();
  const originalFocusedTabId = findPaneById(layout.root, layout.focusedPaneId)?.focusedTabId;
  for (const contribution of input.contributions) {
    for (const descriptor of contribution.tabs) {
      layout = mergeRole(input, layout, contribution, descriptor, orders);
    }
  }
  for (const pane of collectAllPanes(layout.root)) {
    const keyed = pane.tabIds.filter((tabId) => orders.has(tabId));
    const sorted = [...keyed].sort((a, b) => orders.get(a)! - orders.get(b)!);
    if (keyed.every((tabId, index) => tabId === sorted[index])) continue;
    let index = 0;
    const tabIds = pane.tabIds.map((tabId) => (orders.has(tabId) ? sorted[index++]! : tabId));
    layout = reorderPaneTabsInLayout({ layout, paneId: pane.id, tabIds }) ?? layout;
  }
  if (
    originalFocusedTabId &&
    collectAllTabs(layout.root).some((tab) => tab.tabId === originalFocusedTabId)
  ) {
    layout = focusTabInLayout({ layout, tabId: originalFocusedTabId }) ?? layout;
  }
  return layout;
}

function resolveRoleTarget(
  input: MergePluginWorkspaceTabsInput,
  layout: WorkspaceLayout,
  contribution: PluginWorkspaceTabs,
  descriptor: PluginWorkspaceTabDescriptor,
  draftId: string,
): WorkspaceTabTarget {
  const orderedAgent = collectAllTabs(layout.root).find(
    (tab) =>
      tab.target.kind === "agent" &&
      input.agentTabOrderKeys?.get(tab.target.agentId) === String(descriptor.order),
  );
  const resolvedAgentId =
    descriptor.agentId ??
    (orderedAgent?.target.kind === "agent" ? orderedAgent.target.agentId : undefined);
  const agentId =
    resolvedAgentId && (!input.activeAgentIds || input.activeAgentIds.has(resolvedAgentId))
      ? resolvedAgentId
      : undefined;
  let target: WorkspaceTabTarget;
  if (agentId) {
    target = { kind: "agent", agentId };
  } else {
    const setup = descriptor.setup;
    target = {
      kind: "draft",
      draftId,
      placeholder: {
        pluginId: contribution.pluginId,
        providerId: contribution.providerId,
        tabId: descriptor.id,
        title: descriptor.title,
        order: descriptor.order,
        disabled: descriptor.disabled,
      },
      ...(setup
        ? {
            setup: {
              provider: setup.provider,
              model: setup.model ?? null,
              modeId: setup.modeId ?? null,
              thinkingOptionId: setup.thinkingOptionId ?? null,
              cwd: input.cwd,
              featureValues: {},
            },
          }
        : {}),
    };
  }
  return target;
}

function mergeRole(
  input: MergePluginWorkspaceTabsInput,
  initialLayout: WorkspaceLayout,
  contribution: PluginWorkspaceTabs,
  descriptor: PluginWorkspaceTabDescriptor,
  orders: Map<string, number>,
): WorkspaceLayout {
  let layout = initialLayout;
  const draftId = [
    "plugin-tab",
    contribution.pluginId,
    contribution.providerId,
    descriptor.id,
  ].join(":");
  const placeholder = collectAllTabs(layout.root).find(
    (tab) => tab.target.kind === "draft" && tab.target.draftId === draftId,
  );
  if (placeholder && input.pendingDraftIds?.has(draftId)) {
    orders.set(placeholder.tabId, descriptor.order);
    return layout;
  }
  const target = resolveRoleTarget(input, layout, contribution, descriptor, draftId);
  if (placeholder && target.kind === "agent") {
    layout =
      convertDraftToAgentInLayout({
        layout,
        tabId: placeholder.tabId,
        agentId: target.agentId,
        explorerSidebarPaneId: input.explorerSidebarPaneId,
      })?.layout ?? layout;
  }
  const existing = collectAllTabs(layout.root).find((tab) => {
    if (target.kind === "agent")
      return tab.target.kind === "agent" && tab.target.agentId === target.agentId;
    return (
      tab.target.kind === "draft" &&
      target.kind === "draft" &&
      tab.target.draftId === target.draftId
    );
  });
  if (existing) {
    orders.set(existing.tabId, descriptor.order);
    if (!workspaceTabTargetsEqual(existing.target, target)) {
      layout =
        replaceTabTargetInLayout({
          layout,
          tabId: existing.tabId,
          target,
          createTabId: () => existing.tabId,
        })?.layout ?? layout;
    }
    return layout;
  }
  const opened = openTabInLayoutBackground({
    layout,
    target,
    now: input.now,
    placement: { mode: "ambient" },
    explorerSidebarPaneId: input.explorerSidebarPaneId,
  });
  if (opened) {
    layout = opened.layout;
    orders.set(opened.tabId, descriptor.order);
  }
  return layout;
}
