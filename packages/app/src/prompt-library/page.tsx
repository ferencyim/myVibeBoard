import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from "react";
import { Platform, ScrollView, Text, View, type LayoutChangeEvent } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useTranslation } from "react-i18next";
import * as Clipboard from "expo-clipboard";
import { ArrowLeft } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { promptLibraryTagKey, type PromptLibraryEntry } from "@getpaseo/protocol/prompt-library";
import { BackHeader } from "@/components/headers/back-header";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { PressHighlight } from "@/components/ui/press-highlight";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { StatusBadge } from "@/components/ui/status-badge";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHostFeature } from "@/runtime/host-features";
import { confirmDialog } from "@/utils/confirm-dialog";
import { promptLibrary, usePromptLibraryHost } from "@/prompt-library";
import {
  UNTAGGED_FILTER,
  countPromptTags,
  filterPrompts,
  sortPrompts,
  type PromptSort,
} from "@/prompt-library/internal/browse";
import { PromptLibraryManagerModel } from "@/prompt-library/internal/manager-model";
import { PromptEditor } from "./editor";
import { PromptLibraryNoticeBanner, promptLibraryErrorMessage } from "./messages";
import { PromptTagChip } from "./tag-chip";
import { PromptTagFilterBar, type PromptTagFilterOption } from "./tag-filter-bar";
import { PromptTagRail } from "./tag-rail";

const ThemedSpinner = withUnistyles(LoadingSpinner, (theme) => ({
  color: theme.colors.foregroundMuted,
}));
const WIDE_MIN_WIDTH = 860;
const ScrollContainer = Platform.OS === "android" ? KeyboardAwareScrollView : ScrollView;

export function PromptLibraryPage({
  serverId,
  onBack,
}: {
  serverId: string;
  onBack?: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const compactDevice = useIsCompactFormFactor();
  const supported = useHostFeature(serverId, "promptLibrary");
  const host = usePromptLibraryHost(serverId);
  const [width, setWidth] = useState(0);
  const [filter, setFilter] = useState<string | null>(null);
  const [sort, setSort] = useState<PromptSort>("updated");
  const [copied, setCopied] = useState(false);
  const [model] = useState(
    () =>
      new PromptLibraryManagerModel({
        save: (id, input) => promptLibrary.save(id, input),
        remove: (id, promptId) => promptLibrary.remove(id, promptId),
        renameTag: (id, from, to) => promptLibrary.renameTag(id, from, to),
        deleteTag: (id, tag) => promptLibrary.deleteTag(id, tag),
      }),
  );

  useEffect(() => {
    model.open(serverId);
    void promptLibrary.ensureHydrated(serverId);
    return () => model.reset();
  }, [model, serverId]);

  // Resets the filter when its tag disappears (renamed or deleted here or on another device).
  useEffect(() => {
    if (!filter || filter === UNTAGGED_FILTER) return;
    const key = promptLibraryTagKey(filter);
    if (!host.tags.some((tag) => promptLibraryTagKey(tag) === key)) setFilter(null);
  }, [filter, host.tags]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const state = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const wide = width >= WIDE_MIN_WIDTH;
  const counts = useMemo(() => countPromptTags(host.entries), [host.entries]);
  const visible = useMemo(
    () =>
      sortPrompts(
        filterPrompts(host.entries, {
          query: state.query,
          tags: filter && filter !== UNTAGGED_FILTER ? [filter] : [],
          untagged: filter === UNTAGGED_FILTER,
        }),
        sort,
      ),
    [filter, host.entries, sort, state.query],
  );
  const pendingIds = useMemo(() => new Set(host.pendingIds), [host.pendingIds]);
  const chipOptions = useMemo<PromptTagFilterOption[]>(
    () => [
      { id: UNTAGGED_FILTER, label: t("promptLibrary.untagged"), count: counts.untagged },
      ...host.tags.map((tag) => ({
        id: tag,
        label: tag,
        count: counts.byTag.get(promptLibraryTagKey(tag)) ?? 0,
      })),
    ],
    [counts, host.tags, t],
  );
  const sortOptions = useMemo(
    () => [
      { value: "updated" as const, label: t("promptLibrary.sortUpdated") },
      { value: "title" as const, label: t("promptLibrary.sortTitle") },
    ],
    [t],
  );

  const confirmDiscard = useCallback(
    () =>
      confirmDialog({
        title: t("promptLibrary.unsavedTitle"),
        message: t("promptLibrary.unsavedMessage"),
        confirmLabel: t("promptLibrary.discard"),
        cancelLabel: t("promptLibrary.keepEditing"),
        destructive: true,
      }),
    [t],
  );
  const openEntry = useCallback(
    async (entry: PromptLibraryEntry) => {
      if (state.draft?.id === entry.id) return;
      if (await model.confirmLeave(confirmDiscard)) model.startEdit(entry);
    },
    [confirmDiscard, model, state.draft?.id],
  );
  const createPrompt = useCallback(async () => {
    if (!(await model.confirmLeave(confirmDiscard))) return;
    model.startCreate(filter && filter !== UNTAGGED_FILTER ? [filter] : []);
  }, [confirmDiscard, filter, model]);
  const leaveEditor = useCallback(async () => {
    if (await model.confirmLeave(confirmDiscard)) model.cancelEdit();
  }, [confirmDiscard, model]);
  const createTag = useCallback(
    (tag: string) => {
      if (state.draft) model.addTag(tag);
      else model.startCreate([tag]);
    },
    [model, state.draft],
  );
  const toggleChip = useCallback(
    (id: string) => setFilter((current) => (current === id ? null : id)),
    [],
  );
  const clearFilter = useCallback(() => setFilter(null), []);
  const setQuery = useCallback((value: string) => model.setQuery(value), [model]);
  const setTitle = useCallback((value: string) => model.setTitle(value), [model]);
  const setBody = useCallback((value: string) => model.setBody(value), [model]);
  const addTag = useCallback((value: string) => model.addTag(value), [model]);
  const removeTag = useCallback((value: string) => model.removeTag(value), [model]);
  const save = useCallback(async () => {
    const saved = await model.save();
    if (saved && wide) model.startEdit(saved);
  }, [model, wide]);
  const remove = useCallback(async () => {
    const draft = state.draft;
    if (!draft?.id) return;
    const confirmed = await confirmDialog({
      title: t("promptLibrary.deleteTitle", { title: draft.title }),
      message: t("promptLibrary.deleteMessage"),
      confirmLabel: t("promptLibrary.delete"),
      destructive: true,
    });
    if (confirmed) await model.remove();
  }, [model, state.draft, t]);
  const copy = useCallback(async () => {
    if (!state.draft) return;
    await Clipboard.setStringAsync(state.draft.body);
    setCopied(true);
  }, [state.draft]);
  const deleteTag = useCallback(
    async (tag: string, count: number) => {
      const confirmed = await confirmDialog({
        title: t("promptLibrary.deleteTagTitle", { name: tag }),
        message: t("promptLibrary.deleteTagMessage", { count }),
        confirmLabel: t("promptLibrary.delete"),
        destructive: true,
      });
      if (confirmed) await model.deleteTag(tag);
    },
    [model, t],
  );
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    setWidth(event.nativeEvent.layout.width);
  }, []);
  const openTags = useCallback(() => model.openTags(), [model]);
  const closeTags = useCallback(() => {
    if (state.renamingTag) model.cancelTagRename();
    else model.closeTags();
  }, [model, state.renamingTag]);
  const startTagRename = useCallback((tag: string) => model.startTagRename(tag), [model]);
  const cancelTagRename = useCallback(() => model.cancelTagRename(), [model]);
  const setTagDraft = useCallback((value: string) => model.setTagDraft(value), [model]);
  const saveTagRename = useCallback(() => {
    void model.saveTagRename();
  }, [model]);

  const rail = (selecting: boolean) => (
    <PromptTagRail
      tags={host.tags}
      counts={counts.byTag}
      total={host.entries.length}
      untagged={counts.untagged}
      {...(selecting ? { selectedFilter: filter, onSelectFilter: setFilter } : {})}
      renamingTag={state.renamingTag}
      tagDraft={state.tagDraft}
      pending={state.pending}
      onStartRename={startTagRename}
      onCancelRename={cancelTagRename}
      onTagDraft={setTagDraft}
      onSaveRename={saveTagRename}
      onDelete={deleteTag}
      onCreateTag={createTag}
    />
  );
  const list = (
    <PromptList
      entries={visible}
      totalCount={host.entries.length}
      hydrated={host.hydrated}
      selectedId={state.draft?.id ?? null}
      pendingIds={pendingIds}
      onOpen={openEntry}
      onCreate={createPrompt}
    />
  );
  const searchRow = (
    <View style={styles.controls}>
      <FormTextInput
        size="sm"
        initialValue=""
        resetKey={serverId}
        onChangeText={setQuery}
        placeholder={t("promptLibrary.searchManage")}
        accessibilityLabel={t("promptLibrary.searchManage")}
        testID="prompt-library-manager-search"
      />
      <View style={styles.controlsRow}>
        <SegmentedControl
          size="sm"
          options={sortOptions}
          value={sort}
          onValueChange={setSort}
          testID="prompt-library-sort"
        />
        <Button size="sm" onPress={createPrompt} testID="prompt-library-manager-new">
          {t("promptLibrary.newPrompt")}
        </Button>
      </View>
    </View>
  );
  const editor = state.draft ? (
    <PromptEditor
      title={state.draft.title}
      body={state.draft.body}
      tags={state.draft.tags}
      allTags={host.tags}
      resetKey={state.draft.id ?? "new"}
      isNew={!state.draft.id}
      disabled={state.pending}
      canSubmit={state.canSubmit}
      pending={state.pending}
      copied={copied}
      onTitle={setTitle}
      onBody={setBody}
      onAddTag={addTag}
      onRemoveTag={removeTag}
      onSave={save}
      onDelete={remove}
      onCopy={copy}
    />
  ) : null;
  const messages = (
    <>
      {state.error ? (
        <Text style={styles.error} testID="prompt-library-manager-error">
          {promptLibraryErrorMessage(state.error, t)}
        </Text>
      ) : null}
      <PromptLibraryNoticeBanner
        serverId={serverId}
        notice={host.notice}
        testID="prompt-library-manager-notice"
      />
    </>
  );

  let body: ReactElement;
  if (!supported || host.status === "unsupported") {
    body = (
      <Text style={styles.unsupported} testID="prompt-library-manager-unsupported">
        {t("promptLibrary.unsupported")}
      </Text>
    );
  } else if (width === 0) {
    body = <View />;
  } else if (wide) {
    body = (
      <View style={styles.columns} testID="prompt-library-wide">
        <ScrollView style={styles.railColumn} contentContainerStyle={styles.columnContent}>
          {rail(true)}
        </ScrollView>
        <View style={styles.listColumn}>
          <View style={styles.columnContent}>{searchRow}</View>
          <ScrollView contentContainerStyle={styles.columnContent}>{list}</ScrollView>
        </View>
        <ScrollView style={styles.editorColumn} contentContainerStyle={styles.columnContent}>
          {editor ?? (
            <Text style={styles.muted} testID="prompt-library-select-hint">
              {t("promptLibrary.selectHint")}
            </Text>
          )}
          {messages}
        </ScrollView>
      </View>
    );
  } else {
    body = (
      <ScrollContainer
        style={styles.flex}
        contentContainerStyle={styles.narrowContent}
        testID="prompt-library-narrow"
      >
        {state.view === "list" ? (
          <>
            <PromptTagFilterBar
              options={chipOptions}
              selectedIds={filter ? [filter] : []}
              onSelect={toggleChip}
              onClear={clearFilter}
              testID="prompt-library-chips"
            />
            {searchRow}
            {list}
            <View style={styles.manageTags}>
              <Button
                variant="ghost"
                size="sm"
                onPress={openTags}
                testID="prompt-library-manager-tags"
              >
                {t("promptLibrary.tagManager")}
              </Button>
            </View>
          </>
        ) : (
          <>
            {!compactDevice ? (
              <View style={styles.backRow}>
                <Button
                  variant="ghost"
                  size="sm"
                  leftIcon={ArrowLeft}
                  onPress={state.view === "tags" ? closeTags : leaveEditor}
                  testID="prompt-library-back"
                >
                  {state.view === "tags"
                    ? t("promptLibrary.tagManagerTitle")
                    : t("promptLibrary.back")}
                </Button>
              </View>
            ) : null}
            {state.view === "tags" ? rail(false) : editor}
          </>
        )}
        {messages}
      </ScrollContainer>
    );
  }

  const title = t("promptLibrary.manageTitle");
  return (
    <View style={styles.page} onLayout={onLayout} testID="prompt-library-page">
      <PromptPageHeader
        compact={compactDevice}
        view={state.view}
        title={title}
        host={host}
        onBack={onBack}
        closeTags={closeTags}
        leaveEditor={leaveEditor}
      />
      {body}
    </View>
  );
}

function PromptPageHeader({
  compact,
  view,
  title,
  host,
  onBack,
  closeTags,
  leaveEditor,
}: {
  compact: boolean;
  view: "list" | "tags" | "edit";
  title: string;
  host: ReturnType<typeof usePromptLibraryHost>;
  onBack?: () => void;
  closeTags: () => void;
  leaveEditor: () => void;
}): ReactElement {
  const { t } = useTranslation();
  let back = onBack;
  if (view === "tags") back = closeTags;
  if (view === "edit") back = leaveEditor;
  return (
    <>
      {compact ? (
        <BackHeader
          title={view === "tags" ? t("promptLibrary.tagManagerTitle") : title}
          onBack={back}
        />
      ) : (
        <MenuHeader borderless />
      )}
      {(!compact || view === "list") && (
        <View style={styles.titleRow}>
          {compact ? null : <Text style={styles.title}>{title}</Text>}
          <PromptLibraryStatus host={host} />
        </View>
      )}
    </>
  );
}

function PromptLibraryStatus({
  host,
}: {
  host: ReturnType<typeof usePromptLibraryHost>;
}): ReactElement | null {
  const { t } = useTranslation();
  const offline = host.status === "offline" || host.status === "error";
  if (!offline && host.pendingCount === 0) return null;
  return (
    <View style={styles.statusGroup}>
      {offline ? (
        <Text style={styles.muted} numberOfLines={1} testID="prompt-library-manager-offline">
          {t("promptLibrary.offline")}
        </Text>
      ) : null}
      {host.pendingCount > 0 ? (
        <Text style={styles.muted} numberOfLines={1} testID="prompt-library-manager-pending">
          {t("promptLibrary.pending", { count: host.pendingCount })}
        </Text>
      ) : null}
    </View>
  );
}

function PromptList({
  entries,
  totalCount,
  hydrated,
  selectedId,
  pendingIds,
  onOpen,
  onCreate,
}: {
  entries: readonly PromptLibraryEntry[];
  totalCount: number;
  hydrated: boolean;
  selectedId: string | null;
  pendingIds: ReadonlySet<string>;
  onOpen: (entry: PromptLibraryEntry) => void;
  onCreate: () => void;
}): ReactElement {
  const { t } = useTranslation();
  if (!hydrated && totalCount === 0) {
    return (
      <View style={styles.loading}>
        <ThemedSpinner size="small" />
      </View>
    );
  }
  if (entries.length === 0) {
    return (
      <View style={styles.empty} testID="prompt-library-manager-empty">
        <Text style={styles.muted}>
          {totalCount === 0 ? t("promptLibrary.emptyGuide") : t("promptLibrary.emptyFiltered")}
        </Text>
        <Button size="sm" onPress={onCreate} testID="prompt-library-empty-new">
          {t("promptLibrary.newPrompt")}
        </Button>
      </View>
    );
  }
  return (
    <View style={styles.list}>
      {entries.map((entry) => (
        <EntryRow
          key={entry.id}
          entry={entry}
          selected={entry.id === selectedId}
          pending={pendingIds.has(entry.id)}
          onOpen={onOpen}
        />
      ))}
    </View>
  );
}

function EntryRow({
  entry,
  selected,
  pending,
  onOpen,
}: {
  entry: PromptLibraryEntry;
  selected: boolean;
  pending: boolean;
  onOpen: (entry: PromptLibraryEntry) => void;
}): ReactElement {
  const { t } = useTranslation();
  const open = useCallback(() => onOpen(entry), [entry, onOpen]);
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  return (
    <PressHighlight
      accessibilityRole="button"
      accessibilityLabel={`${t("promptLibrary.editPrompt")} ${entry.title}`}
      accessibilityState={accessibilityState}
      onPress={open}
      style={[styles.entryRow, selected && styles.entryRowSelected]}
      testID={`prompt-library-manager-row-${entry.id}`}
    >
      <View style={styles.entryHeader}>
        <Text style={styles.entryTitle} numberOfLines={1}>
          {entry.title}
        </Text>
        {pending ? (
          <StatusBadge size="xs" variant="warning" label={t("promptLibrary.notSynced")} />
        ) : null}
      </View>
      <Text style={styles.entryBody} numberOfLines={2}>
        {entry.body}
      </Text>
      {entry.tags.length > 0 ? (
        <View style={styles.entryTags}>
          {entry.tags.slice(0, 4).map((tag) => (
            <PromptTagChip key={tag.toLowerCase()} tag={tag} />
          ))}
        </View>
      ) : null}
      <Text style={styles.entryTime}>{new Date(entry.updatedAt).toLocaleString()}</Text>
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  page: {
    flex: 1,
    backgroundColor: theme.colors.bgCanvas,
  },
  flex: {
    flex: 1,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[3],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xl,
    fontWeight: theme.fontWeight.semibold,
  },
  statusGroup: {
    flexShrink: 1,
    alignItems: "flex-end",
  },
  columns: {
    flex: 1,
    flexDirection: "row",
    borderTopWidth: 1,
    borderTopColor: theme.colors.borderStrong,
  },
  railColumn: {
    width: 220,
    flexGrow: 0,
    borderRightWidth: 1,
    borderRightColor: theme.colors.borderStrong,
  },
  listColumn: {
    width: 340,
    borderRightWidth: 1,
    borderRightColor: theme.colors.borderStrong,
  },
  editorColumn: {
    flex: 1,
    minWidth: 0,
  },
  columnContent: {
    padding: theme.spacing[3],
    gap: theme.spacing[3],
  },
  narrowContent: {
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  controls: {
    gap: theme.spacing[2],
  },
  controlsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  list: {
    gap: theme.spacing[1],
  },
  entryRow: {
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    minHeight: 64,
    borderRadius: theme.borderRadius.lg,
  },
  entryRowSelected: {
    backgroundColor: theme.colors.bgControlActive,
  },
  entryHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  entryTitle: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  entryBody: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  entryTags: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
  },
  entryTime: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  empty: {
    alignItems: "flex-start",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  loading: {
    alignItems: "center",
    paddingVertical: theme.spacing[4],
  },
  manageTags: {
    alignItems: "flex-start",
  },
  backRow: {
    alignItems: "flex-start",
  },
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  unsupported: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[4],
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
  },
}));
