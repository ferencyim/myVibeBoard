import type { PluginProjectSidebarItemProps } from "@getpaseo/plugin/client";
import { useCallback } from "react";
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
const ThemedProjectItem = withUnistyles(ProjectItem);
const themeMapping = (theme: Theme) => ({ theme: toPluginTheme(theme) });

export function PluginProjectSidebarItems({
  hosts,
  preferredServerId,
  onNavigate,
}: {
  hosts: readonly { serverId: string; projectId: string }[];
  preferredServerId?: string | null;
  onNavigate?: () => void;
}) {
  const plugins = useInstalledPlugins();
  return collectProjectSidebarItems(plugins, hosts, preferredServerId).map(
    ({ plugin, item, projectId }) => (
      <ThemedProjectItem
        key={`${plugin.serverId}:${projectId}:${plugin.id}:${item.id}`}
        plugin={plugin}
        item={item}
        projectId={projectId}
        onNavigate={onNavigate}
        uniProps={themeMapping}
      />
    ),
  );
}
