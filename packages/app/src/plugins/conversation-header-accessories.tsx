import { PluginClientStateProvider } from "@getpaseo/plugin/client/host";
import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo } from "react";
import { withUnistyles } from "react-native-unistyles";
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

const pluginThemeMapping = (theme: Theme) => ({ theme: toPluginTheme(theme), tokens: theme });

function Accessories({
  serverId,
  agentId,
  theme,
  tokens,
}: {
  serverId: string;
  agentId: string;
  theme: PluginTheme;
  tokens: Pick<Theme, "spacing" | "borderWidth" | "opacity" | "fontSize">;
}) {
  const plugins = useInstalledPlugins();
  const compact = useIsCompactFormFactor();
  const hosts = useHosts();
  const label = hosts.find((host) => host.serverId === serverId)?.label ?? serverId;
  const source = useMemo(() => createPluginClientStateSource(serverId), [serverId]);
  const navigation = usePluginHostNavigation(serverId);
  const host = useMemo(() => ({ id: serverId, label }), [serverId, label]);
  const layout = useMemo(() => ({ compact, platform: resolvePluginPlatform() }), [compact]);
  return (
    <>
      {plugins
        .filter((plugin) => plugin.serverId === serverId)
        .flatMap((plugin) =>
          (plugin.conversationHeaderAccessories ?? []).map(({ id, Component }) => (
            <SurfaceErrorBoundary
              key={`${plugin.id}/${id}`}
              installation={plugin}
              resetKey={agentId}
              Surface={Component}
            >
              <PluginInstallationProvider plugin={plugin}>
                <PluginClientStateProvider source={source}>
                  <Component
                    agentId={agentId}
                    theme={theme}
                    tokens={tokens}
                    host={host}
                    layout={layout}
                    navigation={navigation}
                  />
                </PluginClientStateProvider>
              </PluginInstallationProvider>
            </SurfaceErrorBoundary>
          )),
        )}
    </>
  );
}
const ThemedAccessories = withUnistyles(Accessories);
export function ConversationHeaderAccessories(props: { serverId: string; agentId: string }) {
  return <ThemedAccessories {...props} uniProps={pluginThemeMapping} />;
}
