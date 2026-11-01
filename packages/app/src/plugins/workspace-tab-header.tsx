import { useQueryClient } from "@tanstack/react-query";
import { PluginClientStateProvider } from "@getpaseo/plugin/client/host";
import { useCallback, useMemo } from "react";
import { withUnistyles } from "react-native-unistyles";
import type { PluginTheme } from "@getpaseo/plugin";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHosts } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { createPluginClientStateSource } from "./client-state/source";
import { usePluginHostNavigation } from "./host-navigation";
import { PluginInstallationProvider } from "./installation-provider";
import { resolvePluginPlatform } from "./platform";
import { useInstalledPlugins } from "./registry";
import { SurfaceErrorBoundary } from "./surface-error-boundary";
import { toPluginTheme } from "./theme";

function TabControls({
  serverId,
  workspaceId,
  tabId,
  pluginId,
  providerId,
  theme,
}: {
  serverId: string;
  workspaceId: string;
  tabId?: string;
  pluginId?: string;
  providerId?: string;
  theme: PluginTheme;
}) {
  const plugins = useInstalledPlugins();
  const queryClient = useQueryClient();
  const compact = useIsCompactFormFactor();
  const hosts = useHosts();
  const label = hosts.find((host) => host.serverId === serverId)?.label ?? serverId;
  const host = useMemo(() => ({ id: serverId, label }), [serverId, label]);
  const layout = useMemo(() => ({ compact, platform: resolvePluginPlatform() }), [compact]);
  const navigation = usePluginHostNavigation(serverId);
  const source = useMemo(() => createPluginClientStateSource(serverId), [serverId]);
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["plugin-workspace-tabs", serverId] });
  }, [queryClient, serverId]);
  return plugins
    .filter((plugin) => plugin.serverId === serverId && (!pluginId || plugin.id === pluginId))
    .flatMap((plugin) =>
      (plugin.workspaceTabProviders ?? []).flatMap(({ id, HeaderComponent, TabComponent }) => {
        if (providerId && id !== providerId) return [];
        const Component = tabId ? TabComponent : HeaderComponent;
        if (!Component) return [];
        const common = { workspaceId, serverId, refresh, theme, host, layout, navigation };
        return [
          <SurfaceErrorBoundary
            key={`${plugin.id}/${id}`}
            installation={plugin}
            resetKey={workspaceId}
            Surface={Component}
          >
            <PluginInstallationProvider plugin={plugin}>
              <PluginClientStateProvider source={source}>
                {tabId && TabComponent ? <TabComponent {...common} tabId={tabId} /> : null}
                {!(tabId && TabComponent) && HeaderComponent ? (
                  <HeaderComponent {...common} />
                ) : null}
              </PluginClientStateProvider>
            </PluginInstallationProvider>
          </SurfaceErrorBoundary>,
        ];
      }),
    );
}
const ThemedTabControls = withUnistyles(TabControls);
const themeMapping = (theme: Theme) => ({ theme: toPluginTheme(theme) });
export function WorkspaceTabHeader(props: { serverId: string; workspaceId: string }) {
  return <ThemedTabControls {...props} uniProps={themeMapping} />;
}
export function WorkspaceTabControls(props: {
  serverId: string;
  workspaceId: string;
  tabId: string;
  pluginId: string;
  providerId: string;
}) {
  return <ThemedTabControls {...props} uniProps={themeMapping} />;
}
