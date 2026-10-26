import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { PressHighlight } from "@/components/ui/press-highlight";
import type { PromptLibraryEntry } from "@getpaseo/protocol/prompt-library";
import { promptLibrary, usePromptLibraryHost } from "@/prompt-library";
import { filterPromptEntries } from "@/prompt-library/internal/merge";
import { PromptLibraryNoticeBanner, promptLibraryErrorMessage } from "./messages";
import { PromptTagChip } from "./tag-chip";

const ThemedSpinner = withUnistyles(LoadingSpinner, (theme) => ({
  color: theme.colors.foregroundMuted,
}));

export function PromptLibraryPickerSheet({
  serverId,
  visible,
  onClose,
  onInsert,
  onManage,
}: {
  serverId: string;
  visible: boolean;
  onClose: () => void;
  onInsert: (body: string) => void;
  onManage: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const host = usePromptLibraryHost(serverId);
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setQuery("");
    setTag(null);
    void promptLibrary.ensureHydrated(serverId);
  }, [serverId, visible]);

  useEffect(() => {
    if (tag && !host.tags.some((candidate) => candidate.toLowerCase() === tag.toLowerCase())) {
      setTag(null);
    }
  }, [host.tags, tag]);

  const entries = useMemo(
    () => filterPromptEntries({ entries: host.entries, query, tag }),
    [host.entries, query, tag],
  );
  const header = useMemo<SheetHeader>(
    () => ({
      title: t("promptLibrary.title"),
      search: {
        onChange: setQuery,
        resetKey: visible ? "open" : "closed",
        placeholder: t("promptLibrary.search"),
        autoFocus: false,
        testID: "prompt-library-picker-search",
      },
    }),
    [t, visible],
  );
  const select = useCallback(
    (entry: PromptLibraryEntry) => {
      onInsert(entry.body);
    },
    [onInsert],
  );
  const selectTag = useCallback((next: string) => setTag(next), []);
  const clearTag = useCallback(() => setTag(null), []);
  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <PromptLibraryStatus host={host} />
        <Button
          variant="ghost"
          size="sm"
          disabled={host.status === "unsupported"}
          onPress={onManage}
          testID="prompt-library-picker-manage"
        >
          {t("promptLibrary.manage")}
        </Button>
      </View>
    ),
    [host, onManage, t],
  );

  return (
    <AdaptiveModalSheet
      visible={visible}
      onClose={onClose}
      header={header}
      footer={footer}
      testID="prompt-library-picker"
    >
      {host.tags.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.tagRow}
          style={styles.tagScroll}
          testID="prompt-library-picker-tags"
        >
          <PromptTagChip
            tag={t("promptLibrary.allTags")}
            selected={tag === null}
            onSelect={clearTag}
            testID="prompt-library-picker-tag-all"
          />
          {host.tags.map((candidate) => (
            <PromptTagChip
              key={candidate.toLowerCase()}
              tag={candidate}
              selected={tag === candidate}
              onSelect={selectTag}
              testID={`prompt-library-picker-tag-${candidate}`}
            />
          ))}
        </ScrollView>
      ) : null}
      {!host.hydrated && host.status !== "error" ? (
        <View style={styles.loading}>
          <ThemedSpinner size="small" />
        </View>
      ) : null}
      <View style={styles.list}>
        {entries.map((entry) => (
          <PromptRow key={entry.id} entry={entry} onSelect={select} />
        ))}
      </View>
      {host.hydrated && entries.length === 0 ? (
        <Text style={styles.muted} testID="prompt-library-picker-empty">
          {host.entries.length === 0 ? t("promptLibrary.empty") : t("promptLibrary.emptySearch")}
        </Text>
      ) : null}
      {host.status === "unsupported" ? (
        <Text style={styles.muted} testID="prompt-library-picker-unsupported">
          {t("promptLibrary.unsupported")}
        </Text>
      ) : null}
      {host.error && host.status !== "unsupported" ? (
        <Text style={styles.error} testID="prompt-library-picker-error">
          {promptLibraryErrorMessage(host.error, t)}
        </Text>
      ) : null}
      <PromptLibraryNoticeBanner
        serverId={serverId}
        notice={host.notice}
        testID="prompt-library-picker-notice"
      />
    </AdaptiveModalSheet>
  );
}

function PromptLibraryStatus({
  host,
}: {
  host: ReturnType<typeof usePromptLibraryHost>;
}): ReactElement | null {
  const { t } = useTranslation();
  if (host.status === "unsupported") {
    return (
      <Text style={styles.status} numberOfLines={1}>
        {t("promptLibrary.unsupported")}
      </Text>
    );
  }
  return (
    <View style={styles.statusGroup}>
      {host.status === "offline" || host.status === "error" ? (
        <Text style={styles.status} numberOfLines={1} testID="prompt-library-picker-offline">
          {t("promptLibrary.offline")}
        </Text>
      ) : null}
      {host.pendingCount > 0 ? (
        <Text style={styles.status} numberOfLines={1} testID="prompt-library-picker-pending">
          {t("promptLibrary.pending", { count: host.pendingCount })}
        </Text>
      ) : null}
    </View>
  );
}

function PromptRow({
  entry,
  onSelect,
}: {
  entry: PromptLibraryEntry;
  onSelect: (entry: PromptLibraryEntry) => void;
}): ReactElement {
  const { t } = useTranslation();
  const select = useCallback(() => onSelect(entry), [entry, onSelect]);
  return (
    <PressHighlight
      accessibilityRole="button"
      accessibilityLabel={`${t("promptLibrary.select")} ${entry.title}`}
      onPress={select}
      style={styles.row}
      testID={`prompt-library-picker-row-${entry.id}`}
    >
      <View style={styles.rowHeader}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {entry.title}
        </Text>
        {entry.tags.length > 0 ? (
          <View style={styles.rowTags}>
            {entry.tags.slice(0, 3).map((tag) => (
              <PromptTagChip key={tag.toLowerCase()} tag={tag} />
            ))}
          </View>
        ) : null}
      </View>
      <Text style={styles.rowBody} numberOfLines={2}>
        {entry.body}
      </Text>
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  tagScroll: {
    flexGrow: 0,
  },
  tagRow: {
    flexDirection: "row",
    gap: theme.spacing[1],
    paddingBottom: theme.spacing[2],
  },
  list: {
    gap: theme.spacing[1],
  },
  row: {
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  rowHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  rowTitle: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  rowTags: {
    flexDirection: "row",
    flexShrink: 1,
    gap: theme.spacing[1],
  },
  rowBody: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  loading: {
    alignItems: "center",
    paddingVertical: theme.spacing[4],
  },
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingVertical: theme.spacing[2],
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    paddingTop: theme.spacing[2],
  },
  status: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  statusGroup: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  footer: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
}));
