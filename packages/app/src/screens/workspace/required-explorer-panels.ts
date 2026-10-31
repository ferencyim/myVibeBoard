import { useEffect, useRef, useState } from "react";
import { useInstalledPlugins } from "@/plugins/registry";
import {
  collectAllTabs,
  findPaneById,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import type { WorkspaceTab, PluginWorkspaceTabTarget } from "@/workspace-tabs/model";

export function requiredExplorerTargets(input: {
  isTask: boolean;
  botAgentId: string | null;
}): PluginWorkspaceTabTarget[] {
  if (!input.isTask && !input.botAgentId) return [];
  return [
    { kind: "plugin", pluginId: "vibe-git", panelId: "git", context: "workspace" },
    input.isTask
      ? { kind: "plugin", pluginId: "vibe-board", panelId: "task-info", context: "workspace" }
      : {
          kind: "plugin",
          pluginId: "vibe-bots",
          panelId: "profile",
          context: "agent",
          agentId: input.botAgentId!,
        },
  ];
}

/** Add required panels without opening the dock or changing its active tab. */
export function useRequiredExplorerPanels(input: {
  workspaceKey: string | null;
  enabled: boolean;
  isTask: boolean;
  botAgentId: string | null;
}) {
  const { workspaceKey, enabled, isTask, botAgentId } = input;
  const layout = useWorkspaceLayoutStore((state) =>
    workspaceKey ? state.layoutByWorkspace[workspaceKey] : undefined,
  );
  const paneId = useWorkspaceLayoutStore((state) =>
    workspaceKey ? state.explorerSidebarPaneIdByWorkspace[workspaceKey] : undefined,
  );
  useEffect(() => {
    if (!enabled || !workspaceKey || !layout) return;
    const targets = requiredExplorerTargets({ isTask, botAgentId });
    if (!targets.length) return;
    const store = useWorkspaceLayoutStore.getState();
    const explorerId = paneId ?? store.ensureExplorerSidebar(workspaceKey);
    if (!explorerId) return;
    const pane = findPaneById(store.layoutByWorkspace[workspaceKey].root, explorerId);
    const existing = collectAllTabs(store.layoutByWorkspace[workspaceKey].root);
    for (const target of targets) {
      const match = existing.find(
        ({ target: current }) =>
          current.kind === "plugin" &&
          current.pluginId === target.pluginId &&
          current.panelId === target.panelId &&
          current.context === target.context &&
          (current.context !== "agent" ||
            (target.context === "agent" && current.agentId === target.agentId)),
      );
      if (match) {
        if (!pane?.tabIds.includes(match.tabId))
          store.moveTabToPane(workspaceKey, match.tabId, explorerId);
        continue;
      }
      store.openTab({
        workspaceKey,
        target,
        intent: "background",
        placement: { mode: "pane", paneId: explorerId },
      });
    }
  }, [enabled, workspaceKey, layout, paneId, isTask, botAgentId]);
}

export function conditionalPanelMatches(
  result: boolean | null,
  previouslyRequired: boolean,
): boolean {
  return result === true || (result === null && previouslyRequired);
}

export function shouldRemoveConditionalPanel(input: {
  targetAgentId: string;
  agentId: string | null;
  key: string;
  desired: readonly string[];
  pending: boolean;
}): boolean {
  return (
    input.targetAgentId !== input.agentId || (!input.pending && !input.desired.includes(input.key))
  );
}

function isMatchingAgentPanel(tab: WorkspaceTab, agentId: string | null, key: string): boolean {
  const target = tab.target;
  return (
    target.kind === "plugin" &&
    target.context === "agent" &&
    target.agentId === agentId &&
    `${target.pluginId}/${target.panelId}` === key
  );
}

function isManagedAgentPanel(tab: WorkspaceTab, managed: Set<string>): boolean {
  const target = tab.target;
  return (
    target.kind === "plugin" &&
    target.context === "agent" &&
    (Boolean(target.required) || managed.has(`${target.pluginId}/${target.panelId}`))
  );
}

/** Reconcile plugin-declared conditional panels without selecting them. */
export function useConditionalExplorerPanels(input: {
  serverId: string;
  workspaceKey: string | null;
  enabled: boolean;
  agentId: string | null;
  botId?: string;
}) {
  const { serverId, workspaceKey, enabled, agentId, botId } = input;
  const plugins = useInstalledPlugins();
  const layout = useWorkspaceLayoutStore((state) =>
    workspaceKey ? state.layoutByWorkspace[workspaceKey] : undefined,
  );
  const paneId = useWorkspaceLayoutStore((state) =>
    workspaceKey ? state.explorerSidebarPaneIdByWorkspace[workspaceKey] : undefined,
  );
  const managed = useRef(new Set<string>());
  const [pending, setPending] = useState(true);
  const [resolved, setResolved] = useState<{
    agentId: string | null;
    botId?: string;
    keys: string[];
  }>({ agentId: null, keys: [] });
  useEffect(() => {
    if (!enabled || !workspaceKey) return;
    const currentWorkspaceKey = workspaceKey;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const panels = plugins
      .filter((plugin) => plugin.serverId === serverId)
      .flatMap((plugin) =>
        plugin.workspacePanels
          .filter(
            (panel) =>
              panel.context === "agent" &&
              panel.requiredForAgent &&
              panel.locations.includes("explorer"),
          )
          .map((panel) => ({ plugin, panel, key: `${plugin.id}/${panel.id}` })),
      );
    for (const panel of panels) managed.current.add(panel.key);
    setPending(true);
    async function resolve() {
      const matches = await Promise.all(
        panels.map(async ({ plugin, panel }) => {
          if (!agentId) return false;
          try {
            return await panel.requiredForAgent!({ agentId, botId, paseo: plugin.paseo });
          } catch {
            return null;
          }
        }),
      );
      if (cancelled) return;
      const current = useWorkspaceLayoutStore.getState().layoutByWorkspace[currentWorkspaceKey];
      const persistedTabs = current
        ? collectAllTabs(current.root).filter(
            (tab) =>
              tab.target.kind === "plugin" && tab.target.context === "agent" && tab.target.required,
          )
        : [];
      const persistedKeys = new Set(
        panels
          .filter(({ key }) => persistedTabs.some((tab) => isMatchingAgentPanel(tab, agentId, key)))
          .map(({ key }) => key),
      );
      setResolved((previous) => ({
        agentId,
        botId,
        keys: panels.flatMap(({ key }, i) => {
          const persisted = persistedKeys.has(key);
          return conditionalPanelMatches(
            matches[i],
            Boolean(
              (previous.agentId === agentId &&
                previous.botId === botId &&
                previous.keys.includes(key)) ||
              (previous.agentId === null && persisted),
            ),
          )
            ? [key]
            : [];
        }),
      }));
      setPending(false);
      timer = setTimeout(resolve, 15_000);
    }
    void resolve();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [serverId, workspaceKey, enabled, agentId, botId, plugins]);
  useEffect(() => {
    if (!enabled || !workspaceKey || !layout) return;
    const desired =
      resolved.agentId === agentId && resolved.botId === botId && agentId ? resolved.keys : [];
    const store = useWorkspaceLayoutStore.getState();
    const existing = collectAllTabs(layout.root);
    for (const tab of existing) {
      const target = tab.target;
      if (
        target.kind !== "plugin" ||
        target.context !== "agent" ||
        !isManagedAgentPanel(tab, managed.current)
      )
        continue;
      if (
        shouldRemoveConditionalPanel({
          targetAgentId: target.agentId,
          agentId,
          key: `${target.pluginId}/${target.panelId}`,
          desired,
          pending,
        })
      )
        store.closeTab(workspaceKey, tab.tabId);
    }
    if (!desired.length || !agentId) return;
    const explorerId = paneId ?? store.ensureExplorerSidebar(workspaceKey);
    if (!explorerId) return;
    const pane = findPaneById(store.layoutByWorkspace[workspaceKey].root, explorerId);
    for (const key of desired) {
      const [pluginId, panelId] = key.split("/");
      const match = existing.find(
        ({ target }) =>
          target.kind === "plugin" &&
          target.context === "agent" &&
          target.pluginId === pluginId &&
          target.panelId === panelId &&
          target.agentId === agentId,
      );
      if (match) {
        if (!pane?.tabIds.includes(match.tabId))
          store.moveTabToPane(workspaceKey, match.tabId, explorerId);
      } else {
        store.openTab({
          workspaceKey,
          target: { kind: "plugin", pluginId, panelId, context: "agent", agentId, required: true },
          intent: "background",
          placement: { mode: "pane", paneId: explorerId },
        });
      }
    }
  }, [enabled, workspaceKey, layout, paneId, agentId, botId, resolved, pending]);
}
