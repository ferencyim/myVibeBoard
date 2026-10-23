import type { PluginTheme } from "@getpaseo/plugin";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import React, { useEffect, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";

export interface BehaviourPrompt {
  key: string;
  title: string;
  description: string;
  whenSent: string;
  audience: string;
  defaultText: string;
  placeholders: Array<{ name: string; description: string }>;
  fixedSuffix: string;
  globalOverride: string | null;
  projectOverride: string | null;
  overriddenProjects: string[];
}
export interface PromptActions {
  save(input: { key: string; text: string; projectId: string | null }): Promise<unknown>;
  clear(input: { key: string; projectId: string | null }): Promise<unknown>;
}
const SOURCE_LABELS = { default: "默认", global: "全局覆盖", project: "项目覆盖" } as const;
const ownOverride = (p: BehaviourPrompt, projectId: string | null) =>
  projectId ? p.projectOverride : p.globalOverride;
const inheritedText = (p: BehaviourPrompt, projectId: string | null) =>
  projectId ? (p.globalOverride ?? p.defaultText) : p.defaultText;
const editorText = (p: BehaviourPrompt, projectId: string | null) =>
  ownOverride(p, projectId) ?? inheritedText(p, projectId);
const textToSave = (p: BehaviourPrompt, projectId: string | null, draft: string) =>
  draft.trim() === inheritedText(p, projectId).trim() ? "" : draft;
const sourceIn = (p: BehaviourPrompt, projectId: string | null): keyof typeof SOURCE_LABELS =>
  projectId && p.projectOverride !== null
    ? "project"
    : p.globalOverride !== null
      ? "global"
      : "default";
const unknownIn = (p: BehaviourPrompt, draft: string) => {
  if (!p.placeholders.length) return [];
  const known = new Set(p.placeholders.map((v) => v.name));
  return [
    ...new Set(
      [...draft.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)]
        .map((m) => m[1]!)
        .filter((name) => !known.has(name)),
    ),
  ];
};
function Muted({ theme, children }: { theme: PluginTheme; children: ReactNode }) {
  return <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{children}</Text>;
}
function Btn({
  theme,
  label,
  onPress,
  disabled,
}: {
  theme: PluginTheme;
  label: string;
  onPress(): void;
  disabled?: boolean;
  variant?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={{ padding: 8, opacity: disabled ? 0.5 : 1 }}
    >
      <Text style={{ color: theme.colors.foreground }}>{label}</Text>
    </Pressable>
  );
}

export function PromptGroup({
  label,
  prompts,
  projectId,
  projects,
  theme,
  save,
  clear,
}: {
  label: string;
  prompts: BehaviourPrompt[];
  projectId: string | null;
  projects: Array<{ id: string; name: string }>;
  theme: PluginTheme;
  save: PromptActions["save"];
  clear: PromptActions["clear"];
}) {
  const [open, setOpen] = useState(false);
  const changed = prompts.filter(
    (p) => p.globalOverride !== null || p.overriddenProjects.length > 0,
  ).length;
  return (
    <View style={{ gap: 8 }}>
      <Btn
        theme={theme}
        variant="ghost"
        label={`${open ? "▾" : "▸"} ${label}（${prompts.length}${changed ? `，已自定义 ${changed}` : ""}）`}
        onPress={() => setOpen(!open)}
      />
      {open
        ? prompts.map((p) => (
            <PromptEditor
              key={p.key}
              prompt={p}
              projectId={projectId}
              projects={projects}
              theme={theme}
              save={save}
              clear={clear}
            />
          ))
        : null}
      {open ? null : <View style={{ height: 1, backgroundColor: theme.colors.border }} />}
    </View>
  );
}

function PromptEditor({
  prompt,
  projectId,
  projects,
  theme,
  save,
  clear,
}: {
  prompt: BehaviourPrompt;
  projectId: string | null;
  projects: Array<{ id: string; name: string }>;
  theme: PluginTheme;
  save: PromptActions["save"];
  clear: PromptActions["clear"];
}) {
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [showDefault, setShowDefault] = useState(false);
  const shown = editorText(prompt, projectId);
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown, projectId]);
  const dirty = draft !== shown;
  const source = sourceIn(prompt, projectId);
  const unknown = unknownIn(prompt, draft);
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const names = prompt.overriddenProjects
    .map((id) => projects.find((p) => p.id === id)?.name)
    .filter((n): n is string => !!n);

  return (
    <View
      style={{
        gap: 8,
        padding: 12,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
      }}
    >
      <Btn
        theme={theme}
        variant="ghost"
        label={`${open ? "▾" : "▸"} ${prompt.title} · ${SOURCE_LABELS[source]}`}
        onPress={() => setOpen(!open)}
      />
      <Muted theme={theme}>{prompt.description}</Muted>
      {error ? <Text style={{ color: theme.colors.statusDanger }}>{error}</Text> : null}
      {open ? (
        <View style={{ gap: 8 }}>
          <Muted theme={theme}>何时发送：{prompt.whenSent || "—"}</Muted>
          <Muted theme={theme}>发给：{prompt.audience || "—"}</Muted>
          <Muted theme={theme}>
            当前生效来源：{SOURCE_LABELS[source]}
            {names.length ? `；有项目覆盖：${names.join("、")}` : ""}
            {projectId && ownOverride(prompt, projectId) === null
              ? "（本项目没有自己的覆盖，沿用上一级）"
              : ""}
          </Muted>
          {prompt.placeholders.length ? (
            <Muted theme={theme}>
              可用占位符：
              {prompt.placeholders.map((p) => `{{${p.name}}} ${p.description}`).join("；")}
            </Muted>
          ) : (
            <Muted theme={theme}>此项不使用占位符，文本原样发送。</Muted>
          )}
          <TextInput
            multiline
            value={draft}
            onChangeText={setDraft}
            style={{ minHeight: prompt.defaultText.length > 400 ? 260 : 120 }}
          />
          {unknown.length ? (
            <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
              未知占位符会被替换为空：{unknown.map((n) => `{{${n}}}`).join("、")}
            </Text>
          ) : null}
          {prompt.fixedSuffix ? (
            <View style={{ gap: 4 }}>
              <Muted theme={theme}>固定格式段（自动追加在正文之后，只读）：</Muted>
              <Text
                style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontStyle: "italic" }}
              >
                {prompt.fixedSuffix}
              </Text>
            </View>
          ) : null}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Btn
              theme={theme}
              variant="primary"
              label={projectId ? "保存为项目覆盖" : "保存为全局覆盖"}
              disabled={!dirty}
              onPress={() =>
                void run(() =>
                  save({ key: prompt.key, text: textToSave(prompt, projectId, draft), projectId }),
                )
              }
            />
            <Btn
              theme={theme}
              label="恢复默认"
              disabled={ownOverride(prompt, projectId) === null && !dirty}
              onPress={() => void run(() => clear({ key: prompt.key, projectId }))}
            />
            <Btn
              theme={theme}
              label={showDefault ? "隐藏默认全文" : "查看默认全文"}
              onPress={() => setShowDefault(!showDefault)}
            />
          </View>
          {showDefault ? (
            <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
              {prompt.defaultText || "（默认为空）"}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
