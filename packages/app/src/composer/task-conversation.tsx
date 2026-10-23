import { useCallback, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useMutation } from "@tanstack/react-query";
import type {
  TaskConversationDelivery,
  TaskConversationRecipient,
} from "@getpaseo/protocol/messages";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import { Composer, type ComposerProps, type ComposerTaskConversationControls } from "@/composer";
import { useAgentInputDraft } from "@/composer/draft/input-draft";
import {
  sendTaskConversationSubmission,
  taskConversationSendErrorMessage,
} from "@/composer/task-conversation-send";
import {
  findTaskConversationRecipientOption,
  withTaskConversationRecipientModel,
  type TaskConversationRecipientOption,
} from "@/composer/task-conversation-selection";
import { CombinedModelSelector } from "@/components/combined-model-selector";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { ComboboxTrigger } from "@/components/ui/combobox-trigger";
import { Button } from "@/components/ui/button";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { buildSelectableProviderSelectorProviders } from "@/provider-selection/provider-selection";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import {
  createTaskConversationSubmissionWriter,
  taskConversationKey,
  useTaskConversationStore,
} from "@/task-conversations/store";

export interface TaskConversationComposerProps extends Pick<
  ComposerProps,
  | "serverId"
  | "workspaceId"
  | "cwd"
  | "isPaneFocused"
  | "editingSession"
  | "onComposerHeightChange"
  | "onFocusInput"
  | "isCompactLayout"
  | "onClientSlashCommand"
> {
  conversationId: string;
  anchorAgentId: string | null;
  recipient: TaskConversationRecipient;
  onRecipientChange: (recipient: TaskConversationRecipient) => void;
  recipientOptions?: readonly TaskConversationRecipientOption[];
}

const EMPTY_RECIPIENT_OPTIONS: readonly TaskConversationRecipientOption[] = [];

export function TaskConversationComposer({
  conversationId,
  anchorAgentId,
  recipient,
  onRecipientChange,
  recipientOptions = EMPTY_RECIPIENT_OPTIONS,
  ...props
}: TaskConversationComposerProps) {
  const { serverId, cwd } = props;
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const key = taskConversationKey(serverId, conversationId);
  const conversation = useTaskConversationStore((state) => state.conversations.get(key));
  const uncertain = useTaskConversationStore((state) => state.timelines.get(key)?.uncertain);
  const draft = useAgentInputDraft({ draftKey: `task-conversation:${serverId}:${conversationId}` });
  const catalog = useProvidersSnapshot(serverId, { cwd });
  const { refetchIfStale } = catalog;
  const providers = useMemo(
    () => buildSelectableProviderSelectorProviders(catalog.entries, connected),
    [catalog.entries, connected],
  );
  const roleAnchor = useRef<View>(null);
  const [roleOpen, setRoleOpen] = useState(false);
  const openRoles = useCallback(() => setRoleOpen(true), []);
  const openModels = useCallback(
    () => refetchIfStale(recipient.config.provider),
    [refetchIfStale, recipient.config.provider],
  );
  const options = useMemo(() => {
    if (recipientOptions.length > 0) return recipientOptions;
    const members = conversation?.members ?? [];
    const entries: TaskConversationRecipientOption[] = members.map((member) => ({
      id: member.memberId,
      label: member.role,
      recipient: {
        memberId: member.memberId,
        role: member.role,
        presetId: member.presetId,
        config: member.config,
        parentMemberId: member.parentMemberId,
      },
    }));
    return entries;
  }, [conversation?.members, recipientOptions]);
  const roleOptions = useMemo<ComboboxOption[]>(
    () =>
      options.map((option) => ({
        id: option.id,
        label: option.label,
        description: `${option.recipient.config.provider} · ${option.recipient.config.model ?? "默认模型"}`,
      })),
    [options],
  );
  const selectedOption = findTaskConversationRecipientOption(options, recipient);
  const selectRecipient = useCallback(
    (id: string) => {
      const option = options.find((entry) => entry.id === id);
      if (option) onRecipientChange(option.recipient);
      setRoleOpen(false);
    },
    [onRecipientChange, options],
  );
  const selectModel = useCallback(
    (provider: AgentProvider, model: string) => {
      onRecipientChange(withTaskConversationRecipientModel({ recipient, provider, model }));
    },
    [onRecipientChange, recipient],
  );
  const onDelivery = useCallback(
    (delivery: TaskConversationDelivery) => {
      useTaskConversationStore.getState().setDelivery(serverId, delivery);
    },
    [serverId],
  );
  const onUncertain = useCallback(
    (clientMessageId: string, message: string) => {
      useTaskConversationStore
        .getState()
        .setUncertain(serverId, conversationId, clientMessageId, message);
    },
    [conversationId, serverId],
  );
  const send = useCallback<ComposerTaskConversationControls["send"]>(
    async (message) => {
      if (!client || !connected) throw new Error("宿主已断开连接。");
      await sendTaskConversationSubmission({ client, message, onDelivery, onUncertain });
    },
    [client, connected, onDelivery, onUncertain],
  );
  const stopMutation = useMutation({
    mutationFn: async () => {
      if (!client || !connected) throw new Error("宿主已断开连接。");
      const result = await client.stopTaskConversation({ conversationId });
      if (result.error || !result.conversation)
        throw new Error(result.error ?? "停止任务会话失败。");
      useTaskConversationStore.getState().setConversation(serverId, result.conversation);
    },
  });
  const queryMutation = useMutation({
    mutationFn: async () => {
      if (!client || !connected) throw new Error("宿主已断开连接。");
      for (const clientMessageId of uncertain?.keys() ?? []) {
        const result = await client.getTaskConversationDelivery({
          conversationId,
          clientMessageId,
        });
        if (result.error || !result.delivery)
          throw new Error(result.error ?? "暂未查到投递回执，请稍后重新查询。");
        onDelivery(result.delivery);
        if (result.delivery.status === "rejected")
          throw new Error(
            taskConversationSendErrorMessage(result.delivery.error ?? "宿主拒绝了本次接手请求。"),
          );
        const pending =
          result.delivery.status === "prepared" || result.delivery.status === "dispatching";
        if (pending) onUncertain(clientMessageId, "宿主仍在投递，请稍后重新查询。");
      }
    },
  });
  const { mutate: queryDelivery } = queryMutation;
  const queryReceipts = useCallback(() => queryDelivery(), [queryDelivery]);
  const hasUncertain = (uncertain?.size ?? 0) > 0;
  const stopping = stopMutation.isPending || conversation?.status === "stopping";
  const hasRunningMember =
    conversation?.members.some((member) => member.status === "running") ?? false;
  const isRunning = hasRunningMember || stopping || hasUncertain;
  const archived = conversation?.status === "archived";
  const canSend = connected && !hasUncertain && !stopping && !archived;
  const controls = useMemo(
    () => (
      <View style={styles.controls}>
        <ComboboxTrigger
          ref={roleAnchor}
          onPress={openRoles}
          disabled={!canSend}
          accessibilityLabel="选择接手者"
        >
          <Text style={styles.role} numberOfLines={1}>
            {selectedOption?.label ?? recipient.role}
          </Text>
        </ComboboxTrigger>
        <Combobox
          anchorRef={roleAnchor}
          options={roleOptions}
          value={selectedOption?.id ?? ""}
          onSelect={selectRecipient}
          open={roleOpen}
          onOpenChange={setRoleOpen}
          title="谁来接"
          desktopPlacement="top-start"
        />
        <CombinedModelSelector
          providers={providers}
          selectedProvider={recipient.config.provider}
          selectedModel={recipient.config.model ?? ""}
          onSelect={selectModel}
          isLoading={catalog.isLoading}
          onOpen={openModels}
          serverId={serverId}
          disabled={!canSend}
        />
      </View>
    ),
    [
      canSend,
      openRoles,
      openModels,
      catalog,
      providers,
      recipient,
      roleOpen,
      roleOptions,
      selectModel,
      selectRecipient,
      selectedOption,
      serverId,
    ],
  );
  const submission = useMemo(() => createTaskConversationSubmissionWriter(serverId), [serverId]);
  const transport = useMemo<ComposerTaskConversationControls>(
    () => ({
      conversationId,
      recipient,
      send,
      submission,
      isRunning,
      isStopping: stopping,
      canSend,
      stop: stopMutation.mutateAsync,
      controls,
    }),
    [
      canSend,
      controls,
      conversationId,
      isRunning,
      recipient,
      send,
      stopping,
      stopMutation.mutateAsync,
      submission,
    ],
  );
  return (
    <View>
      {hasUncertain && (
        <View style={styles.notice}>
          <Text style={styles.noticeText}>{[...(uncertain?.values() ?? [])].join("\n")}</Text>
          <Button
            variant="outline"
            size="sm"
            onPress={queryReceipts}
            disabled={!connected}
            loading={queryMutation.isPending}
          >
            查询回执
          </Button>
        </View>
      )}
      {queryMutation.error && <Text style={styles.noticeText}>{queryMutation.error.message}</Text>}
      <Composer
        {...props}
        agentId={anchorAgentId ?? undefined}
        taskConversation={transport}
        textSource={draft.textSource}
        onChangeText={draft.editText}
        textReplacement={draft.textReplacement}
        attachments={draft.attachments}
        onChangeAttachments={draft.setAttachments}
        clearDraft={draft.clear}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  controls: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1], flexShrink: 1 },
  role: { color: theme.colors.foreground, fontSize: theme.fontSize.sm, maxWidth: 110 },
  notice: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
  },
  noticeText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, flexShrink: 1 },
}));
