import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Pencil, Trash2, X } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { PressHighlight } from "@/components/ui/press-highlight";
import type { Theme } from "@/styles/theme";
import { confirmDialog } from "@/utils/confirm-dialog";
import { promptLibrary, usePromptLibraryHost } from "@/prompt-library";
import { PromptLibraryManagerModel } from "@/prompt-library/internal/manager-model";
import { filterPromptEntries, hasPromptTag } from "@/prompt-library/internal/merge";
import { PromptLibraryNoticeBanner, promptLibraryErrorMessage } from "./messages";
import { PromptTagChip } from "./tag-chip";
import type { PromptLibraryEntry } from "@getpaseo/protocol/prompt-library";

const ThemedPencil = withUnistyles(Pencil);
const ThemedTrash = withUnistyles(Trash2);
const ThemedX = withUnistyles(X);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function PromptLibraryManagerSheet({
  serverId,
  visible,
  onClose,
}: {
  serverId: string;
  visible: boolean;
  onClose: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const host = usePromptLibraryHost(serverId);
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
    if (!visible) {
      model.reset();
      return;
    }
    model.open(serverId);
    void promptLibrary.ensureHydrated(serverId);
  }, [model, serverId, visible]);

  const state = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const query = state.query;
  const entries = useMemo(
    () => filterPromptEntries({ entries: host.entries, query, tag: null }),
    [host.entries, query],
  );
  const startCreate = useCallback(() => model.startCreate(), [model]);
  const setQuery = useCallback((value: string) => model.setQuery(value), [model]);
  const cancelEdit = useCallback(() => model.cancelEdit(), [model]);
  const cancelTagRename = useCallback(() => model.cancelTagRename(), [model]);
  const backFromTags = useCallback(() => {
    if (state.renamingTag) model.cancelTagRename();
    else model.closeTags();
  }, [model, state.renamingTag]);
  const save = useCallback(() => {
    void model.save();
  }, [model]);
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
  const openTags = useCallback(() => model.openTags(), [model]);
  const editEntry = useCallback((entry: PromptLibraryEntry) => model.startEdit(entry), [model]);
  const onTitle = useCallback((value: string) => model.setTitle(value), [model]);
  const onBody = useCallback((value: string) => model.setBody(value), [model]);
  const onAddTag = useCallback((value: string) => model.addTag(value), [model]);
  const onRemoveTag = useCallback((value: string) => model.removeTag(value), [model]);
  const startTagRename = useCallback((tag: string) => model.startTagRename(tag), [model]);
  const setTagDraft = useCallback((value: string) => model.setTagDraft(value), [model]);
  const saveTagRename = useCallback(() => {
    void model.saveTagRename();
  }, [model]);
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
  const header = useMemo<SheetHeader>(() => {
    if (state.view === "edit") {
      return {
        title: state.draft?.id ? t("promptLibrary.editPrompt") : t("promptLibrary.newPrompt"),
        back: { onPress: cancelEdit },
      };
    }
    if (state.view === "tags") {
      return {
        title: t("promptLibrary.tagManagerTitle"),
        back: { onPress: backFromTags },
      };
    }
    return {
      title: t("promptLibrary.manageTitle"),
      search: {
        onChange: setQuery,
        resetKey: visible ? "open" : "closed",
        placeholder: t("promptLibrary.searchManage"),
        testID: "prompt-library-manager-search",
      },
    };
  }, [backFromTags, cancelEdit, setQuery, state.draft?.id, state.view, t, visible]);

  const footer = useMemo(() => {
    if (state.view === "edit" && state.draft) {
      return (
        <View style={styles.footer}>
          {state.draft.id ? (
            <Button
              variant="outline"
              size="md"
              disabled={state.pending}
              onPress={remove}
              testID="prompt-library-manager-delete"
            >
              {t("promptLibrary.delete")}
            </Button>
          ) : (
            <View />
          )}
          <Button
            size="md"
            style={styles.saveButton}
            disabled={!state.canSubmit || state.pending}
            loading={state.pending}
            onPress={save}
            testID="prompt-library-manager-save"
          >
            {state.pending ? t("promptLibrary.saving") : t("promptLibrary.save")}
          </Button>
        </View>
      );
    }
    if (state.view === "list") {
      return (
        <Button
          variant="default"
          size="md"
          onPress={startCreate}
          testID="prompt-library-manager-new"
        >
          {t("promptLibrary.newPrompt")}
        </Button>
      );
    }
    return undefined;
  }, [remove, save, startCreate, state.canSubmit, state.draft, state.pending, state.view, t]);

  return (
    <AdaptiveModalSheet
      visible={visible}
      onClose={onClose}
      header={header}
      footer={footer}
      desktopMaxWidth={640}
      testID="prompt-library-manager"
    >
      {state.view === "edit" && state.draft ? (
        <PromptEditor
          title={state.draft.title}
          body={state.draft.body}
          tags={state.draft.tags}
          resetKey={state.draft.id ?? "new"}
          disabled={state.pending}
          onTitle={onTitle}
          onBody={onBody}
          onAddTag={onAddTag}
          onRemoveTag={onRemoveTag}
        />
      ) : null}
      {state.view === "list" ? (
        <>
          <View style={styles.list}>
            {entries.map((entry) => (
              <ManagerPromptRow key={entry.id} entry={entry} onEdit={editEntry} />
            ))}
          </View>
          {entries.length === 0 ? (
            <Text style={styles.muted} testID="prompt-library-manager-empty">
              {host.entries.length === 0
                ? t("promptLibrary.emptyManage")
                : t("promptLibrary.emptySearch")}
            </Text>
          ) : null}
          <View style={styles.tagManagerEntry}>
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
      ) : null}
      {state.view === "tags" ? (
        <TagManager
          tags={host.tags}
          entries={host.entries}
          renamingTag={state.renamingTag}
          tagDraft={state.tagDraft}
          pending={state.pending}
          onStartRename={startTagRename}
          onCancelRename={cancelTagRename}
          onTagDraft={setTagDraft}
          onSaveRename={saveTagRename}
          onDelete={deleteTag}
        />
      ) : null}
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
      {host.status === "unsupported" ? (
        <Text style={styles.muted} testID="prompt-library-manager-unsupported">
          {t("promptLibrary.unsupported")}
        </Text>
      ) : null}
      {host.status === "offline" || host.status === "error" ? (
        <Text style={styles.muted} testID="prompt-library-manager-offline">
          {t("promptLibrary.offline")}
        </Text>
      ) : null}
    </AdaptiveModalSheet>
  );
}

function PromptEditor({
  title,
  body,
  tags,
  resetKey,
  disabled,
  onTitle,
  onBody,
  onAddTag,
  onRemoveTag,
}: {
  title: string;
  body: string;
  tags: string[];
  resetKey: string;
  disabled: boolean;
  onTitle: (value: string) => void;
  onBody: (value: string) => void;
  onAddTag: (value: string) => void;
  onRemoveTag: (value: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const size = useIsCompactFormFactor() ? "md" : "sm";
  const [tagDraft, setTagDraft] = useState("");
  const [tagReset, setTagReset] = useState(0);
  const addTag = useCallback(() => {
    onAddTag(tagDraft);
    setTagDraft("");
    setTagReset((value) => value + 1);
  }, [onAddTag, tagDraft]);

  return (
    <View style={styles.form}>
      <Field label={t("promptLibrary.titleLabel")}>
        <FormTextInput
          size={size}
          initialValue={title}
          resetKey={`${resetKey}:title`}
          onChangeText={onTitle}
          editable={!disabled}
          placeholder={t("promptLibrary.titlePlaceholder")}
          testID="prompt-library-manager-title"
        />
      </Field>
      <Field label={t("promptLibrary.bodyLabel")}>
        <FormTextInput
          size={size}
          initialValue={body}
          resetKey={`${resetKey}:body`}
          onChangeText={onBody}
          editable={!disabled}
          multiline
          placeholder={t("promptLibrary.bodyPlaceholder")}
          style={styles.bodyInput}
          testID="prompt-library-manager-body"
        />
      </Field>
      <Field label={t("promptLibrary.tagsLabel")}>
        <View style={styles.tagEditor}>
          {tags.length > 0 ? (
            <View style={styles.tagList}>
              {tags.map((tag) => (
                <PromptTagPill
                  key={tag.toLowerCase()}
                  tag={tag}
                  disabled={disabled}
                  onRemove={onRemoveTag}
                />
              ))}
            </View>
          ) : null}
          <View style={styles.tagInputRow}>
            <View style={styles.tagInputGrow}>
              <FormTextInput
                size={size}
                initialValue=""
                resetKey={tagReset}
                onChangeText={setTagDraft}
                onSubmitEditing={addTag}
                editable={!disabled}
                placeholder={t("promptLibrary.tagPlaceholder")}
                accessibilityLabel={t("promptLibrary.addTag")}
                testID="prompt-library-manager-tag-input"
              />
            </View>
            <Button
              variant="ghost"
              size={size}
              disabled={disabled || tagDraft.trim().length === 0}
              onPress={addTag}
              testID="prompt-library-manager-add-tag"
            >
              {t("promptLibrary.addTag")}
            </Button>
          </View>
        </View>
      </Field>
    </View>
  );
}

function ManagerPromptRow({
  entry,
  onEdit,
}: {
  entry: PromptLibraryEntry;
  onEdit: (entry: PromptLibraryEntry) => void;
}): ReactElement {
  const { t } = useTranslation();
  const edit = useCallback(() => onEdit(entry), [entry, onEdit]);
  return (
    <PressHighlight
      accessibilityRole="button"
      accessibilityLabel={t("promptLibrary.editPrompt")}
      onPress={edit}
      style={styles.managerRow}
      testID={`prompt-library-manager-row-${entry.id}`}
    >
      <View style={styles.managerRowText}>
        <Text style={styles.managerRowTitle} numberOfLines={1}>
          {entry.title}
        </Text>
        {entry.tags.length > 0 ? (
          <View style={styles.rowTags}>
            {entry.tags.slice(0, 4).map((tag) => (
              <PromptTagChip key={tag.toLowerCase()} tag={tag} />
            ))}
          </View>
        ) : null}
        <Text style={styles.managerRowBody} numberOfLines={1}>
          {entry.body}
        </Text>
      </View>
      <ThemedPencil size={14} uniProps={mutedMapping} />
    </PressHighlight>
  );
}

function TagManager({
  tags,
  entries,
  renamingTag,
  tagDraft,
  pending,
  onStartRename,
  onCancelRename,
  onTagDraft,
  onSaveRename,
  onDelete,
}: {
  tags: readonly string[];
  entries: readonly PromptLibraryEntry[];
  renamingTag: string | null;
  tagDraft: string;
  pending: boolean;
  onStartRename: (tag: string) => void;
  onCancelRename: () => void;
  onTagDraft: (value: string) => void;
  onSaveRename: () => void;
  onDelete: (tag: string, count: number) => void;
}): ReactElement {
  const { t } = useTranslation();
  const size = useIsCompactFormFactor() ? "md" : "sm";
  return (
    <View style={styles.form}>
      {renamingTag ? (
        <Field label={t("promptLibrary.renameTagTitle", { name: renamingTag })}>
          <FormTextInput
            size={size}
            initialValue={tagDraft}
            resetKey={renamingTag}
            onChangeText={onTagDraft}
            onSubmitEditing={onSaveRename}
            editable={!pending}
            autoFocus
            testID="prompt-library-manager-tag-rename-input"
          />
          <View style={styles.renameActions}>
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onPress={onCancelRename}
              testID="prompt-library-manager-tag-rename-cancel"
            >
              {t("promptLibrary.cancel")}
            </Button>
            <Button
              size="sm"
              disabled={pending || tagDraft.trim().length === 0}
              loading={pending}
              onPress={onSaveRename}
              testID="prompt-library-manager-tag-rename-save"
            >
              {t("promptLibrary.save")}
            </Button>
          </View>
        </Field>
      ) : null}
      <View style={styles.list}>
        {tags.map((tag) => {
          const count = entries.filter((entry) => hasPromptTag(entry, tag)).length;
          return (
            <TagManagerRow
              key={tag.toLowerCase()}
              tag={tag}
              count={count}
              pending={pending}
              onStartRename={onStartRename}
              onDelete={onDelete}
            />
          );
        })}
      </View>
      {tags.length === 0 ? (
        <Text style={styles.muted} testID="prompt-library-tag-empty">
          {t("promptLibrary.noTags")}
        </Text>
      ) : null}
    </View>
  );
}

function TagManagerRow({
  tag,
  count,
  pending,
  onStartRename,
  onDelete,
}: {
  tag: string;
  count: number;
  pending: boolean;
  onStartRename: (tag: string) => void;
  onDelete: (tag: string, count: number) => void;
}): ReactElement {
  const { t } = useTranslation();
  const startRename = useCallback(() => onStartRename(tag), [onStartRename, tag]);
  const remove = useCallback(() => onDelete(tag, count), [count, onDelete, tag]);
  return (
    <View style={styles.tagRow} testID={`prompt-library-tag-${tag}`}>
      <PromptTagChip tag={tag} />
      <Text style={styles.tagCount}>{t("promptLibrary.tagCount", { count })}</Text>
      <ToolbarButton
        compact
        label={t("promptLibrary.renameTag")}
        disabled={pending}
        onPress={startRename}
        testID={`prompt-library-tag-rename-${tag}`}
      >
        <ThemedPencil size={14} uniProps={mutedMapping} />
      </ToolbarButton>
      <ToolbarButton
        compact
        label={t("promptLibrary.deleteTag")}
        disabled={pending}
        onPress={remove}
        testID={`prompt-library-tag-delete-${tag}`}
      >
        <ThemedTrash size={14} uniProps={mutedMapping} />
      </ToolbarButton>
    </View>
  );
}

function PromptTagPill({
  tag,
  disabled,
  onRemove,
}: {
  tag: string;
  disabled: boolean;
  onRemove: (tag: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const remove = useCallback(() => onRemove(tag), [onRemove, tag]);
  return (
    <View style={styles.tagPill}>
      <Text style={styles.tagPillLabel}>{tag}</Text>
      <ToolbarButton
        compact
        label={t("promptLibrary.removeTag", { name: tag })}
        disabled={disabled}
        onPress={remove}
        testID={`prompt-library-manager-remove-tag-${tag}`}
      >
        <ThemedX size={12} uniProps={mutedMapping} />
      </ToolbarButton>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  form: {
    gap: theme.spacing[4],
    paddingBottom: theme.spacing[2],
  },
  footer: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  saveButton: {
    minWidth: 112,
  },
  list: {
    gap: theme.spacing[1],
  },
  managerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  managerRowText: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  managerRowTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  managerRowBody: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  rowTags: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
  },
  bodyInput: {
    minHeight: 140,
    paddingTop: theme.spacing[2],
    textAlignVertical: "top",
  },
  tagEditor: {
    gap: theme.spacing[2],
  },
  tagInputRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
  },
  tagInputGrow: {
    flex: 1,
    minWidth: 0,
  },
  tagList: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
  },
  tagPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingLeft: theme.spacing[2],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
  },
  tagPillLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  tagRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 32,
  },
  tagCount: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  renameActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
  tagManagerEntry: {
    alignItems: "flex-start",
    paddingTop: theme.spacing[2],
  },
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    paddingTop: theme.spacing[2],
  },
}));
