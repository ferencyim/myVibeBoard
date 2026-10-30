import { useCallback, useMemo, useState } from "react";
import { Ellipsis, PanelRight, Settings2 } from "lucide-react-native";
import { Text, View, type LayoutChangeEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { z } from "zod";
import { useAgentDescriptor } from "@/agent-presentation";
import { AgentControls, LiveAgentModeControl } from "@/composer/agent-controls";
import { ComposerKeyboardScopeProvider, useComposerScopeState } from "@/composer/keyboard-scope";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useFetchQuery } from "@/data/query";
import { createPluginNavigation } from "@/plugins/navigation";
import { botSnapshotCache, useInstalledPlugin } from "@/plugins/registry";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useConversationHeaderSlots } from "@/panels/conversation-header-slots";
import { conversationControlsPlacement } from "@/panels/conversation-controls-placement";
import {
  collectAllTabs,
  findPaneById,
  selectExplorerSidebarPaneId,
  selectIsExplorerSidebarVisible,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { Avatar } from "@/ui/avatar";
import { IconButton } from "@/ui/icon-button";
import { ConversationHeaderAccessories } from "@/plugins/conversation-header-accessories";
import { useSessionStore } from "@/stores/session-store";

const botListSchema = z.object({
  bots: z.array(
    z.object({
      id: z.string(),
      mainAgentId: z.string().nullable(),
      name: z.string(),
      title: z.string(),
      avatarSeed: z.string(),
      avatarHue: z.number(),
    }),
  ),
});

export function findConversationBot<T extends { id?: string; mainAgentId: string | null }>(
  bots: T[],
  agentId: string,
  botId?: string,
) {
  return bots.find((bot) => bot.mainAgentId === agentId || (botId && bot.id === botId));
}

export function useConversationBot(serverId: string, agentId: string) {
  const botId = useSessionStore((state) => {
    const session = state.sessions[serverId];
    return (session?.agents.get(agentId) ?? session?.agentDetails.get(agentId))?.labels?.[
      "vibe.bot"
    ];
  });
  const client = useHostRuntimeClient(serverId);
  const plugin = useInstalledPlugin(serverId, "vibe-bots");
  const query = useFetchQuery(
    {
      queryKey: conversationBotQueryKey(serverId),
      enabled: Boolean(plugin),
      dataShape: "value",
      staleTimeMs: 15000,
      queryFn: async () => {
        try {
          if (!client) throw new Error("offline");
          const result = await client.invokePluginRpc("vibe-bots", "bots.list", {});
          void botSnapshotCache.received(serverId, {}, result).catch(() => {});
          return botListSchema.parse(result).bots;
        } catch {
          return botListSchema.parse(
            await botSnapshotCache.read(serverId, "vibe-bots", "bots.list", {}),
          ).bots;
        }
      },
      retry: false,
    },
    plugin?.queryClient,
  );
  return findConversationBot(query.data ?? [], agentId, botId);
}

export function conversationBotQueryKey(serverId: string) {
  return ["vibe-bots", "conversation", serverId] as const;
}

export function isProfileTarget(target: WorkspaceTabTarget | undefined, agentId: string) {
  return (
    target?.kind === "plugin" &&
    target.context === "agent" &&
    target.pluginId === "vibe-bots" &&
    target.panelId === "profile" &&
    target.agentId === agentId
  );
}

const NARROW_HEADER_ENTER = 560;
const NARROW_HEADER_EXIT = 600;

type ConversationBot = NonNullable<ReturnType<typeof useConversationBot>>;
// oxlint-disable-next-line complexity
export function BotConversationHeader({
  bot,
  serverId,
  workspaceId,
  agentId,
  isPaneFocused,
  isBot,
}: {
  bot: ConversationBot | undefined;
  serverId: string;
  workspaceId: string;
  agentId: string;
  isPaneFocused: boolean;
  isBot: boolean;
}) {
  const compact = useIsCompactFormFactor();
  const [runtimeOpen, setRuntimeOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const openMore = useCallback(() => setMoreOpen(true), []);
  const closeMore = useCallback(() => setMoreOpen(false), []);
  // 右侧面板占宽时头部放不下模型选择器：把运行控件收进「更多」，头部只留身份与图标。
  const [narrow, setNarrow] = useState(false);
  const onHeaderLayout = useCallback((event: LayoutChangeEvent) => {
    const width = event.nativeEvent.layout.width;
    setNarrow((current) => (current ? width < NARROW_HEADER_EXIT : width < NARROW_HEADER_ENTER));
  }, []);
  const basePlacement = conversationControlsPlacement(compact, false, runtimeOpen);
  const placement = isBot && narrow && basePlacement === "header" ? "registration" : basePlacement;
  const openRuntime = useCallback(() => setRuntimeOpen(true), []);
  const closeRuntime = useCallback(() => setRuntimeOpen(false), []);
  const runtimeHeader = useMemo(() => ({ title: "运行设置" }), []);
  const moreHeader = useMemo(() => ({ title: "更多" }), []);
  const insets = useSafeAreaInsets();
  const safeAreaStyle = useMemo(
    () => (compact ? { paddingTop: insets.top } : undefined),
    [compact, insets.top],
  );
  const slots = useConversationHeaderSlots();
  const scope = useComposerScopeState(isPaneFocused);
  const descriptor = useAgentDescriptor({ kind: "agent", agentId }, { serverId });
  const workspaceKey = `${serverId}:${workspaceId}`;
  const profileAgentId = bot?.mainAgentId ?? agentId;
  const profileOpen = useWorkspaceLayoutStore((state) => {
    if (compact || !selectIsExplorerSidebarVisible(state, workspaceKey)) return false;
    const layout = state.layoutByWorkspace[workspaceKey];
    if (!layout) return false;
    const pane = findPaneById(layout.root, selectExplorerSidebarPaneId(state, workspaceKey));
    return isProfileTarget(
      collectAllTabs(layout.root).find((tab) => tab.tabId === pane?.focusedTabId)?.target,
      profileAgentId,
    );
  });
  const openProfile = useCallback(() => {
    if (profileOpen) useWorkspaceLayoutStore.getState().hideExplorerSidebar(workspaceKey);
    else
      createPluginNavigation({ serverId, workspaceId }).openAgentPanel(
        "vibe-bots",
        "profile",
        profileAgentId,
        "explorer",
      );
  }, [profileOpen, workspaceKey, serverId, workspaceId, profileAgentId]);
  const profileAccessibilityState = useMemo(() => ({ expanded: profileOpen }), [profileOpen]);
  const identityAction = isBot ? openProfile : undefined;
  const compactIdentityAction = compact ? openRuntime : undefined;
  return (
    <View style={safeAreaStyle}>
      <View style={styles.header} testID="conversation-header" onLayout={onHeaderLayout}>
        {isPaneFocused ? slots.left : null}
        <PressHighlight
          style={isBot ? styles.botIdentity : [styles.identity, styles.ordinaryIdentity]}
          onPress={identityAction ?? compactIdentityAction}
          accessibilityRole={compact || isBot ? "button" : undefined}
        >
          {bot ? (
            <Avatar seed={bot.avatarSeed || bot.id} name={bot.name} hue={bot.avatarHue} size={24} />
          ) : null}
          {!bot && isPaneFocused && slots.ordinaryIdentity ? (
            slots.ordinaryIdentity
          ) : (
            <Text numberOfLines={1} style={styles.name}>
              {bot?.name || descriptor.label || descriptor.subtitle}
            </Text>
          )}
          {bot?.title ? (
            <Text numberOfLines={1} style={styles.title}>
              {bot.title}
            </Text>
          ) : null}
        </PressHighlight>
        {isBot ? (
          <View style={styles.threads} testID="conversation-header-threads">
            <ConversationHeaderAccessories serverId={serverId} agentId={agentId} />
          </View>
        ) : null}
        {placement !== "runtime" ? (
          <ComposerKeyboardScopeProvider {...scope}>
            <AgentControls
              agentId={agentId}
              serverId={serverId}
              isCompactLayout={compact}
              registrationOnly={placement === "registration"}
              hideModeControl={isBot}
            />
          </ComposerKeyboardScopeProvider>
        ) : null}
        {isBot && compact ? (
          <IconButton
            label="运行设置"
            icon={Settings2}
            size="xs"
            variant="ghost"
            onPress={openRuntime}
          />
        ) : null}
        {isBot ? (
          <IconButton
            label="bot 资料"
            icon={PanelRight}
            size="xs"
            variant="ghost"
            accessibilityState={profileAccessibilityState}
            onPress={openProfile}
          />
        ) : null}
        {isBot && (!isPaneFocused || !slots.right) ? (
          <IconButton label="更多" icon={Ellipsis} size="xs" variant="ghost" onPress={openMore} />
        ) : null}
        {isPaneFocused ? slots.right?.(isBot ? openMore : undefined) : null}
      </View>
      <AdaptiveModalSheet
        header={runtimeHeader}
        visible={compact && runtimeOpen}
        onClose={closeRuntime}
      >
        <ComposerKeyboardScopeProvider {...scope}>
          <AgentControls
            agentId={agentId}
            serverId={serverId}
            isCompactLayout
            hideModeControl={isBot}
          />
        </ComposerKeyboardScopeProvider>
      </AdaptiveModalSheet>
      <AdaptiveModalSheet header={moreHeader} visible={moreOpen} onClose={closeMore}>
        {narrow && !compact ? (
          <ComposerKeyboardScopeProvider {...scope}>
            <AgentControls
              agentId={agentId}
              serverId={serverId}
              isCompactLayout
              hideModeControl={isBot}
            />
          </ComposerKeyboardScopeProvider>
        ) : null}
        <LiveAgentModeControl agentId={agentId} serverId={serverId} onClose={closeMore} />
      </AdaptiveModalSheet>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  header: {
    height: 38,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    overflow: "hidden",
  },
  identity: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  // 任务头部的右侧控件很宽，身份区不设下限会被挤到只剩项目名。
  ordinaryIdentity: { minWidth: 240 },
  botIdentity: {
    maxWidth: "30%",
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  threads: { flex: 1, minWidth: 0 },
  name: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    flexShrink: 1,
  },
  title: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, flexShrink: 1 },
}));
