import { PluginClientStateProvider } from "@getpaseo/plugin/client/host";
import type { PluginConversationPanelProps } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { BottomSheetView } from "@gorhom/bottom-sheet";
import { useCallback, useMemo } from "react";
import { View } from "react-native";
import { Button } from "@/components/ui/button";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  IsolatedBottomSheetModal,
  useIsolatedBottomSheetVisibility,
} from "@/components/ui/isolated-bottom-sheet-modal";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHosts } from "@/runtime/host-runtime";
import { taskConversationKey, useTaskConversationStore } from "@/task-conversations/store";
import { useTaskConversationSelectionStore } from "@/composer/task-conversation-selection";
import type { Theme } from "@/styles/theme";
import { createPluginClientStateSource } from "../client-state/source";
import { usePluginHostNavigation } from "../host-navigation";
import { PluginInstallationProvider } from "../installation-provider";
import { resolvePluginPlatform } from "../platform";
import { useInstalledPlugins } from "../registry";
import { SurfaceErrorBoundary } from "../surface-error-boundary";
import { toPluginTheme } from "../theme";
import { useConversationPanelStore } from "./conversation-state";
import { isPluginConversationPanel } from "./resolution";

export interface PluginConversationPanelsProps {
  serverId: string;
  workspaceId: string;
  conversationId: string;
  anchorAgentId: string | null;
  title?: string;
}

const SNAP_POINTS = ["85%"];
const themeMapping = (theme: Theme) => ({ theme: toPluginTheme(theme) });
const Sheet = withUnistyles(IsolatedBottomSheetModal, (theme) => ({
  backgroundStyle: { backgroundColor: theme.colors.surface0 },
  handleIndicatorStyle: { backgroundColor: theme.colors.foregroundMuted },
}));

function PanelTrigger({
  conversationKey,
  pluginId,
  panelId,
  title,
  expanded,
}: {
  conversationKey: string;
  pluginId: string;
  panelId: string;
  title: string;
  expanded: boolean;
}) {
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  const toggle = useCallback(() => {
    const store = useConversationPanelStore.getState();
    if (expanded) store.close(conversationKey);
    else store.open(conversationKey, { pluginId, panelId });
  }, [conversationKey, pluginId, panelId, expanded]);
  return (
    <Button
      size="sm"
      variant="ghost"
      accessibilityLabel={title}
      accessibilityState={accessibilityState}
      onPress={toggle}
    >
      {title}
    </Button>
  );
}

function ConversationPanelBody({
  theme,
  ...input
}: PluginConversationPanelsProps & { theme: PluginTheme }) {
  const compact = useIsCompactFormFactor();
  const active = useRetainedPanelActive();
  const key = taskConversationKey(input.serverId, input.conversationId);
  const conversation = useTaskConversationStore((state) => state.conversations.get(key) ?? null);
  const recipient = useTaskConversationSelectionStore(
    (state) => state.selections.get(key)?.recipient ?? null,
  );
  const selection = useConversationPanelStore((state) => state.selections.get(key) ?? null);
  const installed = useInstalledPlugins();
  const panels = installed
    .filter((plugin) => plugin.serverId === input.serverId)
    .flatMap((plugin) =>
      plugin.workspacePanels
        .filter((panel) => isPluginConversationPanel(panel))
        .map((panel) => ({ plugin, panel })),
    );
  const selected = panels.find(
    ({ plugin, panel }) => plugin.id === selection?.pluginId && panel.id === selection.panelId,
  );
  const close = useCallback(() => useConversationPanelStore.getState().close(key), [key]);
  const { sheetRef, handleSheetChange, handleSheetDismiss } = useIsolatedBottomSheetVisibility({
    visible: active && compact && Boolean(selected),
    isEnabled: compact,
    onClose: close,
  });
  const hosts = useHosts();
  const hostLabel = hosts.find((host) => host.serverId === input.serverId)?.label ?? input.serverId;
  const host = useMemo(
    () => ({ id: input.serverId, label: hostLabel }),
    [input.serverId, hostLabel],
  );
  const layout = useMemo(() => ({ compact, platform: resolvePluginPlatform() }), [compact]);
  const navigation = usePluginHostNavigation(input.serverId, selected?.plugin);
  const stateSource = useMemo(
    () => createPluginClientStateSource(input.serverId),
    [input.serverId],
  );

  const belongsToConversation =
    conversation?.workspaceId === input.workspaceId &&
    conversation.anchorAgentId === input.anchorAgentId;
  if (!belongsToConversation || panels.length === 0) return null;

  let content = null;
  if (selected && isPluginConversationPanel(selected.panel)) {
    const Component = selected.panel.Component;
    const props: PluginConversationPanelProps = {
      context: "agent",
      theme,
      host,
      layout,
      navigation,
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      anchorAgentId: input.anchorAgentId,
      recipient,
      agentId: input.anchorAgentId ?? undefined,
    };
    content = (
      <SurfaceErrorBoundary installation={selected.plugin} Surface={Component}>
        <PluginInstallationProvider plugin={selected.plugin}>
          <PluginClientStateProvider source={stateSource}>
            <Component {...props} />
          </PluginClientStateProvider>
        </PluginInstallationProvider>
      </SurfaceErrorBoundary>
    );
  }

  const controls = (
    <View style={styles.controls}>
      {panels.map(({ plugin, panel }) => (
        <PanelTrigger
          key={`${plugin.id}/${panel.id}`}
          conversationKey={key}
          pluginId={plugin.id}
          panelId={panel.id}
          title={input.title ?? panel.title}
          expanded={selected?.panel === panel}
        />
      ))}
    </View>
  );
  if (compact) {
    return (
      <View>
        {controls}
        <Sheet
          ref={sheetRef}
          contextBridge={null}
          snapPoints={SNAP_POINTS}
          enableDynamicSizing={false}
          enablePanDownToClose
          backdropOpacity={0.45}
          onChange={handleSheetChange}
          onDismiss={handleSheetDismiss}
        >
          <BottomSheetView style={styles.sheet}>{content}</BottomSheetView>
        </Sheet>
      </View>
    );
  }
  return (
    <View style={selected ? styles.sidebar : styles.collapsed}>
      {controls}
      {content}
    </View>
  );
}

const ThemedConversationPanelBody = withUnistyles(ConversationPanelBody);

export function PluginConversationPanels(props: PluginConversationPanelsProps) {
  return <ThemedConversationPanelBody {...props} uniProps={themeMapping} />;
}

const styles = StyleSheet.create((theme) => ({
  sidebar: {
    width: 340,
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  collapsed: { alignSelf: "flex-start" },
  controls: {
    flexDirection: "row",
    flexWrap: "wrap",
    padding: theme.spacing[2],
    gap: theme.spacing[2],
  },
  sheet: { flex: 1 },
}));
