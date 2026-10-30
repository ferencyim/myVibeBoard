import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { StyleSheet } from "react-native-unistyles";
import type {
  PluginWorkspaceTabDescriptor,
  PluginWorkspaceTabProvider,
} from "@getpaseo/plugin/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useInstalledPlugins } from "@/plugins/registry";
import { submitWorkspaceTabMessage } from "@/plugins/workspace-tab-submission";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { encodeImages } from "@/utils/encode-images";
import type { WorkspaceTabPlaceholder } from "@/workspace-tabs/model";
import type { DraftCreateAttempt } from "./create-flow";

function RecipientItem({
  target,
  select,
}: {
  target: PluginWorkspaceTabDescriptor;
  select: (target: PluginWorkspaceTabDescriptor) => void;
}) {
  const handleSelect = useCallback(() => select(target), [select, target]);
  return (
    <DropdownMenuItem disabled={target.disabled} onSelect={handleSelect}>
      {target.title + (target.disabled ? " · 未启用" : "")}
    </DropdownMenuItem>
  );
}

function PlaceholderControls({
  placeholder,
  provider,
  workspaceId,
  serverId,
  select,
  recipient,
  disabled,
}: {
  placeholder: WorkspaceTabPlaceholder;
  provider: PluginWorkspaceTabProvider | undefined;
  workspaceId: string;
  serverId: string;
  select: (target: PluginWorkspaceTabDescriptor) => void;
  recipient: PluginWorkspaceTabDescriptor | null;
  disabled: boolean;
}) {
  const queryClient = useQueryClient();
  const [targets, setTargets] = useState<PluginWorkspaceTabDescriptor[]>([]);
  const [open, setOpen] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handleError = useCallback(
    (failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)),
    [],
  );
  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (next && provider)
        void provider.resolve({ workspaceId }).then(setTargets).catch(handleError);
    },
    [handleError, provider, workspaceId],
  );
  const handleEnable = useCallback(() => {
    if (!provider?.enable) return;
    setEnabling(true);
    setError(null);
    void provider
      .enable({ workspaceId, tabId: placeholder.tabId })
      .then(() => queryClient.invalidateQueries({ queryKey: ["plugin-workspace-tabs", serverId] }))
      .catch(handleError)
      .finally(() => setEnabling(false));
  }, [handleError, placeholder.tabId, provider, queryClient, serverId, workspaceId]);
  return (
    <View style={styles.row}>
      {placeholder.disabled ? (
        <Button size="sm" loading={enabling} disabled={!provider?.enable} onPress={handleEnable}>
          本流程未启用 · 点击启用
        </Button>
      ) : null}
      <DropdownMenu open={open} onOpenChange={handleOpenChange}>
        <DropdownMenuTrigger accessibilityLabel="发给" disabled={disabled} style={styles.trigger}>
          <Text style={styles.label}>发给：{recipient?.title ?? placeholder.title}</Text>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" minWidth={220}>
          {targets.map((target) => (
            <RecipientItem key={target.id} target={target} select={select} />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

export function useWorkspaceTabPlaceholder(input: {
  serverId: string;
  workspaceId: string;
  placeholder?: WorkspaceTabPlaceholder;
}) {
  const { serverId, workspaceId, placeholder } = input;
  const queryClient = useQueryClient();
  const installed = useInstalledPlugins();
  const provider = installed
    .find((plugin) => plugin.serverId === serverId && plugin.id === placeholder?.pluginId)
    ?.workspaceTabProviders?.find((value) => value.id === placeholder?.providerId);
  const [recipient, select] = useState<PluginWorkspaceTabDescriptor | null>(null);
  const controls = (disabled: boolean) =>
    placeholder ? (
      <PlaceholderControls
        placeholder={placeholder}
        provider={provider}
        workspaceId={workspaceId}
        serverId={serverId}
        select={select}
        recipient={recipient}
        disabled={disabled}
      />
    ) : null;
  const submit = async (
    client: DaemonClient | null,
    attempt: DraftCreateAttempt,
    config: {
      provider: string | null;
      model: string | null;
      thinkingOptionId: string | null;
    },
  ) => {
    if (!client || !provider || !placeholder)
      throw new Error("任务插件暂时不可用，请连接主机后重试。");
    const target = recipient ?? placeholder;
    if (target.disabled) throw new Error("此流程未启用，请先启用。");
    const recipientSetup = recipient && recipient.id !== placeholder.tabId ? recipient.setup : null;
    const selectedProvider = recipientSetup?.provider ?? config.provider;
    if (!selectedProvider) throw new Error("请在任务角色设置中选择模型。");
    const images = await encodeImages(attempt.images);
    const result = await submitWorkspaceTabMessage({
      provider,
      workspaceId,
      tabId: recipient?.id ?? placeholder.tabId,
      config: {
        provider: selectedProvider,
        model: recipientSetup ? recipientSetup.model : config.model || undefined,
        thinkingOptionId: recipientSetup
          ? recipientSetup.thinkingOptionId
          : config.thinkingOptionId || undefined,
      },
      client,
      text: attempt.text,
      options: { messageId: attempt.clientMessageId, images, attachments: attempt.attachments },
    });
    void queryClient.invalidateQueries({ queryKey: ["plugin-workspace-tabs", serverId] });
    return { agentId: result.id, result };
  };
  return { controls, submit };
}

const styles = StyleSheet.create((theme) => ({
  row: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[2],
    alignItems: "flex-start",
  },
  trigger: { paddingHorizontal: theme.spacing[3], paddingVertical: theme.spacing[2] },
  label: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
}));
