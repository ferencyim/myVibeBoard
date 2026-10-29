import { useCallback, useMemo, useState } from "react";
import { View } from "react-native";
import { Plus } from "lucide-react-native";
import { IconButton } from "@/ui/icon-button";
import { isNative } from "@/constants/platform";
import { withUnistyles } from "react-native-unistyles";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHosts } from "@/runtime/host-runtime";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import { useInstalledPlugins } from "@/plugins/registry";
import { PluginInstallationProvider } from "@/plugins/installation-provider";
import { SurfaceErrorBoundary } from "@/plugins/surface-error-boundary";
import { usePluginHostNavigation } from "@/plugins/host-navigation";
import { resolvePluginPlatform } from "@/plugins/platform";
import { toPluginTheme } from "@/plugins/theme";
import type { InstalledPlugin } from "@/plugins/types";
import type { Theme } from "@/styles/theme";
import { SidebarSectionHeader } from "./sidebar-section-header";
import { collectSidebarGroups } from "./plugin-sidebar-groups-model";
import { Avatar } from "@/ui/avatar";
import { StatusIndicator } from "@/ui/status-indicator";
import { useSidebarAgentActivity } from "./sidebar-agent-activity";

function Group({
  plugin,
  item,
  label,
  onNavigate,
  theme,
  sidebarCompact,
}: {
  plugin: InstalledPlugin;
  item: NonNullable<InstalledPlugin["sidebarGroups"]>[number];
  label: string;
  onNavigate?: () => void;
  theme: PluginSurfaceProps["theme"];
  sidebarCompact: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [createRequest, setCreateRequest] = useState(0);
  const compact = useIsCompactFormFactor();
  const { agents, requestAgentPreview } = useSidebarAgentActivity(plugin.serverId);
  const navigation = usePluginHostNavigation(plugin.serverId);
  const host = useMemo(() => ({ id: plugin.serverId, label }), [plugin.serverId, label]);
  const layout = useMemo(() => ({ compact, platform: resolvePluginPlatform() }), [compact]);
  const wrappedNavigation = useMemo(
    () => ({
      ...navigation,
      openAgent: (input: Parameters<typeof navigation.openAgent>[0]) => {
        onNavigate?.();
        navigation.openAgent(input);
      },
      openWorkspace: (input: Parameters<typeof navigation.openWorkspace>[0]) => {
        onNavigate?.();
        navigation.openWorkspace(input);
      },
    }),
    [navigation, onNavigate],
  );
  const toggle = useCallback(() => setCollapsed((value) => !value), []);
  const enter = useCallback(() => setHovered(true), []);
  const leave = useCallback(() => setHovered(false), []);
  const clearCreate = useCallback(() => setCreateRequest(0), []);
  const create = useCallback(() => {
    setCollapsed(false);
    setCreateRequest((value) => value + 1);
  }, []);
  const Component = item.Component;
  return (
    <View onPointerEnter={enter} onPointerLeave={leave}>
      <SidebarSectionHeader
        title={plugin.i18n.resolve(item.title, plugin.locale)}
        collapsed={collapsed}
        onToggle={toggle}
      >
        {item.createLabel && (hovered || isNative || compact) ? (
          <IconButton
            label={plugin.i18n.resolve(item.createLabel, plugin.locale)}
            icon={Plus}
            size="xs"
            variant="ghost"
            onPress={create}
          />
        ) : null}
      </SidebarSectionHeader>
      {!collapsed && (
        <SurfaceErrorBoundary installation={plugin} Surface={Component}>
          <PluginInstallationProvider plugin={plugin}>
            <Component
              theme={theme}
              host={host}
              layout={layout}
              navigation={wrappedNavigation}
              sidebarCompact={sidebarCompact}
              createRequest={createRequest}
              onCreateHandled={clearCreate}
              agents={agents}
              requestAgentPreview={requestAgentPreview}
              Avatar={Avatar}
              StatusIndicator={StatusIndicator}
            />
          </PluginInstallationProvider>
        </SurfaceErrorBoundary>
      )}
    </View>
  );
}
const ThemedGroup = withUnistyles(Group);
const themeMapping = (theme: Theme) => ({ theme: toPluginTheme(theme) });

export function PluginSidebarGroups({
  onNavigate,
  sidebarCompact = false,
}: {
  onNavigate?: () => void;
  sidebarCompact?: boolean;
}) {
  const plugins = useInstalledPlugins();
  const hosts = useHosts();
  const hostFilters = useSidebarViewStore((state) => state.hostFilters);
  const groups = collectSidebarGroups(plugins, hostFilters);
  return groups.map(({ plugin, item }) => (
    <ThemedGroup
      key={`${plugin.serverId}:${plugin.id}:${item.id}`}
      plugin={plugin}
      item={item}
      label={hosts.find((host) => host.serverId === plugin.serverId)?.label ?? plugin.serverId}
      onNavigate={onNavigate}
      sidebarCompact={sidebarCompact}
      uniProps={themeMapping}
    />
  ));
}
