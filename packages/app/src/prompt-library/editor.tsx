import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Copy, X } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  PROMPT_LIBRARY_BODY_MAX_LENGTH,
  PROMPT_LIBRARY_TITLE_MAX_LENGTH,
} from "@getpaseo/protocol/prompt-library";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { Theme } from "@/styles/theme";
import { suggestPromptTags } from "@/prompt-library/internal/browse";
import { PromptTagChip } from "./tag-chip";

const ThemedX = withUnistyles(X);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
// A plain object: FormTextInput reads layout keys from its style prop, which Unistyles hides on web.
const BODY_INPUT_STYLE = { height: 280, paddingTop: 8, textAlignVertical: "top" } as const;
const COMMA = /[,，]/;

export interface PromptEditorProps {
  title: string;
  body: string;
  tags: string[];
  allTags: readonly string[];
  /** Identifies the draft; changing it resets the uncontrolled inputs. */
  resetKey: string;
  isNew: boolean;
  disabled: boolean;
  canSubmit: boolean;
  pending: boolean;
  copied: boolean;
  onTitle: (value: string) => void;
  onBody: (value: string) => void;
  onAddTag: (value: string) => void;
  onRemoveTag: (value: string) => void;
  onSave: () => void;
  onDelete: () => void;
  onCopy: () => void;
}

export function PromptEditor(props: PromptEditorProps): ReactElement {
  const { t } = useTranslation();
  const size = useIsCompactFormFactor() ? "md" : "sm";
  const { disabled, onAddTag } = props;
  const [tagText, setTagText] = useState("");
  const [tagInit, setTagInit] = useState("");
  const [tagReset, setTagReset] = useState(0);
  const resetTagInput = useCallback((rest: string) => {
    setTagText(rest);
    setTagInit(rest);
    setTagReset((value) => value + 1);
  }, []);
  const commitTag = useCallback(() => {
    onAddTag(tagText);
    resetTagInput("");
  }, [onAddTag, resetTagInput, tagText]);
  // A comma (ASCII or full-width) confirms the tag typed before it.
  const changeTagText = useCallback(
    (value: string) => {
      if (!COMMA.test(value)) {
        setTagText(value);
        return;
      }
      const parts = value.split(COMMA);
      const rest = parts.pop() ?? "";
      for (const part of parts) onAddTag(part);
      resetTagInput(rest);
    },
    [onAddTag, resetTagInput],
  );
  const suggestions = useMemo(
    () => suggestPromptTags({ allTags: props.allTags, selected: props.tags, text: tagText }),
    [props.allTags, props.tags, tagText],
  );
  const bodyLength = props.body.length;
  const overLimit = bodyLength > PROMPT_LIBRARY_BODY_MAX_LENGTH;

  const counter = useMemo(
    () => (
      <Text
        style={overLimit ? styles.counterOver : styles.counter}
        testID="prompt-library-body-count"
      >
        {t("promptLibrary.charCount", { count: bodyLength, max: PROMPT_LIBRARY_BODY_MAX_LENGTH })}
      </Text>
    ),
    [bodyLength, overLimit, t],
  );

  return (
    <View style={styles.form} testID="prompt-library-editor">
      <Field label={t("promptLibrary.titleLabel")}>
        <FormTextInput
          size={size}
          initialValue={props.title}
          resetKey={`${props.resetKey}:title`}
          onChangeText={props.onTitle}
          editable={!disabled}
          maxLength={PROMPT_LIBRARY_TITLE_MAX_LENGTH}
          placeholder={t("promptLibrary.titlePlaceholder")}
          testID="prompt-library-manager-title"
        />
      </Field>
      <Field label={t("promptLibrary.bodyLabel")} trailing={counter}>
        <FormTextInput
          size={size}
          initialValue={props.body}
          resetKey={`${props.resetKey}:body`}
          onChangeText={props.onBody}
          editable={!disabled}
          multiline
          placeholder={t("promptLibrary.bodyPlaceholder")}
          style={BODY_INPUT_STYLE}
          testID="prompt-library-manager-body"
        />
      </Field>
      <Field label={t("promptLibrary.tagsLabel")}>
        <View style={styles.tagEditor}>
          {props.tags.length > 0 ? (
            <View style={styles.tagList}>
              {props.tags.map((tag) => (
                <PromptTagPill
                  key={tag.toLowerCase()}
                  tag={tag}
                  disabled={disabled}
                  onRemove={props.onRemoveTag}
                />
              ))}
            </View>
          ) : null}
          <View style={styles.tagInputRow}>
            <View style={styles.tagInputGrow}>
              <FormTextInput
                size={size}
                initialValue={tagInit}
                resetKey={tagReset}
                onChangeText={changeTagText}
                onSubmitEditing={commitTag}
                editable={!disabled}
                placeholder={t("promptLibrary.tagPlaceholder")}
                accessibilityLabel={t("promptLibrary.addTag")}
                testID="prompt-library-manager-tag-input"
              />
            </View>
            <Button
              variant="ghost"
              size={size}
              disabled={disabled || tagText.trim().length === 0}
              onPress={commitTag}
              testID="prompt-library-manager-add-tag"
            >
              {t("promptLibrary.addTag")}
            </Button>
          </View>
          {suggestions.length > 0 ? (
            <View style={styles.tagList} testID="prompt-library-tag-suggestions">
              {suggestions.map((tag) => (
                <PromptTagChip
                  key={tag.toLowerCase()}
                  tag={tag}
                  onSelect={disabled ? undefined : props.onAddTag}
                  testID={`prompt-library-suggest-${tag}`}
                />
              ))}
            </View>
          ) : null}
        </View>
      </Field>
      <View style={styles.actions}>
        {props.isNew ? (
          <View />
        ) : (
          <Button
            variant="outline"
            size={size}
            disabled={props.pending}
            onPress={props.onDelete}
            testID="prompt-library-manager-delete"
          >
            {t("promptLibrary.delete")}
          </Button>
        )}
        <View style={styles.actionsEnd}>
          <Button
            variant="ghost"
            size={size}
            disabled={props.body.length === 0}
            onPress={props.onCopy}
            leftIcon={Copy}
            testID="prompt-library-manager-copy"
          >
            {props.copied ? t("promptLibrary.copied") : t("promptLibrary.copy")}
          </Button>
          <Button
            size={size}
            style={styles.saveButton}
            disabled={!props.canSubmit || props.pending || overLimit}
            loading={props.pending}
            onPress={props.onSave}
            testID="prompt-library-manager-save"
          >
            {props.pending ? t("promptLibrary.saving") : t("promptLibrary.save")}
          </Button>
        </View>
      </View>
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
  counter: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  counterOver: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
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
  actions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  actionsEnd: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  saveButton: {
    minWidth: 112,
  },
}));
