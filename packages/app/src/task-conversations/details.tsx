import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import { StyleSheet } from "react-native-unistyles";
import type { TaskConversationSource } from "@getpaseo/protocol/messages";
import { AgentStreamView } from "@/agent-stream/view";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { RetainedPanelActivity, useRetainedPanelActive } from "@/components/retained-panel";
import { PaneFocusProvider, usePaneFocus } from "@/panels/pane-context";
import { setTaskConversationRecipient } from "@/composer/task-conversation-selection";
import type { AgentScreenAgent } from "@/hooks/use-agent-screen-state-machine";
import { useLoadOlderAgentHistory } from "@/hooks/use-load-older-agent-history";
import { getHostRuntimeStore, useHostRuntimeClient } from "@/runtime/host-runtime";
import { planTimelinePromptJump } from "@/timeline/timeline-sync-plan";
import { selectAgentTimelineState, useSessionStore } from "@/stores/session-store";
import {
  observeProviderSubagentTimeline,
  providerSubagentKey,
  useProviderSubagentStore,
} from "@/subagents/provider-store";
import type { StreamItem } from "@/types/stream";
import type { PendingPermission } from "@/types/shared";
import { taskConversationKey, useTaskConversationStore } from "./store";

const EMPTY_ITEMS: StreamItem[] = [];
const EMPTY_PERMISSIONS = new Map<string, PendingPermission>();
const IDLE_TURN = { isActive: false, isCancelling: false, startedAt: null, turnId: null };
const SOURCE_PAGINATION = {
  hasOlder: false,
  isLoadingOlder: false,
  progressKey: null,
  onLoadOlder: () => false,
};

export interface TaskConversationDetailsTarget {
  backendAgentId: string;
  memberId?: string;
  providerSubagentId?: string;
  source?: TaskConversationSource;
}

interface DetailsProps {
  serverId: string;
  conversationId: string;
  source: TaskConversationDetailsTarget;
  onClose(): void;
}

export function TaskConversationDetails({
  serverId,
  conversationId,
  source,
  onClose,
}: DetailsProps) {
  const active = useRetainedPanelActive();
  const paneFocus = usePaneFocus();
  const contextBridge = useCallback(
    (children: ReactNode) => (
      <PaneFocusProvider value={paneFocus}>
        <RetainedPanelActivity active={active}>{children}</RetainedPanelActivity>
      </PaneFocusProvider>
    ),
    [active, paneFocus],
  );
  const client = useHostRuntimeClient(serverId);
  const conversation = useTaskConversationStore((state) =>
    state.conversations.get(taskConversationKey(serverId, conversationId)),
  );
  const member = conversation?.members.find(
    (candidate) => candidate.backendAgentId === source.backendAgentId,
  );
  const stop = useMutation({
    mutationFn: async () => {
      if (!client || !member) throw new Error("此记录不属于可控制的任务成员。");
      const result = await client.stopTaskConversation({
        conversationId,
        memberId: member.memberId,
      });
      if (result.error) throw new Error(result.error);
      if (result.conversation)
        useTaskConversationStore.getState().setConversation(serverId, result.conversation);
    },
  });
  const heading = member
    ? `${member.role} · ${member.config.provider} · ${member.config.model ?? "默认模型"}`
    : "子会话详情";
  const header = useMemo(() => ({ title: heading }), [heading]);
  const { mutate: stopMutation } = stop;
  const stopMember = useCallback(() => stopMutation(), [stopMutation]);
  const selectMember = useCallback(() => {
    if (!member) return;
    setTaskConversationRecipient(serverId, conversationId, {
      memberId: member.memberId,
      role: member.role,
      presetId: member.presetId,
      config: member.config,
      parentMemberId: member.parentMemberId,
    });
    onClose();
  }, [conversationId, member, onClose, serverId]);
  return (
    <AdaptiveModalSheet
      visible={active && paneFocus.isPaneFocused}
      header={header}
      onClose={onClose}
      contextBridge={contextBridge}
      scrollable={false}
      desktopMaxWidth={1000}
      desktopHeight="85%"
    >
      <View style={styles.container} testID="task-conversation-details">
        {source.source ? (
          <Text style={styles.source} selectable>
            {source.source.sourceTurnId
              ? `来源轮次：${source.source.sourceTurnId}`
              : "原始会话记录"}
          </Text>
        ) : null}
        {member && !source.providerSubagentId ? (
          <View style={styles.memberActions}>
            <Button variant="ghost" onPress={selectMember}>
              补充要求
            </Button>
            <Button variant="ghost" disabled={stop.isPending} onPress={stopMember}>
              {stop.isPending ? "正在停止此轮…" : "停止此轮"}
            </Button>
          </View>
        ) : null}
        {stop.error ? <Text style={styles.error}>{stop.error.message}</Text> : null}
        <TaskConversationTranscript
          serverId={serverId}
          conversationId={conversationId}
          target={source}
        />
      </View>
    </AdaptiveModalSheet>
  );
}

export function TaskConversationTranscript({
  serverId,
  conversationId,
  target,
}: {
  serverId: string;
  conversationId: string;
  target: TaskConversationDetailsTarget;
}) {
  if (target.providerSubagentId)
    return (
      <ProviderTranscript
        serverId={serverId}
        conversationId={conversationId}
        parentAgentId={target.backendAgentId}
        subagentId={target.providerSubagentId}
      />
    );
  return (
    <ManagedTranscript
      serverId={serverId}
      conversationId={conversationId}
      backendAgentId={target.backendAgentId}
      source={target.source}
    />
  );
}

function useTranscriptContext(
  serverId: string,
  conversationId: string,
  backendAgentId: string,
): AgentScreenAgent {
  const conversation = useTaskConversationStore((state) =>
    state.conversations.get(taskConversationKey(serverId, conversationId)),
  );
  const agent = useSessionStore(
    (state) =>
      state.sessions[serverId]?.agents.get(backendAgentId) ??
      state.sessions[serverId]?.agentDetails.get(backendAgentId),
  );
  const member = conversation?.members.find(
    (candidate) => candidate.backendAgentId === backendAgentId,
  );
  return useMemo(
    () => ({
      serverId,
      id: backendAgentId,
      provider: agent?.provider ?? member?.config.provider,
      cwd: agent?.cwd ?? member?.config.cwd ?? "",
      workspaceId: conversation?.workspaceId,
      status: agent?.status ?? "idle",
      projectPlacement: agent?.projectPlacement,
    }),
    [agent, backendAgentId, conversation?.workspaceId, member, serverId],
  );
}

function ManagedTranscript({
  serverId,
  conversationId,
  backendAgentId,
  source,
}: {
  serverId: string;
  conversationId: string;
  backendAgentId: string;
  source?: TaskConversationSource;
}) {
  const active = useRetainedPanelActive();
  const context = useTranscriptContext(serverId, conversationId, backendAgentId);
  const owner = useSessionStore((state) => state.sessions[serverId]?.viewedTimelineSync);
  const items = useSessionStore(
    (state) => state.sessions[serverId]?.agentStreamTail.get(backendAgentId) ?? EMPTY_ITEMS,
  );
  const head = useSessionStore(
    (state) => state.sessions[serverId]?.agentStreamHead.get(backendAgentId) ?? EMPTY_ITEMS,
  );
  const ready = useSessionStore(
    (state) =>
      selectAgentTimelineState(state.sessions[serverId], backendAgentId).status === "synced",
  );
  const pagination = useLoadOlderAgentHistory({ serverId, agentId: backendAgentId });
  const [showFull, setShowFull] = useState(false);
  const showFullTranscript = useCallback(() => setShowFull(true), []);
  const sourceQuery = useFetchQuery({
    dataShape: "value",
    immutableWhen: () => true,
    queryKey: ["task-conversation-source", serverId, backendAgentId, source?.epoch, source?.seq],
    enabled: active && ready && source?.epoch !== undefined && source.seq !== undefined,
    queryFn: async () => {
      if (source?.epoch === undefined || source.seq === undefined)
        throw new Error("来源没有可定位的位置。");
      await getHostRuntimeStore().fetchAgentTimeline(
        serverId,
        backendAgentId,
        planTimelinePromptJump({ epoch: source.epoch, seq: source.seq }),
      );
      return true;
    },
  });
  const sourceItem = items.find((item) => {
    if (source?.messageId && "messageId" in item && item.messageId === source.messageId)
      return true;
    return (
      source?.epoch !== undefined &&
      source.seq !== undefined &&
      item.timelineCursor?.epoch === source.epoch &&
      item.timelineCursor.seq === source.seq
    );
  });
  const selectedItems = useMemo(
    () => (sourceItem && !showFull ? [sourceItem] : items),
    [items, showFull, sourceItem],
  );
  const sourceOnly = sourceItem !== undefined && !showFull;
  const sourceId = `task-details:${conversationId}:${backendAgentId}`;
  useEffect(() => {
    if (!active) return;
    owner?.replaceVisibleAgentIds(sourceId, [backendAgentId]);
    return () => owner?.replaceVisibleAgentIds(sourceId, []);
  }, [active, backendAgentId, owner, sourceId]);
  const historyPagination = useMemo(
    () => ({
      hasOlder: pagination.hasOlder,
      isLoadingOlder: pagination.isLoadingOlder,
      progressKey: pagination.progressKey,
      onLoadOlder: pagination.loadOlder,
    }),
    [pagination.hasOlder, pagination.isLoadingOlder, pagination.progressKey, pagination.loadOlder],
  );
  return (
    <View style={styles.container}>
      {sourceQuery.isFetching ? <Text style={styles.source}>正在定位原始记录…</Text> : null}
      {sourceQuery.error ? <Text style={styles.error}>{sourceQuery.error.message}</Text> : null}
      {sourceOnly ? (
        <Button variant="ghost" onPress={showFullTranscript}>
          查看完整会话
        </Button>
      ) : null}
      <AgentStreamView
        agentId={backendAgentId}
        serverId={serverId}
        context={context}
        streamItems={selectedItems}
        streamHead={sourceOnly ? EMPTY_ITEMS : head}
        pendingPermissions={EMPTY_PERMISSIONS}
        turnPresentation={IDLE_TURN}
        isAuthoritativeHistoryReady={ready}
        historyPagination={sourceOnly ? SOURCE_PAGINATION : historyPagination}
        disableAgentTimelineActions={sourceOnly}
        readOnly
      />
    </View>
  );
}

function ProviderTranscript({
  serverId,
  conversationId,
  parentAgentId,
  subagentId,
}: {
  serverId: string;
  conversationId: string;
  parentAgentId: string;
  subagentId: string;
}) {
  const active = useRetainedPanelActive();
  const client = useHostRuntimeClient(serverId);
  const context = useTranscriptContext(serverId, conversationId, parentAgentId);
  const key = providerSubagentKey(serverId, parentAgentId, subagentId);
  const timeline = useProviderSubagentStore((state) => state.timelines.get(key));
  const older = useMutation({
    mutationFn: async () => {
      if (!client || !timeline?.epoch || !timeline.cursor) return;
      const result = await client.fetchProviderSubagentTimeline(parentAgentId, subagentId, {
        direction: "before",
        cursor: { epoch: timeline.epoch, seq: timeline.cursor.startSeq },
        limit: 100,
      });
      useProviderSubagentStore.getState().replaceTimeline(serverId, result);
    },
  });
  const refresh = useMutation({
    mutationFn: async () => {
      if (!client) throw new Error("未连接宿主。");
      const result = await client.fetchProviderSubagentTimeline(parentAgentId, subagentId, {
        direction: "tail",
        limit: 100,
      });
      useProviderSubagentStore.getState().replaceTimeline(serverId, result);
    },
  });
  const { mutate: refreshTimeline } = refresh;
  useEffect(() => {
    if (!client || !active) return;
    return observeProviderSubagentTimeline({
      client,
      serverId,
      parentAgentId,
      subagentId,
      limit: 100,
      reportError: () => refreshTimeline(),
    });
  }, [active, client, parentAgentId, refreshTimeline, serverId, subagentId]);
  const loadOlder = useCallback(() => {
    if (older.isPending || !timeline?.hasOlder) return false;
    older.mutate();
    return true;
  }, [older, timeline?.hasOlder]);
  const historyPagination = useMemo(
    () => ({
      hasOlder: timeline?.hasOlder === true,
      isLoadingOlder: older.isPending,
      progressKey: timeline?.cursor ? `${timeline.epoch}:${timeline.cursor.startSeq}` : null,
      onLoadOlder: loadOlder,
    }),
    [timeline, older.isPending, loadOlder],
  );
  return (
    <View style={styles.container}>
      {refresh.error || older.error ? (
        <Text style={styles.error}>{(refresh.error ?? older.error)?.message}</Text>
      ) : null}
      <AgentStreamView
        agentId={`provider:${parentAgentId}:${subagentId}`}
        serverId={serverId}
        context={context}
        streamItems={timeline?.tail ?? EMPTY_ITEMS}
        streamHead={timeline?.head ?? EMPTY_ITEMS}
        pendingPermissions={EMPTY_PERMISSIONS}
        turnPresentation={IDLE_TURN}
        historyPagination={historyPagination}
        disableAgentTimelineActions
        isAuthoritativeHistoryReady={timeline !== undefined}
        readOnly
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, minHeight: 0 },
  memberActions: { flexDirection: "row", gap: theme.spacing[2] },
  source: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    padding: theme.spacing[2],
  },
  error: { color: theme.colors.destructive, padding: theme.spacing[2] },
}));
