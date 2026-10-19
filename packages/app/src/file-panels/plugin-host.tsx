import { useMemo } from "react";
import type { PluginFilePanelProps } from "@getpaseo/plugin/client";
import { PluginClientStateProvider } from "@getpaseo/plugin/client/host";
import type { PluginTheme } from "@getpaseo/plugin";
import { withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { usePaneContext } from "@/panels/pane-context";
import { useHosts } from "@/runtime/host-runtime";
import { createPluginClientStateSource } from "@/plugins/client-state/source";
import { usePluginHostNavigation } from "@/plugins/host-navigation";
import { PluginInstallationProvider } from "@/plugins/installation-provider";
import { SurfaceErrorBoundary } from "@/plugins/surface-error-boundary";
import { resolvePluginPlatform } from "@/plugins/platform";
import { toPluginTheme } from "@/plugins/theme";
import { buildAbsoluteExplorerPath } from "@/utils/explorer-paths";
import type { Theme } from "@/styles/theme";
import type { ExplorerFile } from "@/stores/session-store";
import type { WorkspaceFileLocation } from "@/workspace/file-open";
import { filePanelExtension } from "./resolve";
import type { PluginFilePanel } from "./panels";

interface Props {
  workspaceRoot: string;
  panel: PluginFilePanel;
  preview: ExplorerFile;
  location: WorkspaceFileLocation;
  navigationRevision: number;
  document: PluginFilePanelProps["document"];
}
function PluginHost({
  workspaceRoot,
  panel,
  preview,
  location,
  navigationRevision,
  document,
  theme,
}: Props & { theme: PluginTheme }) {
  const { workspaceId } = usePaneContext();
  const { plugin, contribution } = panel;
  const serverId = plugin.serverId;
  const compact = useIsCompactFormFactor();
  const hosts = useHosts();
  const navigation = usePluginHostNavigation(serverId);
  const stateSource = useMemo(() => createPluginClientStateSource(serverId), [serverId]);
  const hostLabel = hosts.find((host) => host.serverId === serverId)?.label ?? serverId;
  const host = useMemo(() => ({ id: serverId, label: hostLabel }), [serverId, hostLabel]);
  const layout = useMemo(() => ({ compact, platform: resolvePluginPlatform() }), [compact]);
  const file = useMemo(
    () => ({
      path: buildAbsoluteExplorerPath({ workspaceRoot, entryPath: location.path }),
      name: location.path.split(/[\\/]/).pop() ?? "",
      extension: filePanelExtension(location.path),
      mimeType: preview.mimeType ?? "application/octet-stream",
      size: preview.size,
      modifiedAt: preview.modifiedAt,
      lineStart: location.lineStart,
      lineEnd: location.lineEnd,
    }),
    [
      workspaceRoot,
      location.path,
      location.lineStart,
      location.lineEnd,
      preview.mimeType,
      preview.size,
      preview.modifiedAt,
    ],
  );
  const Component = contribution.Component;
  return (
    <SurfaceErrorBoundary installation={plugin} Surface={Component} key={panel.id}>
      <PluginInstallationProvider plugin={plugin}>
        <PluginClientStateProvider source={stateSource}>
          <Component
            theme={theme}
            host={host}
            layout={layout}
            navigation={navigation}
            workspaceId={workspaceId}
            navigationRevision={navigationRevision}
            document={document}
            file={file}
          />
        </PluginClientStateProvider>
      </PluginInstallationProvider>
    </SurfaceErrorBoundary>
  );
}
const ThemedHost = withUnistyles(PluginHost);
const themeMapping = (theme: Theme) => ({ theme: toPluginTheme(theme) });
export function PluginFilePanelHost(props: Props) {
  return <ThemedHost {...props} uniProps={themeMapping} />;
}
