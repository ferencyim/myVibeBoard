import { useCallback, useEffect, useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { MessagesSquare } from "lucide-react-native";
import invariant from "tiny-invariant";
import type {
  TaskConversationRecipient,
  TaskConversationSnapshot,
} from "@getpaseo/protocol/messages";
import { Button } from "@/components/ui/button";
import { PaneContentToolbar } from "@/components/ui/pane-content-toolbar";
import { ComposerDock } from "@/composer/dock";
import { useComposerEditingSession, useComposerFullscreen } from "@/composer/editing-session";
import { TaskConversationComposer } from "@/composer/task-conversation";
import {
  setTaskConversationRecipient,
  useTaskConversationSelectionStore,
} from "@/composer/task-conversation-selection";
import type { ClientSlashCommand } from "@/client-slash-commands";
import { useMutation } from "@tanstack/react-query";
import { COMPACT_FORM_FACTOR_WIDTH, useIsCompactFormFactor } from "@/constants/layout";
import { useContainerWidthBelow } from "@/hooks/use-container-width";
import { usePaneContext, usePaneFocus } from "@/panels/pane-context";
import { definePanel } from "@/panels/panel-registry";
import { PluginConversationPanels } from "@/plugins/workspace-panels/conversation";
import { useSessionStore } from "@/stores/session-store";
import { taskConversationKey, useTaskConversationStore } from "@/task-conversations/store";
import { TaskConversationTimeline } from "@/task-conversations/timeline";
import { normalizeAgentSnapshot } from "@/utils/agent-snapshots";
import { confirmDialog } from "@/utils/confirm-dialog";

function useConversationRecipient(
  serverId: string,
  conversationId: string,
  conversation: TaskConversationSnapshot | undefined,
) {
  const selection = useTaskConversationSelectionStore((state) =>
    state.selections.get(taskConversationKey(serverId, conversationId)),
  );
  const member =
    conversation?.members.find(
      (candidate) => candidate.backendAgentId === conversation.anchorAgentId,
    ) ?? conversation?.members[0];
  const recipient = useMemo(
    () =>
      selection?.recipient ??
      (member
        ? {
            memberId: member.memberId,
            role: member.role,
            presetId: member.presetId,
            config: member.config,
            parentMemberId: member.parentMemberId,
          }
        : null),
    [member, selection?.recipient],
  );
  const selectRecipient = useCallback(
    (nextRecipient: TaskConversationRecipient) =>
      setTaskConversationRecipient(serverId, conversationId, nextRecipient),
    [serverId, conversationId],
  );
  return { recipient, selectRecipient, options: selection?.recipients };
}

function TaskConversationPanel() {
  const { serverId, workspaceId, target } = usePaneContext();
  invariant(
    target.kind === "task_conversation",
    "TaskConversationPanel requires conversation target",
  );
  const { conversationId } = target;
  const { isPaneFocused } = usePaneFocus();
  const compact = useIsCompactFormFactor();
  const { onLayout: measureChat, isBelow: compactComposer } = useContainerWidthBelow(
    COMPACT_FORM_FACTOR_WIDTH,
    { initialIsBelow: compact },
  );
  const editingSession = useComposerEditingSession("chat");
  const fullscreen = useComposerFullscreen(editingSession);
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const serverInfo = useSessionStore((state) => state.sessions[serverId]?.serverInfo ?? null);
  const supported = serverInfo?.features?.taskConversations === true;
  const conversation = useTaskConversationStore((state) =>
    state.conversations.get(taskConversationKey(serverId, conversationId)),
  );
  const { recipient, selectRecipient, options } = useConversationRecipient(
    serverId,
    conversationId,
    conversation,
  );
  const control = useMutation({
    mutationFn: async (action: "stop" | "archive") => {
      if (!client) throw new Error("宿主已断开连接。");
      const result =
        action === "stop"
          ? await client.stopTaskConversation({ conversationId })
          : await client.archiveTaskConversation({ conversationId });
      if (result.error) throw new Error(result.error);
      if (result.conversation)
        useTaskConversationStore.getState().setConversation(serverId, result.conversation);
    },
  });
  const { mutate: controlMutation, mutateAsync: controlAsync, isPending: controlPending } = control;
  const anchorAgentId = conversation?.anchorAgentId ?? null;
  const archived = conversation?.status === "archived";
  const controlsDisabled = !client || controlPending || archived;

  // The stable anchor supplies legacy plugin command context; selecting a recipient never changes it.
  useEffect(() => {
    if (!client || !anchorAgentId) return;
    let active = true;
    void (async () => {
      try {
        const result = await client.fetchAgent({ agentId: anchorAgentId });
        if (!active || !result?.agent) return;
        const agent = normalizeAgentSnapshot(result.agent, serverId);
        useSessionStore
          .getState()
          .setAgentDetails(serverId, (previous) => new Map(previous).set(agent.id, agent));
      } catch {
        /* The container remains readable while its anchor details reconnect. */
      }
    })();
    return () => {
      active = false;
    };
  }, [anchorAgentId, client, serverId]);

  const archive = useCallback(async () => {
    if (!client || controlPending) return;
    const confirmed = await confirmDialog({
      title: "归档任务会话",
      message: "停止所有后台成员后归档此任务会话。会话历史与 worktree 将保留。",
      confirmLabel: "归档",
      cancelLabel: "取消",
    });
    if (!confirmed) return;
    await controlAsync("archive");
  }, [client, controlPending, controlAsync]);
  const stopTask = useCallback(() => controlMutation("stop"), [controlMutation]);
  const archiveTask = useCallback(() => {
    void archive().catch(() => undefined);
  }, [archive]);
  const handleClientSlashCommand = useCallback(
    async (command: ClientSlashCommand) => {
      if (command.kind === "replace-agent-with-draft") {
        throw new Error("请新建任务会话；清空后台成员不会清空群聊历史。");
      }
      await archive();
    },
    [archive],
  );

  if (!supported) {
    return (
      <View style={styles.empty}>
        <Text style={styles.label}>
          {serverInfo ? "请升级宿主以使用任务会话。" : "正在连接任务会话宿主…"}
        </Text>
      </View>
    );
  }
  if (conversation && conversation.workspaceId !== workspaceId) {
    return (
      <View style={styles.empty}>
        <Text style={styles.error}>任务会话不属于当前 workspace。</Text>
      </View>
    );
  }
  return (
    <View style={[styles.root, compact && styles.compactRoot]} testID="task-conversation-panel">
      <View style={styles.chat} onLayout={measureChat}>
        {!fullscreen ? (
          <PaneContentToolbar style={styles.toolbar}>
            <Text style={[styles.label, styles.toolbarTitle]} numberOfLines={1}>
              任务会话{archived ? " · 已归档" : ""}
            </Text>
            <View style={styles.spacer} />
            <Button size="sm" variant="ghost" onPress={stopTask} disabled={controlsDisabled}>
              停止任务
            </Button>
            <Button size="sm" variant="ghost" onPress={archiveTask} disabled={controlsDisabled}>
              归档
            </Button>
          </PaneContentToolbar>
        ) : null}
        {control.error ? <Text style={styles.error}>{control.error.message}</Text> : null}
        <ComposerDock fullscreen={fullscreen}>
          <TaskConversationTimeline serverId={serverId} conversationId={conversationId} />
          {recipient && !archived ? (
            <TaskConversationComposer
              serverId={serverId}
              workspaceId={workspaceId}
              conversationId={conversationId}
              anchorAgentId={anchorAgentId}
              cwd={recipient.config.cwd}
              isPaneFocused={isPaneFocused}
              recipient={recipient}
              onRecipientChange={selectRecipient}
              recipientOptions={options}
              editingSession={editingSession}
              isCompactLayout={compactComposer}
              onClientSlashCommand={handleClientSlashCommand}
            />
          ) : null}
        </ComposerDock>
      </View>
      {conversation && !fullscreen ? (
        <PluginConversationPanels
          serverId={serverId}
          workspaceId={workspaceId}
          conversationId={conversationId}
          anchorAgentId={anchorAgentId}
        />
      ) : null}
    </View>
  );
}

export const taskConversationPanelRegistration = definePanel("task_conversation", {
  component: TaskConversationPanel,
  presentation: {
    label: () => "任务会话",
    subtitle: () => "任务群聊",
    tooltip: () => "任务会话",
    icon: MessagesSquare,
  },
});

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, flexDirection: "row", backgroundColor: theme.colors.surface0 },
  // Keep the same mounted panel and composer while the compact entry moves above the chat.
  compactRoot: { flexDirection: "column-reverse" },
  chat: { flex: 1, minWidth: 0 },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 0,
    paddingHorizontal: theme.spacing[2],
    gap: theme.spacing[1],
  },
  toolbarTitle: { flexShrink: 1 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: theme.spacing[4] },
  label: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    padding: theme.spacing[2],
  },
  spacer: { flex: 1 },
}));
