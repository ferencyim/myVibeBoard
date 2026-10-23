import type { PluginTheme } from "@getpaseo/plugin";
import React, { useState, type ReactNode } from "react";
import { Pressable, Switch, Text, TextInput, View } from "react-native";
import {
  DEFAULT_TEMPLATES,
  PLACEHOLDERS,
  SYSTEM_CONSTRAINTS,
  type PromptKind,
} from "../shared/prompts";
import type { FieldKey, FieldSource, RuleScope } from "../shared/rules";
import { CHECK_TYPES, PRIORITIES, draftToFields, type DraftResult, type RuleDraft } from "./edit";
import { SOURCE_TEXT } from "./format";

type Fields = NonNullable<DraftResult["fields"]>;
export type Sources = Record<FieldKey, FieldSource>;

const Muted = ({ theme, children }: { theme: PluginTheme; children: ReactNode }) => (
  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{children}</Text>
);

function Chip({
  theme,
  label,
  active,
  disabled,
  onPress,
}: {
  theme: PluginTheme;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={{
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 999,
        backgroundColor: active ? theme.colors.accent : theme.colors.surface2,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Text
        style={{
          color: active ? theme.colors.accentForeground : theme.colors.foreground,
          fontSize: 12,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** A labelled form row; fields supplied by maintenance.yml are marked and locked by the caller. */
function Field({
  theme,
  label,
  hint,
  sources,
  keys,
  children,
}: {
  theme: PluginTheme;
  label: string;
  hint?: string;
  sources: Sources;
  keys: FieldKey[];
  children: ReactNode;
}) {
  const fromYml = keys.some((k) => sources[k] === "yml");
  const fromUi = keys.some((k) => sources[k] === "ui");
  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>
          {label}
        </Text>
        {fromYml ? (
          <Text style={{ color: theme.colors.statusWarning, fontSize: 11 }}>
            {SOURCE_TEXT.yml}，这里只读
          </Text>
        ) : fromUi ? (
          <Text style={{ color: theme.colors.accent, fontSize: 11 }}>{SOURCE_TEXT.ui}</Text>
        ) : null}
      </View>
      {hint ? <Muted theme={theme}>{hint}</Muted> : null}
      <View
        pointerEvents={fromYml ? "none" : "auto"}
        style={{ gap: 6, opacity: fromYml ? 0.55 : 1 }}
      >
        {children}
      </View>
    </View>
  );
}

function Input({
  theme,
  value,
  onChangeText,
  placeholder,
  multiline,
  mono,
}: {
  theme: PluginTheme;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
  mono?: boolean;
}) {
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={theme.colors.foregroundMuted}
      autoCapitalize="none"
      autoCorrect={false}
      multiline={multiline}
      style={{
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface0,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 6,
        fontSize: mono ? 12 : 14,
        fontFamily: mono ? "monospace" : undefined,
        minHeight: multiline ? 120 : undefined,
        textAlignVertical: multiline ? "top" : "center",
      }}
    />
  );
}

const PROMPT_TITLE: Record<PromptKind, string> = {
  review: "复核提示词（建议方案时，配置了执行 agent 才会使用）",
  fix: "修复规划提示词（输出方式为「修复方案」时发给规划 anchor）",
};

function PromptEditor({
  theme,
  kind,
  value,
  sources,
  onChange,
}: {
  theme: PluginTheme;
  kind: PromptKind;
  value: string | null;
  sources: Sources;
  onChange: (v: string | null) => void;
}) {
  const shown = value ?? DEFAULT_TEMPLATES[kind];
  return (
    <Field
      theme={theme}
      label={PROMPT_TITLE[kind]}
      hint={value === null ? "当前使用默认模板；直接修改即可覆盖。" : "已覆盖默认模板。"}
      sources={sources}
      keys={[`prompts.${kind}` as FieldKey]}
    >
      <Input
        theme={theme}
        multiline
        mono
        value={shown}
        onChangeText={(v) => onChange(v === DEFAULT_TEMPLATES[kind] ? null : v)}
      />
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Chip
          theme={theme}
          label="恢复默认"
          disabled={value === null}
          onPress={() => onChange(null)}
        />
      </View>
      <Muted theme={theme}>系统会在模板后面自动附加下面的约束，无法删除：</Muted>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontFamily: "monospace" }}>
        {SYSTEM_CONSTRAINTS[kind]}
      </Text>
    </Field>
  );
}

export function PlaceholderHelp({ theme }: { theme: PluginTheme }) {
  return (
    <View style={{ gap: 2 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>
        可用占位符
      </Text>
      {PLACEHOLDERS.map((p) => (
        <Muted key={p.name} theme={theme}>
          {`{{${p.name}}}`}　{p.description}
        </Muted>
      ))}
    </View>
  );
}

/** Which projects a rule applies to: "all projects" or a multi-select of project chips. */
export function ScopePicker({
  theme,
  scope,
  projects,
  onChange,
}: {
  theme: PluginTheme;
  scope: RuleScope;
  projects: Array<{ id: string; name: string }>;
  onChange: (scope: RuleScope) => void;
}) {
  const all = scope === "all";
  const chosen = all ? [] : scope;
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>
        适用项目
      </Text>
      <Muted theme={theme}>
        规则只在这里定义一份，对下面选中的项目都生效；修改一次，所有适用项目都会跟着变。进度、运行记录和每日上限仍按项目分别统计。
      </Muted>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        <Switch
          value={all}
          onValueChange={(v) => onChange(v ? "all" : projects.map((p) => p.id))}
        />
        <Muted theme={theme}>全部项目（包括以后新建的）</Muted>
      </View>
      {all ? null : (
        <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
          {projects.map((p) => (
            <Chip
              key={p.id}
              theme={theme}
              label={p.name}
              active={chosen.includes(p.id)}
              onPress={() =>
                onChange(
                  chosen.includes(p.id) ? chosen.filter((x) => x !== p.id) : [...chosen, p.id],
                )
              }
            />
          ))}
          {chosen.length === 0 ? (
            <Muted theme={theme}>没有选中任何项目：规则暂时不会运行。</Muted>
          ) : null}
        </View>
      )}
    </View>
  );
}

export function RuleEditor({
  theme,
  initial,
  initialScope,
  projects,
  sources,
  readOnly,
  presets,
  creating,
  saving,
  onSave,
  onCancel,
}: {
  theme: PluginTheme;
  initial: RuleDraft;
  initialScope: RuleScope;
  projects: Array<{ id: string; name: string }>;
  sources: Sources;
  /** A rule defined only by a project's maintenance.yml: values are shown, nothing is saved. */
  readOnly?: boolean;
  presets: Array<{ id: string; name: string; spec: string }>;
  /** Creating a custom rule: the check type is chosen here (an existing rule keeps its type). */
  creating?: boolean;
  saving: boolean;
  /** `keepOpen`: an instant save of one switch; the editor stays open. */
  onSave: (fields: Fields, scope: RuleScope, keepOpen?: boolean) => void;
  onCancel: () => void;
}) {
  const [d, setD] = useState<RuleDraft>(initial);
  const [scope, setScope] = useState<RuleScope>(initialScope);
  const [problems, setProblems] = useState<string[]>([]);
  const set = <K extends keyof RuleDraft>(key: K, value: RuleDraft[K]) =>
    setD((prev) => ({ ...prev, [key]: value }));
  const preview = draftToFields(d);
  const f = (label: string, keys: FieldKey[], children: ReactNode, hint?: string) => (
    <Field theme={theme} label={label} hint={hint} sources={sources} keys={keys}>
      {children}
    </Field>
  );

  // The switches persist at once for an existing rule (only that switch, on top of the saved
  // values): collapsing the editor drops the other, unsaved edits of the form.
  const instant = (enabled: boolean, nextScope: RuleScope) => {
    if (readOnly || creating) return;
    const r = draftToFields({ ...initial, enabled });
    if (r.fields) onSave(r.fields, nextScope, true);
  };

  const save = () => {
    const result = draftToFields(d);
    setProblems(result.errors);
    if (result.fields) onSave(result.fields, scope);
  };

  return (
    <View
      style={{ gap: 12, borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 10 }}
    >
      {readOnly ? null : (
        <ScopePicker
          theme={theme}
          scope={scope}
          projects={projects}
          onChange={(v) => {
            setScope(v);
            instant(initial.enabled, v);
          }}
        />
      )}
      {f(
        "启用",
        ["enabled"],
        <Switch
          value={d.enabled}
          onValueChange={(v) => {
            set("enabled", v);
            instant(v, scope);
          }}
        />,
        "关闭后不会自动触发，也不能手动运行。",
      )}

      {f(
        "触发方式",
        ["trigger"],
        <>
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            {(
              [
                ["workload", "按工作量"],
                ["time", "定时"],
                ["event", "文件新增内容"],
              ] as const
            ).map(([kind, label]) => (
              <Chip
                key={kind}
                theme={theme}
                label={label}
                active={d.triggerKind === kind}
                onPress={() => set("triggerKind", kind)}
              />
            ))}
          </View>
          {d.triggerKind === "workload" ? (
            <>
              <Muted theme={theme}>任一阈值达到就触发，触发后计数清零；留空表示不看这一项。</Muted>
              <Input
                theme={theme}
                value={d.cardsDone}
                onChangeText={(v) => set("cardsDone", v)}
                placeholder="已完成任务数，例如 10"
              />
              <Input
                theme={theme}
                value={d.commitsMerged}
                onChangeText={(v) => set("commitsMerged", v)}
                placeholder="已合并提交数，例如 30"
              />
              <Input
                theme={theme}
                value={d.tokens}
                onChangeText={(v) => set("tokens", v)}
                placeholder="已消耗 token，例如 2000000"
              />
            </>
          ) : null}
          {d.triggerKind === "time" ? (
            <>
              <Muted theme={theme}>
                5 段 cron，本地时间：分 时 日 月 周。例如 0 3 * * * 是每天 3 点。
              </Muted>
              <Input
                theme={theme}
                value={d.cron}
                onChangeText={(v) => set("cron", v)}
                placeholder="0 3 * * *"
              />
            </>
          ) : null}
          {d.triggerKind === "event" ? (
            <>
              <Muted theme={theme}>
                监视的文件有新增行时检查；填了正则则只看匹配的行。相对路径以仓库根目录为准。
              </Muted>
              <Input
                theme={theme}
                value={d.eventPath}
                onChangeText={(v) => set("eventPath", v)}
                placeholder="logs/crash.log"
              />
              <Input
                theme={theme}
                value={d.eventPattern}
                onChangeText={(v) => set("eventPattern", v)}
                placeholder="匹配正则，例如 Exception（可留空）"
              />
            </>
          ) : null}
        </>,
      )}

      {f(
        "检查",
        ["check"],
        <>
          {creating ? (
            <View style={{ flexDirection: "row", gap: 8 }}>
              {CHECK_TYPES.map((t) => (
                <Chip
                  key={t}
                  theme={theme}
                  label={t === "git" ? "Git 体检" : "慢调用 perf-slow"}
                  active={d.checkType === t}
                  onPress={() => set("checkType", t)}
                />
              ))}
            </View>
          ) : (
            <Muted theme={theme}>检查类型：{d.checkType}</Muted>
          )}
          {d.checkType === "git" ? (
            <>
              <Input
                theme={theme}
                value={d.staleDays}
                onChangeText={(v) => set("staleDays", v)}
                placeholder="多少天未合并算长期（默认 14）"
              />
              <Input
                theme={theme}
                value={d.largeFileMb}
                onChangeText={(v) => set("largeFileMb", v)}
                placeholder="大文件阈值 MB（默认 5）"
              />
              <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
                <Switch value={d.outdated} onValueChange={(v) => set("outdated", v)} />
                <Muted theme={theme}>检查过期的 npm 依赖（需要联网，较慢）</Muted>
              </View>
            </>
          ) : null}
          <Muted theme={theme}>其他检查参数（JSON，例如 perf-slow 的 sources）：</Muted>
          <Input
            theme={theme}
            multiline
            mono
            value={d.checkExtra}
            onChangeText={(v) => set("checkExtra", v)}
            placeholder="{}"
          />
        </>,
      )}

      {f(
        "执行 agent",
        ["agent"],
        <>
          <Input
            theme={theme}
            value={d.agent}
            onChangeText={(v) => set("agent", v)}
            placeholder="预设名，或 provider/model，例如 claude/sonnet"
          />
          {presets.length ? (
            <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
              {presets.map((p) => (
                <Chip
                  key={p.id}
                  theme={theme}
                  label={p.name}
                  active={d.agent === p.name}
                  onPress={() => set("agent", p.name)}
                />
              ))}
              <Chip
                theme={theme}
                label="不使用"
                active={d.agent === ""}
                onPress={() => set("agent", "")}
              />
            </View>
          ) : null}
        </>,
        "留空：建议方案时只做确定性检查、不调用模型；「修复方案」时用默认 agent。",
      )}

      {f(
        "输出方式",
        ["output"],
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Chip
            theme={theme}
            label="建议方案"
            active={d.output === "suggest"}
            onPress={() => set("output", "suggest")}
          />
          <Chip
            theme={theme}
            label="修复方案"
            active={d.output === "fix"}
            onPress={() => set("output", "fix")}
          />
        </View>,
        "两种输出均在新的原生 workspace 中先规划，等待用户显式 /执行；修复方案也不会自动修改文件。",
      )}

      {f(
        "任务优先级",
        ["priority"],
        <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
          {PRIORITIES.map((p) => (
            <Chip
              key={p}
              theme={theme}
              label={p}
              active={d.priority === p}
              onPress={() => set("priority", p)}
            />
          ))}
        </View>,
      )}

      {f(
        "每日上限",
        ["daily_cap"],
        <Input
          theme={theme}
          value={d.dailyCap}
          onChangeText={(v) => set("dailyCap", v)}
          placeholder="1"
        />,
        "一天最多自动运行几次（手动运行不受限）。",
      )}

      {f(
        "去重键",
        ["dedupe_key"],
        <Input
          theme={theme}
          value={d.dedupeKey}
          onChangeText={(v) => set("dedupeKey", v)}
          placeholder="留空则用规则名"
        />,
        "同一去重键下还有未完成的维护卡时，只在那张卡上追加「再次出现」记录，不重复建卡。",
      )}

      <PromptEditor
        theme={theme}
        kind="review"
        value={d.reviewPrompt}
        sources={sources}
        onChange={(v) => set("reviewPrompt", v)}
      />
      <PromptEditor
        theme={theme}
        kind="fix"
        value={d.fixPrompt}
        sources={sources}
        onChange={(v) => set("fixPrompt", v)}
      />
      <PlaceholderHelp theme={theme} />

      {[...problems, ...preview.warnings].map((m) => (
        <Text
          key={m}
          style={{
            color: problems.includes(m) ? theme.colors.statusDanger : theme.colors.statusWarning,
            fontSize: 12,
          }}
        >
          {m}
        </Text>
      ))}
      {readOnly ? null : (
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Chip
            theme={theme}
            label={saving ? "保存中..." : "保存"}
            active
            disabled={saving}
            onPress={save}
          />
          <Chip theme={theme} label="取消" disabled={saving} onPress={onCancel} />
        </View>
      )}
    </View>
  );
}
