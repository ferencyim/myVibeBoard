import type { PluginTheme } from "@getpaseo/plugin";
import {
  useRpc,
  useSettings,
  type PluginScreenProps,
  type PluginSidebarItemProps,
  type PluginSurfaceProps,
} from "@getpaseo/plugin/client";
import {
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSwitch,
  SidebarRow,
} from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { maintainSettings, resumeRpc, rulesSettings, runRpc, statusRpc } from "../shared/rpc";
import { FIELD_KEYS, type FieldKey, type FieldSource, type RulesConfig } from "../shared/rules";
import { addCustomRule, applyRuleEdit, draftFromDef, emptyDef, removeCustomRule } from "./edit";
import { BLOCKED_TEXT, ORIGIN_TEXT, lastRunText, parseStatus, type RuleRow } from "./format";
import { RuleEditor } from "./rule-editor";
import { FieldsCard, Group, type Field as SettingField } from "./settings-kit";

const ALL_BUILTIN = Object.fromEntries(FIELD_KEYS.map((k) => [k, "builtin"])) as Record<FieldKey, FieldSource>;

function Section({ theme, title, children }: { theme: PluginTheme; title: string; children: ReactNode }) {
  return (
    <View
      style={{
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 10,
        padding: 12,
        gap: 8,
      }}
    >
      <Text style={{ color: theme.colors.foreground, fontWeight: "600", fontSize: 15 }}>{title}</Text>
      {children}
    </View>
  );
}

const Muted = ({ theme, children }: { theme: PluginTheme; children: ReactNode }) => (
  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{children}</Text>
);

function Button({
  theme,
  label,
  onPress,
  disabled,
}: {
  theme: PluginTheme;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={{
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 999,
        backgroundColor: theme.colors.surface2,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>{label}</Text>
    </Pressable>
  );
}

export function MaintainScreen({ theme }: PluginScreenProps) {
  const queryClient = useQueryClient();
  const statusCall = useRpc(statusRpc);
  const runCall = useRpc(runRpc);
  const resumeCall = useRpc(resumeRpc);
  const rulesState = useSettings(rulesSettings);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ projectId: string; name: string } | null>(null);

  const status = useQuery({
    queryKey: ["vibe-maintain", "status"],
    queryFn: async () => parseStatus(await statusCall({})),
    refetchInterval: 5_000,
  });

  const act = async (id: string, run: () => Promise<string | null>) => {
    setBusy(id);
    setMessage(null);
    try {
      setMessage(await run());
      await queryClient.invalidateQueries({ queryKey: ["vibe-maintain"] });
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const runNow = (rule: RuleRow) =>
    act(`run:${rule.id}`, async () => {
      const r = await runCall({ ruleId: rule.id });
      return r.status === "fired"
        ? `「${rule.name}」已运行一次，结果见“上次运行”`
        : `「${rule.name}」没有运行：${BLOCKED_TEXT[r.why ?? ""] ?? r.why ?? r.status}`;
    });
  const resume = (rule: RuleRow) =>
    act(`resume:${rule.id}`, async () => {
      await resumeCall({ ruleId: rule.id });
      return `「${rule.name}」已恢复`;
    });

  /** Writes a new UI-layer config; the engine picks it up on the next status call or tick. */
  const saveConfig = (
    id: string,
    change: (config: RulesConfig) => { config: RulesConfig; error?: string },
    done: string,
  ) =>
    act(id, async () => {
      if (rulesState.status !== "ready") return "规则配置还没有加载好，请稍后再试";
      const next = change(rulesState.values);
      if (next.error) return next.error;
      const ok = await rulesState.save(next.config, rulesState.revision);
      if (!ok) return `保存失败：${rulesState.saveError ?? "配置已被其他地方修改，请重试"}`;
      setEditing(null);
      setCreating(null);
      return done;
    });

  const s = status.data;
  const namesIn = (projectId: string) => s?.rules.filter((r) => r.projectId === projectId).map((r) => r.name) ?? [];
  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Muted theme={theme}>
        自动维护按规则定期检查项目，把结果放进看板。规则的值按优先级叠加：内置默认，其次是这里的界面配置，最后是项目里的
        .vibe/maintenance.yml（它写了的字段会覆盖界面配置，在这里显示为只读）。
      </Muted>
      {status.error ? (
        <Text style={{ color: theme.colors.statusDanger }}>无法加载自动维护状态：{String(status.error)}</Text>
      ) : null}
      {!s ? <Muted theme={theme}>加载中...</Muted> : null}
      {message ? <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>{message}</Text> : null}
      {s?.configErrors.map((c) => (
        <Text key={c.project} style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
          规则配置有问题：{c.errors.join("；")}
        </Text>
      ))}
      {s && s.rules.length === 0 ? <Muted theme={theme}>还没有维护规则。</Muted> : null}
      {s?.rules.map((rule) => (
        <Section key={rule.id} theme={theme} title={rule.name}>
          <Muted theme={theme}>
            项目「{rule.projectName}」· {rule.origin ? ORIGIN_TEXT[rule.origin] : "规则"}
            {rule.enabled ? "" : " · 已停用"}
          </Muted>
          <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>
            什么时候触发：{rule.triggerText || "-"}
          </Text>
          {rule.progressText ? (
            <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>当前进度：{rule.progressText}</Text>
          ) : null}
          <Muted theme={theme}>检查内容：{rule.checkText}</Muted>
          <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>
            {rule.output === "fix" ? "直接修复（新建 worktree 让 agent 动手）" : "生成建议草稿卡"}
            {rule.agent ? ` · 执行 agent ${rule.agent}` : " · 不调用模型"} · 优先级 {rule.priority}
          </Text>
          <Muted theme={theme}>
            今天已运行 {rule.runsToday} 次（每日上限 {rule.dailyCap}）
          </Muted>
          <Muted theme={theme}>上次运行：{lastRunText(rule.lastRun)}</Muted>
          {rule.blocked ? (
            <Text
              style={{
                color: rule.paused ? theme.colors.statusDanger : theme.colors.statusWarning,
                fontSize: 12,
              }}
            >
              {BLOCKED_TEXT[rule.blocked] ?? rule.blocked}
            </Text>
          ) : null}
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            {rule.paused ? (
              <Button
                theme={theme}
                label={busy === `resume:${rule.id}` ? "恢复中..." : "恢复"}
                disabled={busy !== null}
                onPress={() => void resume(rule)}
              />
            ) : null}
            <Button
              theme={theme}
              label={busy === `run:${rule.id}` ? "运行中..." : "立即运行"}
              disabled={busy !== null || !rule.enabled}
              onPress={() => void runNow(rule)}
            />
            <Button
              theme={theme}
              label={editing === rule.id ? "收起" : "查看与编辑"}
              onPress={() => setEditing(editing === rule.id ? null : rule.id)}
            />
            {rule.origin === "custom" ? (
              <Button
                theme={theme}
                label="删除规则"
                disabled={busy !== null}
                onPress={() =>
                  void saveConfig(
                    `delete:${rule.id}`,
                    (config) => ({ config: removeCustomRule(config, rule.projectId, rule.name) }),
                    `已删除自定义规则「${rule.name}」（只删配置，不影响文件和历史卡片）`,
                  )
                }
              />
            ) : null}
          </View>
          {editing === rule.id ? (
            <RuleEditor
              theme={theme}
              initial={draftFromDef(rule.def)}
              sources={rule.sources}
              presets={s.presets}
              saving={busy === `save:${rule.id}`}
              onCancel={() => setEditing(null)}
              onSave={(fields) =>
                void saveConfig(
                  `save:${rule.id}`,
                  (config) => ({
                    config: applyRuleEdit(
                      config,
                      {
                        projectId: rule.projectId,
                        name: rule.name,
                        origin: rule.origin,
                        sources: rule.sources,
                        base: rule.base,
                      },
                      fields,
                    ),
                  }),
                  `「${rule.name}」已保存`,
                )
              }
            />
          ) : null}
        </Section>
      ))}
      {s ? (
        <Section theme={theme} title="新建自定义规则">
          {creating ? (
            <>
              <Muted theme={theme}>所属项目</Muted>
              <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
                {s.projects.map((p) => (
                  <Button
                    key={p.id}
                    theme={theme}
                    label={`${creating.projectId === p.id ? "● " : ""}${p.name}`}
                    onPress={() => setCreating({ ...creating, projectId: p.id })}
                  />
                ))}
              </View>
              <Muted theme={theme}>规则名称</Muted>
              <TextInput
                value={creating.name}
                onChangeText={(name) => setCreating({ ...creating, name })}
                placeholder="例如 nightly-clean"
                placeholderTextColor={theme.colors.foregroundMuted}
                autoCapitalize="none"
                style={{
                  color: theme.colors.foreground,
                  backgroundColor: theme.colors.surface0,
                  borderColor: theme.colors.border,
                  borderWidth: 1,
                  borderRadius: 8,
                  paddingHorizontal: 10,
                  paddingVertical: 6,
                }}
              />
              <RuleEditor
                theme={theme}
                creating
                initial={draftFromDef(emptyDef("new"))}
                sources={ALL_BUILTIN}
                presets={s.presets}
                saving={busy === "create"}
                onCancel={() => setCreating(null)}
                onSave={(fields) =>
                  void saveConfig(
                    "create",
                    (config) =>
                      addCustomRule(config, creating.projectId, creating.name, namesIn(creating.projectId), fields),
                    `已创建规则「${creating.name.trim()}」`,
                  )
                }
              />
            </>
          ) : (
            <Button
              theme={theme}
              label="新建规则"
              disabled={s.projects.length === 0}
              onPress={() => setCreating({ projectId: s.projects[0]?.id ?? "", name: "" })}
            />
          )}
        </Section>
      ) : null}
    </ScrollView>
  );
}

export function MaintainSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Wrench"
      label="自动维护"
      active={currentScreen?.screenId === "main"}
      onPress={() => openScreen({ screenId: "main" })}
    />
  );
}

/** Defaults equal the values that used to be hard-coded (WP-99). */
export const ADVANCED_FIELDS: readonly SettingField[] = [
  { kind: "number", key: "subAgentTimeoutMinutes", label: "规则的只读分析 agent 单次运行超时（分钟，1-240）", min: 1, max: 240 },
  { kind: "int", key: "commitPollSeconds", label: "检查“合入提交数”触发条件的最小间隔（秒，5-3600）", min: 5, max: 3600 },
  { kind: "map", key: "unattendedModes", valueType: "string", label: "无人值守修复 agent 的权限模式，按 provider，如 claude=acceptEdits, codex=auto-review（未列出的用 provider 默认）" },
  { kind: "map", key: "readOnlyModes", valueType: "string", label: "只读分析 agent 的权限模式，按 provider，如 claude=plan, codex=read-only" },
];

export function MaintainSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(maintainSettings);
  if (settings.status !== "ready") {
    return (
      <View style={{ padding: 16 }}>
        <Text style={{ color: theme.colors.foregroundMuted }}>
          {settings.status === "loading" ? "加载中..." : `无法加载设置：${settings.error}`}
        </Text>
      </View>
    );
  }
  const { values, revision } = settings;
  const save = (next: typeof values) => void settings.save(next, revision);
  const integer = (text: string, min: number, max: number) => {
    const n = Number(text);
    return text.trim() && Number.isInteger(n) && n >= min && n <= max ? n : null;
  };
  return (
    <SettingsSection title="自动维护">
      <SettingsCard>
        <SettingsSwitch
          label="启用自动维护"
          value={values.enabled}
          onValueChange={(enabled: boolean) => save({ ...values, enabled })}
        />
        <SettingsInput
          label="每隔多少秒检查一次触发条件"
          hint="5 到 3600"
          initialValue={String(values.tickSeconds)}
          onChangeText={(text) => {
            const n = integer(text, 5, 3600);
            if (n !== null) save({ ...values, tickSeconds: n });
          }}
        />
        <SettingsInput
          label="连续被驳回多少张卡后暂停规则"
          hint="1 到 20"
          initialValue={String(values.pauseAfterRejections)}
          onChangeText={(text) => {
            const n = integer(text, 1, 20);
            if (n !== null) save({ ...values, pauseAfterRejections: n });
          }}
        />
        <SettingsInput
          label="规则没指定 agent 时使用的默认 agent（provider/model）"
          initialValue={values.defaultAgent}
          onChangeText={(text) => save({ ...values, defaultAgent: text.trim() || "claude/sonnet" })}
        />
      </SettingsCard>
      <Group theme={theme} title="高级">
        <FieldsCard fields={ADVANCED_FIELDS} values={values} save={save} />
      </Group>
    </SettingsSection>
  );
}
