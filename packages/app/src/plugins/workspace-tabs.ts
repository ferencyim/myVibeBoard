import { useEffect, useMemo, useRef } from "react";
import { useFetchQueries } from "@/data/query";
import type { PluginWorkspaceTabDescriptor } from "@getpaseo/plugin/client";
import { useInstalledPlugins } from "./registry";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { mergePluginWorkspaceTabs, type PluginWorkspaceTabs } from "@/workspace-tabs/plugin-tabs";

const EMPTY_TABS: readonly PluginWorkspaceTabDescriptor[] = [];

export function usePluginWorkspaceTabs(input: {
  serverId: string;
  workspaceId: string;
  workspaceKey: string | null;
  cwd: string | null;
  enabled: boolean;
  isRouteFocused: boolean;
  hasHydratedAgents: boolean;
  agentTabOrderKeys?: ReadonlyMap<string, string>;
  activeAgentIds?: ReadonlySet<string>;
}) {
  const enabled = input.enabled && input.isRouteFocused;
  const activeAgentIds = input.hasHydratedAgents ? input.activeAgentIds : undefined;
  const plugins = useInstalledPlugins();
  const pendingByDraftId = useCreateFlowStore((state) => state.pendingByDraftId);
  const pendingDraftIds = useMemo(
    () =>
      new Set(
        Object.values(pendingByDraftId)
          .filter((pending) => pending.serverId === input.serverId && pending.lifecycle !== "sent")
          .map((pending) => pending.draftId),
      ),
    [pendingByDraftId, input.serverId],
  );
  const providers = useMemo(
    () =>
      plugins
        .filter((plugin) => plugin.serverId === input.serverId)
        .flatMap((plugin) =>
          (plugin.workspaceTabProviders ?? []).map((provider) => ({ plugin, provider })),
        ),
    [plugins, input.serverId],
  );
  const queries = useFetchQueries(
    providers.map(({ plugin, provider }) => ({
      queryKey: [
        "plugin-workspace-tabs",
        plugin.serverId,
        plugin.id,
        provider.id,
        input.workspaceId,
      ],
      queryFn: () => provider.resolve({ workspaceId: input.workspaceId }),
      dataShape: "list",
      staleTimeMs: 5000,
      enabled,
      refetchInterval: 5000,
    })),
  );
  const contributionsRef = useRef<PluginWorkspaceTabs[]>([]);
  const contributions = useMemo(() => {
    const next = providers.map(({ plugin, provider }, index) => ({
      pluginId: plugin.id,
      providerId: provider.id,
      tabs: queries[index]?.data ?? EMPTY_TABS,
    }));
    const previous = contributionsRef.current;
    const unchanged =
      next.length === previous.length &&
      next.every((entry, index) => {
        const cached = previous[index]!;
        return (
          entry.pluginId === cached.pluginId &&
          entry.providerId === cached.providerId &&
          entry.tabs === cached.tabs
        );
      });
    return unchanged ? previous : next;
  }, [providers, queries]);
  useEffect(() => {
    contributionsRef.current = contributions;
  }, [contributions]);
  const layout = useWorkspaceLayoutStore((state) =>
    input.workspaceKey ? state.layoutByWorkspace[input.workspaceKey] : undefined,
  );
  useEffect(() => {
    if (!enabled || !input.workspaceKey || !input.cwd) return;
    const workspaceKey = input.workspaceKey;
    const cwd = input.cwd;
    useWorkspaceLayoutStore.setState((state) => {
      const previous = state.layoutByWorkspace[workspaceKey] ?? null;
      const next = mergePluginWorkspaceTabs({
        layout: previous,
        contributions,
        cwd,
        pendingDraftIds,
        agentTabOrderKeys: input.agentTabOrderKeys,
        activeAgentIds,
        now: Date.now(),
        explorerSidebarPaneId: state.explorerSidebarPaneIdByWorkspace[workspaceKey] ?? null,
      });
      if (!next || previous === next) return state;
      return { layoutByWorkspace: { ...state.layoutByWorkspace, [workspaceKey]: next } };
    });
  }, [
    enabled,
    input.workspaceKey,
    input.cwd,
    contributions,
    layout,
    pendingDraftIds,
    input.agentTabOrderKeys,
    activeAgentIds,
  ]);
}
