import { useCallback, useEffect, useMemo, useState } from "react";
import { Image, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type {
  TaskConversationMember,
  TaskConversationRow,
  TaskConversationSnapshot,
} from "@getpaseo/protocol/messages";
import { AgentStreamView, PermissionRequestCard } from "@/agent-stream/view";
import { Button } from "@/components/ui/button";
import { getActiveMessageSubmissions } from "@/composer/submission/model";
import type { AgentScreenAgent } from "@/hooks/use-agent-screen-state-machine";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useSubagentsForParent, type SubagentRow } from "@/subagents/select";
import type { PendingPermission } from "@/types/shared";
import type { StreamItem } from "@/types/stream";
import { derivePendingPermissionKey } from "@/utils/agent-snapshots";
import { TaskConversationDetails, type TaskConversationDetailsTarget } from "./details";
import { projectTaskConversationRows, selectTaskConversationChildren } from "./projection";
import {
  emptyTaskConversationTimeline,
  taskConversationKey,
  useTaskConversationStore,
} from "./store";
import {
  loadOlderTaskConversation,
  observeTaskConversationTimeline,
  prepareTaskConversationReplica,
  retryTaskConversationTimeline,
} from "./timeline-owner";

const EMPTY_TIMELINE = emptyTaskConversationTimeline();
const EMPTY_PERMISSIONS = new Map<string, PendingPermission>();

export function TaskConversationTimeline({
  serverId,
  conversationId,
}: {
  serverId: string;
  conversationId: string;
}) {
  const client = useHostRuntimeClient(serverId);
  const key = taskConversationKey(serverId, conversationId);
  const conversation = useTaskConversationStore((state) => state.conversations.get(key));
  const timeline = useTaskConversationStore((state) => state.timelines.get(key) ?? EMPTY_TIMELINE);
  const [details, setDetails] = useState<TaskConversationDetailsTarget | null>(null);
  const closeDetails = useCallback(() => setDetails(null), []);
  useEffect(() => {
    if (!client) {
      void prepareTaskConversationReplica(serverId, conversationId).catch((error: unknown) => {
        useTaskConversationStore.getState().updateTimeline(serverId, conversationId, (state) => ({
          ...state,
          error: error instanceof Error ? error.message : String(error),
        }));
      });
      return;
    }
    return observeTaskConversationTimeline(client, serverId, conversationId);
  }, [client, conversationId, serverId]);
  const items = useMemo(
    () => projectTaskConversationRows(timeline.rows, timeline.submittedRows),
    [timeline.rows, timeline.submittedRows],
  );
  const rowsById = useMemo(() => {
    const rows = new Map(timeline.rows.map((row) => [row.id, row]));
    for (const item of items) {
      if (item.kind !== "user_message" || !item.clientMessageId) continue;
      const row = timeline.rows.find(
        (candidate) => candidate.clientMessageId === item.clientMessageId,
      );
      if (row) rows.set(item.id, row);
    }
    return rows;
  }, [items, timeline.rows]);
  const localImageIdentities = useMemo(
    () =>
      new Set(
        timeline.submittedRows
          .filter((row) => row.images?.length)
          .map((row) => row.clientMessageId),
      ),
    [timeline.submittedRows],
  );
  const renderItemHeader = useCallback(
    (item: StreamItem) => {
      const row = rowsById.get(item.id);
      if (!row) return null;
      return (
        <SourceHeader
          row={row}
          onOpen={setDetails}
          showImages={!localImageIdentities.has(row.clientMessageId)}
        />
      );
    },
    [localImageIdentities, rowsById],
  );
  const context = useMemo<AgentScreenAgent>(
    () => ({
      serverId,
      id: conversationId,
      status: "idle",
      cwd: conversation?.members[0]?.config.cwd ?? "",
      workspaceId: conversation?.workspaceId,
    }),
    [conversation, conversationId, serverId],
  );
  const active = conversation?.members.some((member) => member.status === "running") === true;
  const turn = useMemo(
    () => ({
      isActive: active,
      isCancelling: conversation?.status === "stopping",
      startedAt: null,
      turnId: null,
    }),
    [active, conversation?.status],
  );
  const submissions = useMemo(
    () => getActiveMessageSubmissions(timeline.submissions),
    [timeline.submissions],
  );
  const loadOlder = useCallback(
    () => (client ? loadOlderTaskConversation(client, serverId, conversationId) : false),
    [client, conversationId, serverId],
  );
  const pagination = useMemo(
    () => ({
      hasOlder: timeline.hasOlder,
      isLoadingOlder: timeline.loadingOlder,
      progressKey: timeline.epoch ? `${timeline.epoch}:${timeline.startSeq}` : null,
      onLoadOlder: loadOlder,
    }),
    [loadOlder, timeline.epoch, timeline.hasOlder, timeline.loadingOlder, timeline.startSeq],
  );
  const retry = useCallback(() => {
    if (client) retryTaskConversationTimeline(client, serverId, conversationId);
  }, [client, conversationId, serverId]);
  return (
    <View style={styles.container} testID="task-conversation-timeline">
      {timeline.sync === "reconnecting" ? (
        <Text style={styles.notice}>正在重新连接宿主…</Text>
      ) : null}
      {timeline.sync === "loading" ? <Text style={styles.notice}>正在读取任务会话…</Text> : null}
      {timeline.error ? (
        <View style={styles.notice}>
          <Text style={styles.error}>{timeline.error}</Text>
          <Button variant="ghost" onPress={retry}>
            重试
          </Button>
        </View>
      ) : null}
      {[...timeline.uncertain].map(([id, message]) => (
        <Text key={id} style={styles.error} testID="task-conversation-delivery-uncertain">
          {message}
        </Text>
      ))}
      <AgentStreamView
        agentId={conversationId}
        serverId={serverId}
        context={context}
        streamItems={items}
        pendingPermissions={EMPTY_PERMISSIONS}
        pendingMessageSubmissions={submissions}
        turnPresentation={turn}
        isAuthoritativeHistoryReady={timeline.epoch !== null}
        historyPagination={pagination}
        renderItemHeader={renderItemHeader}
        disableAgentTimelineActions
        readOnly
      />
      {conversation ? (
        <ConversationApprovals serverId={serverId} conversation={conversation} />
      ) : null}
      {conversation ? (
        <ScrollView style={styles.children} horizontal>
          {conversation.members.map((member) => (
            <MemberChildren
              key={member.memberId}
              serverId={serverId}
              member={member}
              members={conversation.members}
              onOpen={setDetails}
            />
          ))}
        </ScrollView>
      ) : null}
      {details ? (
        <TaskConversationDetails
          serverId={serverId}
          conversationId={conversationId}
          source={details}
          onClose={closeDetails}
        />
      ) : null}
    </View>
  );
}

function SourceHeader({
  row,
  showImages,
  onOpen,
}: {
  row: TaskConversationRow;
  showImages: boolean;
  onOpen(target: TaskConversationDetailsTarget): void;
}) {
  const speaker = row.speaker;
  const identity = speaker
    ? [speaker.role, speaker.provider, speaker.model, speaker.thinkingOptionId]
        .filter(Boolean)
        .join(" · ")
    : "";
  const backendAgentId =
    row.child?.backendAgentId ?? row.source?.backendAgentId ?? speaker?.backendAgentId;
  const open = useCallback(() => {
    if (!backendAgentId) return;
    onOpen({
      backendAgentId,
      memberId: row.source?.memberId ?? speaker?.memberId,
      providerSubagentId: row.child?.providerSubagentId,
      source: row.source,
    });
  }, [backendAgentId, onOpen, row.child?.providerSubagentId, row.source, speaker?.memberId]);
  return (
    <View style={styles.sourceHeader}>
      {identity ? <Text style={styles.identity}>{identity}</Text> : null}
      {backendAgentId ? (
        <Button variant="ghost" onPress={open}>
          {row.kind === "child" ? "展开子会话" : "详情"}
        </Button>
      ) : null}
      {showImages
        ? row.images?.map((image) => <MessageImage key={image.data} image={image} />)
        : null}
    </View>
  );
}

function ConversationApprovals({
  serverId,
  conversation,
}: {
  serverId: string;
  conversation: TaskConversationSnapshot;
}) {
  const client = useHostRuntimeClient(serverId);
  const sessionPermissions = useSessionStore(
    (state) => state.sessions[serverId]?.pendingPermissions,
  );
  const members = useMemo(
    () => new Map(conversation.members.map((member) => [member.backendAgentId, member])),
    [conversation.members],
  );
  const permissions = useMemo(() => {
    const result = new Map<string, PendingPermission>();
    for (const member of conversation.members)
      for (const request of member.pendingPermissions ?? []) {
        const key = derivePendingPermissionKey(member.backendAgentId, request);
        result.set(key, { key, agentId: member.backendAgentId, request });
      }
    for (const permission of sessionPermissions?.values() ?? [])
      if (members.has(permission.agentId)) result.set(permission.key, permission);
    return [...result.values()];
  }, [conversation.members, members, sessionPermissions]);
  if (permissions.length === 0) return null;
  return (
    <ScrollView style={styles.approvals} testID="task-conversation-approvals">
      {permissions.map((permission) => {
        const member = members.get(permission.agentId);
        return (
          <View key={permission.key}>
            <Text style={styles.identity}>
              {member?.role} · {member?.config.provider} · {member?.config.model ?? "默认模型"}
            </Text>
            <PermissionRequestCard permission={permission} client={client} />
          </View>
        );
      })}
    </ScrollView>
  );
}

function MemberChildren({
  serverId,
  member,
  members,
  onOpen,
}: {
  serverId: string;
  member: TaskConversationMember;
  members: readonly TaskConversationMember[];
  onOpen(target: TaskConversationDetailsTarget): void;
}) {
  const rows = useSubagentsForParent({ serverId, parentAgentId: member.backendAgentId });
  const children = useMemo(
    () => selectTaskConversationChildren(rows, member.memberId, members),
    [rows, member.memberId, members],
  );
  return (
    <>
      {children.map((row) => {
        const child =
          row.kind === "paseo"
            ? members.find((candidate) => candidate.backendAgentId === row.id)
            : undefined;
        const label = child
          ? [row.title, child.role, child.config.provider, child.config.model, row.status]
              .filter(Boolean)
              .join(" · ")
          : `${row.title ?? "子会话"} · ${row.provider} · ${row.status}`;
        return <ChildButton key={row.id} row={row} onOpen={onOpen} label={label} />;
      })}
    </>
  );
}

function MessageImage({ image }: { image: NonNullable<TaskConversationRow["images"]>[number] }) {
  const source = useMemo(
    () => ({ uri: `data:${image.mimeType};base64,${image.data}` }),
    [image.data, image.mimeType],
  );
  return (
    <Image
      source={source}
      style={styles.image}
      accessibilityLabel="消息附件"
      resizeMode="contain"
    />
  );
}

function ChildButton({
  row,
  onOpen,
  label,
}: {
  row: SubagentRow;
  onOpen(target: TaskConversationDetailsTarget): void;
  label: string;
}) {
  const open = useCallback(() => {
    if (row.kind === "provider")
      onOpen({ backendAgentId: row.parentAgentId, providerSubagentId: row.id });
    else onOpen({ backendAgentId: row.id });
  }, [onOpen, row]);
  return (
    <Button variant="ghost" onPress={open}>
      {label}
    </Button>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, minHeight: 0 },
  notice: { padding: theme.spacing[2], color: theme.colors.foregroundMuted },
  error: { color: theme.colors.destructive, padding: theme.spacing[2] },
  sourceHeader: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[2],
  },
  identity: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  link: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  image: { width: 160, height: 120 },
  approvals: {
    maxHeight: "40%",
    flexGrow: 0,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    padding: theme.spacing[2],
  },
  children: { maxHeight: 48, flexGrow: 0 },
}));
