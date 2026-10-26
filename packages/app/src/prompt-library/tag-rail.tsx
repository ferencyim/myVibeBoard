import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Pencil, Trash2 } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { promptLibraryTagKey } from "@getpaseo/protocol/prompt-library";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { Theme } from "@/styles/theme";
import { UNTAGGED_FILTER } from "@/prompt-library/internal/browse";

const ThemedPencil = withUnistyles(Pencil);
const ThemedTrash = withUnistyles(Trash2);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export interface PromptTagRailProps {
  tags: readonly string[];
  counts: ReadonlyMap<string, number>;
  total: number;
  untagged: number;
  /** When `onSelectFilter` is set the "All" and "Untagged" rows show and rows filter. */
  selectedFilter?: string | null;
  onSelectFilter?: (filter: string | null) => void;
  renamingTag: string | null;
  tagDraft: string;
  pending: boolean;
  onStartRename: (tag: string) => void;
  onCancelRename: () => void;
  onTagDraft: (value: string) => void;
  onSaveRename: () => void;
  onDelete: (tag: string, count: number) => void;
  onCreateTag: (tag: string) => void;
}

export function PromptTagRail(props: PromptTagRailProps): ReactElement {
  const { t } = useTranslation();
  const size = useIsCompactFormFactor() ? "md" : "sm";
  const { onCreateTag, onSelectFilter, selectedFilter } = props;
  const filtering = onSelectFilter !== undefined;
  const [newTag, setNewTag] = useState("");
  const [newReset, setNewReset] = useState(0);
  const create = useCallback(() => {
    const value = newTag.trim();
    if (!value) return;
    onCreateTag(value);
    setNewTag("");
    setNewReset((n) => n + 1);
  }, [newTag, onCreateTag]);
  const selectedKey = useMemo(
    () =>
      selectedFilter && selectedFilter !== UNTAGGED_FILTER
        ? promptLibraryTagKey(selectedFilter)
        : null,
    [selectedFilter],
  );

  return (
    <View style={styles.rail} testID="prompt-library-tag-rail">
      {props.renamingTag ? (
        <Field label={t("promptLibrary.renameTagTitle", { name: props.renamingTag })}>
          <FormTextInput
            size={size}
            initialValue={props.tagDraft}
            resetKey={props.renamingTag}
            onChangeText={props.onTagDraft}
            onSubmitEditing={props.onSaveRename}
            editable={!props.pending}
            autoFocus
            testID="prompt-library-manager-tag-rename-input"
          />
          <View style={styles.renameActions}>
            <Button
              variant="ghost"
              size="sm"
              disabled={props.pending}
              onPress={props.onCancelRename}
              testID="prompt-library-manager-tag-rename-cancel"
            >
              {t("promptLibrary.cancel")}
            </Button>
            <Button
              size="sm"
              disabled={props.pending || props.tagDraft.trim().length === 0}
              loading={props.pending}
              onPress={props.onSaveRename}
              testID="prompt-library-manager-tag-rename-save"
            >
              {t("promptLibrary.save")}
            </Button>
          </View>
        </Field>
      ) : null}
      {filtering ? (
        <>
          <FilterRow
            id={null}
            label={t("promptLibrary.allTags")}
            count={props.total}
            selected={selectedFilter === null}
            onSelect={onSelectFilter}
            testID="prompt-library-rail-all"
          />
          <FilterRow
            id={UNTAGGED_FILTER}
            label={t("promptLibrary.untagged")}
            count={props.untagged}
            selected={selectedFilter === UNTAGGED_FILTER}
            onSelect={onSelectFilter}
            testID="prompt-library-rail-untagged"
          />
        </>
      ) : null}
      {props.tags.map((tag) => (
        <TagRow
          key={tag.toLowerCase()}
          tag={tag}
          count={props.counts.get(promptLibraryTagKey(tag)) ?? 0}
          selected={selectedKey === promptLibraryTagKey(tag)}
          pending={props.pending}
          onSelect={onSelectFilter}
          onStartRename={props.onStartRename}
          onDelete={props.onDelete}
        />
      ))}
      {props.tags.length === 0 ? (
        <Text style={styles.muted} testID="prompt-library-tag-empty">
          {t("promptLibrary.noTags")}
        </Text>
      ) : null}
      <View style={styles.newTag}>
        <View style={styles.newTagInput}>
          <FormTextInput
            size={size}
            initialValue=""
            resetKey={newReset}
            onChangeText={setNewTag}
            onSubmitEditing={create}
            placeholder={t("promptLibrary.newTagPlaceholder")}
            accessibilityLabel={t("promptLibrary.newTag")}
            testID="prompt-library-new-tag-input"
          />
        </View>
        <Button
          variant="ghost"
          size={size}
          disabled={newTag.trim().length === 0}
          onPress={create}
          testID="prompt-library-new-tag-add"
        >
          {t("promptLibrary.newTag")}
        </Button>
      </View>
    </View>
  );
}

function FilterRow({
  id,
  label,
  count,
  selected,
  onSelect,
  testID,
}: {
  id: string | null;
  label: string;
  count: number;
  selected: boolean;
  onSelect?: (filter: string | null) => void;
  testID: string;
}): ReactElement {
  const select = useCallback(() => onSelect?.(id), [id, onSelect]);
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  return (
    <PressHighlight
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      onPress={select}
      style={[styles.row, selected && styles.rowSelected]}
      testID={testID}
    >
      <Text style={styles.rowLabel} numberOfLines={1}>
        {label}
      </Text>
      <Text style={styles.count}>{count}</Text>
    </PressHighlight>
  );
}

function TagRow({
  tag,
  count,
  selected,
  pending,
  onSelect,
  onStartRename,
  onDelete,
}: {
  tag: string;
  count: number;
  selected: boolean;
  pending: boolean;
  onSelect?: (filter: string | null) => void;
  onStartRename: (tag: string) => void;
  onDelete: (tag: string, count: number) => void;
}): ReactElement {
  const { t } = useTranslation();
  const select = useCallback(() => onSelect?.(tag), [onSelect, tag]);
  const startRename = useCallback(() => onStartRename(tag), [onStartRename, tag]);
  const remove = useCallback(() => onDelete(tag, count), [count, onDelete, tag]);
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  return (
    <View style={styles.tagRowWrap} testID={`prompt-library-tag-${tag}`}>
      <PressHighlight
        accessibilityRole="button"
        accessibilityState={accessibilityState}
        disabled={!onSelect}
        onPress={select}
        style={[styles.row, styles.rowGrow, selected && styles.rowSelected]}
        testID={`prompt-library-rail-tag-${tag}`}
      >
        <Text style={styles.rowLabel} numberOfLines={1}>
          {tag}
        </Text>
        <Text style={styles.count}>{count}</Text>
      </PressHighlight>
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

const styles = StyleSheet.create((theme) => ({
  rail: {
    gap: theme.spacing[1],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    minHeight: 32,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  rowGrow: {
    flex: 1,
    minWidth: 0,
  },
  rowSelected: {
    backgroundColor: theme.colors.surface2,
  },
  rowLabel: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  count: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  tagRowWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  renameActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
  newTag: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[1],
    paddingTop: theme.spacing[2],
  },
  newTagInput: {
    flex: 1,
    minWidth: 0,
  },
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[2],
  },
}));
