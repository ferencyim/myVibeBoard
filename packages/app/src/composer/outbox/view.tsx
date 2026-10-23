import { useCallback } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { getHostProjectId, type HostProjectListItem } from "@/projects/host-projects";
import type { HostProfile } from "@/types/host-connection";
import type { FirstMessageOutboxEntry } from "./model";

interface FirstMessageOutboxViewProps {
  entries: readonly FirstMessageOutboxEntry[];
  hosts: readonly HostProfile[];
  projects: readonly HostProjectListItem[];
  error: string | null;
  onRetry: (id: string) => Promise<void>;
  onOpen: (id: string) => Promise<void>;
}

const STATUS_LABELS: Record<FirstMessageOutboxEntry["status"], string> = {
  queued: "待联网",
  sending: "发送中",
  unknown: "结果待确认",
  failed: "发送失败",
  sent: "已发送",
};
const STATUS_VARIANTS: Record<FirstMessageOutboxEntry["status"], StatusBadgeVariant> = {
  queued: "muted",
  sending: "muted",
  unknown: "warning",
  failed: "error",
  sent: "success",
};

export function FirstMessageOutboxView({
  entries,
  hosts,
  projects,
  error,
  onRetry,
  onOpen,
}: FirstMessageOutboxViewProps) {
  if (entries.length === 0 && !error) return null;
  return (
    <View style={styles.container} testID="first-message-outbox">
      <Text style={styles.title}>本机待发送</Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <ScrollView style={styles.list} nestedScrollEnabled>
        {entries.map((entry) => (
          <FirstMessageOutboxRow
            key={entry.id}
            entry={entry}
            contextLabel={outboxEntryLabel({ entry, hosts, projects })}
            onRetry={onRetry}
            onOpen={onOpen}
          />
        ))}
      </ScrollView>
    </View>
  );
}

interface OutboxEntryContext extends Pick<FirstMessageOutboxViewProps, "hosts" | "projects"> {
  entry: FirstMessageOutboxEntry;
}

function outboxEntryLabel({ entry, hosts, projects }: OutboxEntryContext): string {
  const host = hosts.find((item) => item.serverId === entry.hostId);
  const project = projects.find((item) => getHostProjectId(item, entry.hostId) === entry.projectId);
  const projectName = project?.projectName ?? "已保存的项目";
  const hostName = host?.label ?? "已保存的主机";
  return projectName + " · " + hostName;
}

function FirstMessageOutboxRow({
  entry,
  contextLabel,
  onRetry,
  onOpen,
}: {
  entry: FirstMessageOutboxEntry;
  contextLabel: string;
  onRetry: FirstMessageOutboxViewProps["onRetry"];
  onOpen: FirstMessageOutboxViewProps["onOpen"];
}) {
  const retry = useCallback(() => {
    void onRetry(entry.id);
  }, [entry.id, onRetry]);
  const open = useCallback(() => {
    void onOpen(entry.id);
  }, [entry.id, onOpen]);
  return (
    <View style={styles.entry} testID={"outbox-item-" + entry.id}>
      <View style={styles.heading}>
        <StatusBadge label={STATUS_LABELS[entry.status]} variant={STATUS_VARIANTS[entry.status]} />
        <Text style={styles.context} numberOfLines={1}>
          {contextLabel}
        </Text>
      </View>
      <Text style={styles.body} selectable>
        {entry.text || "（仅附件）"}
      </Text>
      {entry.attachments.length > 0 ? (
        <Text style={styles.context}>附件：{entry.attachments.length}</Text>
      ) : null}
      {entry.error ? <Text style={styles.error}>{entry.error}</Text> : null}
      {entry.status === "failed" || entry.status === "unknown" ? (
        <Button variant="outline" size="sm" onPress={retry}>
          查询并重试
        </Button>
      ) : null}
      {entry.status === "sent" ? (
        <Button variant="outline" size="sm" onPress={open}>
          打开会话
        </Button>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    marginTop: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    gap: theme.spacing[2],
  },
  title: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  list: { maxHeight: 240 },
  entry: {
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[2],
    alignItems: "flex-start",
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  heading: { flexDirection: "row", gap: theme.spacing[2], alignItems: "center" },
  context: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted, flexShrink: 1 },
  body: { fontSize: theme.fontSize.content, color: theme.colors.foreground },
  error: { fontSize: theme.fontSize.sm, color: theme.colors.destructive },
}));
