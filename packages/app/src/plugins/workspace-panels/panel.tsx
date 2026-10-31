import { usePublishPanelInstanceAttributes } from "@/panels/panel-instance-attributes";
import type {
  PluginAgentPanelProps,
  PluginWorkspacePanelProps,
  PluginTab,
} from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { PluginClientStateProvider } from "@getpaseo/plugin/client/host";
import { CircleAlert, GitBranch, Info } from "lucide-react-native";
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import invariant from "tiny-invariant";
import { useIsCompactFormFactor } from "@/constants/layout";
import { usePaneContext } from "@/panels/pane-context";
import { definePanel, type PanelDescriptor } from "@/panels/panel-registry";
import { useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceDirectory, useWorkspaceExists } from "@/stores/session-store-hooks";
import { WorkspaceActions } from "@/git/workspace-actions";
import { WorkspaceOpenInEditorButton } from "@/workspace/open-in-editor/button";
import type { Theme } from "@/styles/theme";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";
import { usePluginHostNavigation } from "../host-navigation";
import { createPluginClientStateSource } from "../client-state/source";
import { toPluginTheme } from "../theme";
import { pluginIconComponent } from "../icons";
import { pluginRegistry, useInstalledPlugin } from "../registry";
import { PluginInstallationProvider } from "../installation-provider";
import { SurfaceErrorBoundary } from "../surface-error-boundary";
import { requiredPanelLabel, resolvePluginWorkspacePanel } from "./resolution";
import { resolvePluginPlatform } from "../platform";

const pluginThemeMapping = (theme: Theme) => ({
  theme: toPluginTheme(theme),
});

function PluginPanelBody({ theme }: { theme: PluginTheme }) {
  const {
    serverId,
    workspaceId,
    target,
    state: tabState,
    setCurrentTabState,
    panelRevision,
  } = usePaneContext();
  const [modified, setModified] = useState(false);
  usePublishPanelInstanceAttributes({ modified });
  const tab = useMemo<PluginTab>(
    () => ({ state: tabState, setState: setCurrentTabState, setModified }),
    [tabState, setCurrentTabState],
  );
  invariant(target.kind === "plugin", "PluginPanel requires plugin target");
  const plugin = useInstalledPlugin(serverId, target.pluginId);
  const contribution = resolvePluginWorkspacePanel(plugin, target);
  const workspaceExists = useWorkspaceExists(serverId, workspaceId);
  const agentExists = useSessionStore((state) => {
    if (target.context !== "agent") return null;
    const session = state.sessions[serverId];
    const agent = session?.agents.get(target.agentId) ?? session?.agentDetails.get(target.agentId);
    return (
      Boolean(agent) &&
      normalizeWorkspaceOpaqueId(agent?.workspaceId) === normalizeWorkspaceOpaqueId(workspaceId)
    );
  });
  const client = useHostRuntimeClient(serverId);
  const compact = useIsCompactFormFactor();
  const hosts = useHosts();
  const hostLabel = hosts.find((host) => host.serverId === serverId)?.label ?? serverId;
  const host = useMemo(() => ({ id: serverId, label: hostLabel }), [hostLabel, serverId]);
  const layout = useMemo(() => ({ compact, platform: resolvePluginPlatform() }), [compact]);
  const stateSource = useMemo(() => createPluginClientStateSource(serverId), [serverId]);
  const navigation = usePluginHostNavigation(serverId);
  const requiredLabel = requiredPanelLabel(target);

  if (!plugin || !contribution || !workspaceExists) {
    if (requiredLabel) {
      let message = "面板加载失败，请检查插件状态。";
      if (!client) message = "主机未连接，请连接后重试。";
      else if (!pluginRegistry.hasCatalog(serverId) || !workspaceExists) message = "正在加载面板…";
      return <PluginPanelUnavailable message={message} />;
    }
    return <PluginPanelUnavailable />;
  }
  if (!client) {
    return (
      <PluginPanelUnavailable
        message={requiredLabel ? "主机未连接，请连接后重试。" : "Plugin host is offline."}
      />
    );
  }

  let panel;
  let Surface: unknown;
  if (contribution.context === "workspace") {
    const props: PluginWorkspacePanelProps = {
      // COMPAT(pluginPanelFlatProps): added in v0.13.0, remove after 2027-04-23
      context: "workspace",
      params: {},
      revision: panelRevision ?? 0,
      tab,
      theme,
      host,
      layout,
      navigation,
      workspaceId,
    };
    const Component = contribution.Component;
    Surface = Component;
    panel = <Component {...props} />;
  } else if (agentExists && target.context === "agent") {
    const props: PluginAgentPanelProps = {
      // COMPAT(pluginPanelFlatProps): added in v0.13.0, remove after 2027-04-23
      context: "agent",
      params: { agentId: target.agentId },
      revision: panelRevision ?? 0,
      tab,
      theme,
      host,
      layout,
      navigation,
      workspaceId,
      // COMPAT(pluginPanelFlatProps): added in v0.13.0, remove after 2027-04-23
      agentId: target.agentId,
    };
    const Component = contribution.Component;
    Surface = Component;
    panel = <Component {...props} />;
  } else {
    return <PluginPanelUnavailable />;
  }

  return (
    <SurfaceErrorBoundary
      installation={plugin}
      Surface={Surface}
      key={`${serverId}/${target.pluginId}/${target.panelId}/${target.context}`}
    >
      <PluginInstallationProvider plugin={plugin}>
        <PluginClientStateProvider source={stateSource}>{panel}</PluginClientStateProvider>
      </PluginInstallationProvider>
    </SurfaceErrorBoundary>
  );
}

const ThemedPluginPanelBody = withUnistyles(PluginPanelBody);

function PluginPanel() {
  const { serverId, workspaceId, target } = usePaneContext();
  const cwd = useWorkspaceDirectory(serverId, workspaceId);
  const isGitPanel =
    target.kind === "plugin" &&
    target.pluginId === "vibe-git" &&
    target.panelId === "git" &&
    target.context === "workspace";
  return (
    <View style={styles.root}>
      {isGitPanel && cwd ? (
        <View style={styles.gitActions}>
          <WorkspaceOpenInEditorButton serverId={serverId} cwd={cwd} source="forge" />
          <WorkspaceActions serverId={serverId} cwd={cwd} />
        </View>
      ) : null}
      <ThemedPluginPanelBody uniProps={pluginThemeMapping} />
    </View>
  );
}

function PluginPanelUnavailable({
  message = "This plugin panel is unavailable.",
}: {
  message?: string;
}) {
  return (
    <View style={styles.unavailable}>
      <Text style={styles.unavailableText}>{message}</Text>
    </View>
  );
}

function usePluginPanelDescriptor(
  target: Extract<import("@/workspace-tabs/model").WorkspaceTabTarget, { kind: "plugin" }>,
  context: { serverId: string },
): PanelDescriptor {
  const plugin = useInstalledPlugin(context.serverId, target.pluginId);
  const panel = plugin?.workspacePanels.find(
    (contribution) => contribution.id === target.panelId && contribution.context === target.context,
  );
  if (!panel) {
    const label = requiredPanelLabel(target);
    if (label) {
      return {
        label,
        subtitle: target.pluginId,
        tooltip: label,
        titleState: "ready",
        icon: label === "Git/构建" ? GitBranch : Info,
        statusBucket: null,
      };
    }
    return {
      label: "Plugin unavailable",
      subtitle: target.pluginId,
      tooltip: "This plugin panel is unavailable",
      titleState: "ready",
      icon: CircleAlert,
      statusBucket: null,
    };
  }
  return {
    label: plugin!.i18n.resolve(panel.title, plugin!.locale),
    subtitle: target.pluginId,
    tooltip: plugin!.i18n.resolve(panel.title, plugin!.locale),
    titleState: "ready",
    icon: pluginIconComponent(panel.icon),
    statusBucket: null,
  };
}

export const pluginPanelRegistration = definePanel("plugin", {
  component: PluginPanel,
  useDescriptor: usePluginPanelDescriptor,
});

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1 },
  gitActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[3],
    backgroundColor: theme.colors.surface0,
  },
  unavailable: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
    backgroundColor: theme.colors.surface0,
  },
  unavailableText: {
    color: theme.colors.foregroundMuted,
  },
}));
