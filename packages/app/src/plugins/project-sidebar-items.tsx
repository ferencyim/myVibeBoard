import type { PluginProjectSidebarItemProps } from "@getpaseo/plugin/client";
import { useCallback, useMemo } from "react";
import { withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { Theme } from "@/styles/theme";
import { useInstalledPlugins } from "./registry";
import { PluginInstallationProvider } from "./installation-provider";
import { SurfaceErrorBoundary } from "./surface-error-boundary";
import { toPluginTheme } from "./theme";
import { usePluginHostNavigation } from "./host-navigation";
import type { InstalledPlugin } from "./types";

import { collectProjectSidebarItems } from "./project-sidebar-items-model";
import { useSidebarAgentActivity } from "@/components/sidebar/sidebar-agent-activity";
import { Avatar } from "@/ui/avatar";
import { StatusIndicator } from "@/ui/status-indicator";
import { resolvePluginPlatform } from "./platform";

function ProjectItem({
  plugin,
  item,
  projectId,
  theme,
  onNavigate,
}: {
  plugin: InstalledPlugin;
  item: NonNullable<InstalledPlugin["projectSidebarItems"]>[number];
  projectId: string;
  theme: PluginProjectSidebarItemProps["theme"];
  onNavigate?: () => void;
}) {
  const navigation = usePluginHostNavigation(plugin.serverId);
  const compact = useIsCompactFormFactor();
  const Component = item.Component;
  const openAgent = useCallback(
    (agentId: string) => {
      onNavigate?.();
      navigation.openAgent({ agentId });
    },
    [navigation, onNavigate],
  );
  return (
    <SurfaceErrorBoundary installation={plugin} Surface={Component} resetKey={projectId}>
      <PluginInstallationProvider plugin={plugin}>
        <Component
          projectId={projectId}
          serverId={plugin.serverId}
          theme={theme}
          compact={compact}
          openAgent={openAgent}
        />
      </PluginInstallationProvider>
    </SurfaceErrorBoundary>
  );
}
function ProjectGroup({
  plugin,
  item,
  projectId,
  theme,
  onNavigate,
  sidebarCompact,
  createRequest,
  onCreateHandled,
}: {
  plugin: InstalledPlugin;
  item: NonNullable<InstalledPlugin["projectSidebarGroups"]>[number];
  projectId: string;
  theme: PluginProjectSidebarItemProps["theme"];
  onNavigate?: () => void;
  sidebarCompact: boolean;
  createRequest?: number;
  onCreateHandled?: () => void;
}) {
  const navigation = usePluginHostNavigation(plugin.serverId);
  const compact = useIsCompactFormFactor();
  const { agents, requestAgentPreview } = useSidebarAgentActivity(plugin.serverId);
  const host = useMemo(() => ({ id: plugin.serverId, label: plugin.serverId }), [plugin.serverId]);
  const layout = useMemo(() => ({ compact, platform: resolvePluginPlatform() }), [compact]);
  const wrappedNavigation = useMemo(
    () => ({
      ...navigation,
      openAgent: (input: Parameters<typeof navigation.openAgent>[0]) => {
        onNavigate?.();
        navigation.openAgent(input);
      },
    }),
    [navigation, onNavigate],
  );
  const Component = item.Component;
  return (
    <SurfaceErrorBoundary installation={plugin} Surface={Component} resetKey={projectId}>
      <PluginInstallationProvider plugin={plugin}>
        <Component
          projectId={projectId}
          theme={theme}
          host={host}
          layout={layout}
          navigation={wrappedNavigation}
          sidebarCompact={sidebarCompact}
          createRequest={createRequest}
          onCreateHandled={onCreateHandled}
          agents={agents}
          requestAgentPreview={requestAgentPreview}
          Avatar={Avatar}
          StatusIndicator={StatusIndicator}
        />
      </PluginInstallationProvider>
    </SurfaceErrorBoundary>
  );
}
const ThemedProjectGroup = withUnistyles(ProjectGroup);
const ThemedProjectItem = withUnistyles(ProjectItem);
const themeMapping = (theme: Theme) => ({ theme: toPluginTheme(theme) });

export function PluginProjectSidebarItems({
  hosts,
  preferredServerId,
  onNavigate,
  sidebarCompact = false,
  createRequest,
  onCreateHandled,
}: {
  hosts: readonly { serverId: string; projectId: string }[];
  preferredServerId?: string | null;
  onNavigate?: () => void;
  sidebarCompact?: boolean;
  createRequest?: number;
  onCreateHandled?: () => void;
}) {
  const plugins = useInstalledPlugins();
  const groups = collectProjectSidebarItems(
    plugins.map((plugin) => ({
      id: plugin.id,
      serverId: plugin.serverId,
      original: plugin,
      projectSidebarItems: plugin.projectSidebarGroups,
    })),
    hosts,
    preferredServerId,
  );
  const legacy = collectProjectSidebarItems(plugins, hosts, preferredServerId);
  return (
    <>
      {groups.map(({ plugin, item, projectId }) => (
        <ThemedProjectGroup
          key={`${plugin.serverId}:${projectId}:${plugin.id}:${item.id}`}
          plugin={plugin.original}
          item={item}
          projectId={projectId}
          onNavigate={onNavigate}
          sidebarCompact={sidebarCompact}
          createRequest={createRequest}
          onCreateHandled={onCreateHandled}
          uniProps={themeMapping}
        />
      ))}
      {legacy.map(({ plugin, item, projectId }) => (
        <ThemedProjectItem
          key={`${plugin.serverId}:${projectId}:${plugin.id}:${item.id}`}
          plugin={plugin}
          item={item}
          projectId={projectId}
          onNavigate={onNavigate}
          uniProps={themeMapping}
        />
      ))}
    </>
  );
}
