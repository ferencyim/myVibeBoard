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
import {
  FIELD_KEYS,
  describeCheck,
  describeTrigger,
  type FieldKey,
  type FieldSource,
  type RulesConfig,
} from "../shared/rules";
import { formatRpcError } from "../shared/vibe/ui/rpc-error";
import { addCustomRule, applyRuleEdit, draftFromDef, emptyDef, removeCustomRule } from "./edit";
import {
  BLOCKED_TEXT,
  FIELD_LABEL,
  ORIGIN_TEXT,
  lastRunText,
  parseStatus,
  type RuleGroup,
  type RuleRow,
} from "./format";
import { RuleEditor } from "./rule-editor";
import { FieldsCard, Group, type Field as SettingField } from "./settings-kit";

const ALL_BUILTIN = Object.fromEntries(FIELD_KEYS.map((k) => [k, "builtin"])) as Record<
  FieldKey,
  FieldSource
>;

function Section({
  theme,
  title,
  children,
}: {
  theme: PluginTheme;
  title: string;
  children: ReactNode;
}) {
  return (
    <View
      style={{
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: theme.borderRadius?.md ?? 12,
        padding: theme.spacing?.[4] ?? 16,
        gap: theme.spacing?.[3] ?? 12,
      }}
    >
      <Text style={{ color: theme.colors.foreground, fontWeight: "600", fontSize: 15 }}>
        {title}
      </Text>
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

const SCOPE_CHIP = (theme: PluginTheme, label: string) => (
  <View
    key={label}
    style={{
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: 999,
      backgroundColor: theme.colors.surface2,
    }}
  >
    <Text style={{ color: theme.colors.foreground, fontSize: 11 }}>{label}</Text>
  </View>
);

export function MaintainScreen({ theme, params }: PluginScreenProps) {
  const queryClient = useQueryClient();
  const statusCall = useRpc(statusRpc);
  const runCall = useRpc(runRpc);
  const resumeCall = useRpc(resumeRpc);
  const rulesState = useSettings(rulesSettings);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(params.rule ?? null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [creating, setCreating] = useState<{ name: string } | null>(null);

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
      setMessage(formatRpcError(e));
    } finally {
      setBusy(null);
    }
  };
  const s = status.data;
  const projectName = (id: string) => s?.projects.find((p) => p.id === id)?.name ?? id;

  /** Runs one project's row (`row`), or every applicable project of the rule (no `row`). */
  const runNow = (group: RuleGroup, row?: RuleRow) =>
    act(`run:${row?.id ?? group.key}`, async () => {
      const r = await runCall(
        row
          ? { ruleId: row.id }
          : group.readOnly
            ? { ruleId: group.rows[0]!.id }
            : { ruleName: group.name },
      );
      const results = r.results.length
        ? r.results
        : [{ projectId: row?.projectId ?? "", status: r.status, why: r.why }];
      const lines = results.map((x) =>
        x.status === "fired"
          ? `「${projectName(x.projectId)}」已运行一次`
          : `「${projectName(x.projectId)}」没有运行：${BLOCKED_TEXT[x.why ?? ""] ?? x.why ?? x.status}`,
      );
      return `「${group.name}」${lines.join("；")}，结果见“上次运行”`;
    });
  const resume = (row: RuleRow) =>
    act(`resume:${row.id}`, async () => {
      await resumeCall({ ruleId: row.id });
      return `「${row.name}」在「${row.projectName}」已恢复`;
    });

  /** Writes a new global rule table; the engine picks it up on the next status call or tick. */
  const saveConfig = (
    id: string,
    change: (config: RulesConfig) => { config: RulesConfig; error?: string },
    done: string,
    keepOpen = false,
  ) =>
    act(id, async () => {
      if (rulesState.status !== "ready") return "规则配置还没有加载好，请稍后再试";
      const next = change(rulesState.values);
      if (next.error) return next.error;
      const ok = await rulesState.save(next.config, rulesState.revision);
      if (!ok) return `保存失败：${rulesState.saveError ?? "配置已被其他地方修改，请重试"}`;
      if (!keepOpen) {
        setEditing(null);
        setCreating(null);
      }
      return done;
    });

  const takenNames = s?.groups.filter((g) => !g.readOnly).map((g) => g.name) ?? [];
  const scopeNames = (g: RuleGroup) =>
    g.scope === "all" ? ["全部项目"] : g.scope.length ? g.scope.map(projectName) : ["未选择项目"];
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{
        padding: theme.spacing?.[4] ?? 16,
        gap: theme.spacing?.[3] ?? 12,
        width: "100%",
        maxWidth: 784,
        alignSelf: "center",
      }}
    >
      <Text style={{ color: theme.colors.foreground, fontSize: theme.fontSize?.xl ?? 18, fontWeight: "600" }}>
        维护规则与运行记录
      </Text>
      <Muted theme={theme}>
        自动维护按规则定期检查项目，把发现送到新的原生 workspace 中规划，等待用户显式
        /执行。每条规则只定义一份，在规则上选择适用的项目（或全部项目）；改一次，所有适用项目都生效。
        进度、运行记录和每日上限按「规则 ×
        项目」分别统计。规则的值按优先级叠加：内置默认，其次是这里的界面配置，最后是项目里的
        .vibe/maintenance.yml（只对该项目生效的局部覆盖）。
      </Muted>
      {status.error ? (
        <Text style={{ color: theme.colors.statusDanger }}>
          无法加载自动维护状态：{formatRpcError(status.error)}
        </Text>
      ) : null}
      {!s ? <Muted theme={theme}>加载中...</Muted> : null}
      {message ? (
        <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>{message}</Text>
      ) : null}
      {s?.configErrors.map((c) => (
        <Text key={c.project} style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
          规则配置有问题（{s.projects.find((p) => p.id === c.project)?.name ?? c.project}）：
          {c.errors.join("；")}
        </Text>
      ))}
      {s && s.groups.length === 0 ? <Muted theme={theme}>还没有维护规则。</Muted> : null}
      {s?.groups.map((group) => (
        <Section key={group.key} theme={theme} title={group.name}>
          <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <Muted theme={theme}>适用项目：</Muted>
            {scopeNames(group).map((n) => SCOPE_CHIP(theme, n))}
            <Muted theme={theme}>
              · {group.origin ? ORIGIN_TEXT[group.origin] : "规则"}
              {group.def.enabled ? "" : " · 已停用"}
            </Muted>
          </View>
          {group.splitFrom ? (
            <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
              迁移时因各项目配置不同而拆分：这条规则原来是「{group.splitFrom}
              」，不同项目的配置不一样，所以拆成了几条。
            </Text>
          ) : null}
          <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>
            什么时候触发：{describeTrigger(group.def.trigger)}
          </Text>
          <Muted theme={theme}>
            检查内容：{describeCheck(group.def.check as { type: string } & Record<string, unknown>)}
          </Muted>
          <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>
            {group.def.output === "fix" ? "生成修复方案，等待确认" : "生成建议方案，等待确认"}
            {group.def.agent ? ` · 规划 agent ${group.def.agent}` : " · 使用默认规划模型"} · 优先级{" "}
            {group.def.priority} · 每日上限 {group.def.daily_cap}（每个项目分别计）
          </Text>
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            <Button
              theme={theme}
              label={
                busy === `run:${group.key}`
                  ? "运行中..."
                  : group.rows.length > 1
                    ? "立即运行（全部适用项目）"
                    : "立即运行"
              }
              disabled={busy !== null || !group.def.enabled || group.rows.length === 0}
              onPress={() => void runNow(group)}
            />
            <Button
              theme={theme}
              label={`各项目运行状态（${group.rows.length}）${expanded[group.key] ? " ▾" : " ▸"}`}
              onPress={() => setExpanded({ ...expanded, [group.key]: !expanded[group.key] })}
            />
            <Button
              theme={theme}
              label={editing === group.key ? "收起" : group.readOnly ? "查看" : "查看与编辑"}
              onPress={() => setEditing(editing === group.key ? null : group.key)}
            />
            {group.origin === "custom" && !group.readOnly ? (
              <Button
                theme={theme}
                label="删除规则"
                disabled={busy !== null}
                onPress={() =>
                  void saveConfig(
                    `delete:${group.key}`,
                    (config) => ({ config: removeCustomRule(config, group.name) }),
                    `已删除自定义规则「${group.name}」（只删配置，不影响文件和历史任务）`,
                  )
                }
              />
            ) : null}
          </View>
          {expanded[group.key] ? (
            <View style={{ gap: 8 }}>
              {group.rows.length === 0 ? (
                <Muted theme={theme}>没有适用的项目，规则不会运行。</Muted>
              ) : null}
              {group.rows.map((row) => (
                <View
                  key={row.id}
                  style={{
                    gap: 3,
                    borderLeftWidth: 2,
                    borderLeftColor: theme.colors.border,
                    paddingLeft: 8,
                  }}
                >
                  <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>
                    {row.projectName}
                    {row.enabled ? "" : " · 已停用"}
                  </Text>
                  {row.progressText ? (
                    <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>
                      当前进度：{row.progressText}
                    </Text>
                  ) : null}
                  <Muted theme={theme}>
                    今天已运行 {row.runsToday} 次（每日上限 {row.dailyCap}）· 上次运行：
                    {lastRunText(row.lastRun)}
                  </Muted>
                  {row.ymlFields.length ? (
                    <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
                      此项目有 maintenance.yml 局部覆盖：
                      {row.ymlFields.map((k) => FIELD_LABEL[k]).join("、")}
                    </Text>
                  ) : null}
                  {row.blocked ? (
                    <Text
                      style={{
                        color: row.paused ? theme.colors.statusDanger : theme.colors.statusWarning,
                        fontSize: 12,
                      }}
                    >
                      {BLOCKED_TEXT[row.blocked] ?? row.blocked}
                    </Text>
                  ) : null}
                  <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                    {row.paused ? (
                      <Button
                        theme={theme}
                        label={busy === `resume:${row.id}` ? "恢复中..." : "恢复"}
                        disabled={busy !== null}
                        onPress={() => void resume(row)}
                      />
                    ) : null}
                    <Button
                      theme={theme}
                      label={
                        busy === `run:${row.id}` ? "运行中..." : `只运行「${row.projectName}」`
                      }
                      disabled={busy !== null || !row.enabled}
                      onPress={() => void runNow(group, row)}
                    />
                  </View>
                </View>
              ))}
            </View>
          ) : null}
          {editing === group.key ? (
            <RuleEditor
              theme={theme}
              initial={draftFromDef(group.def)}
              initialScope={group.scope}
              projects={s.projects}
              sources={group.sources}
              readOnly={group.readOnly}
              presets={s.presets}
              saving={busy === `save:${group.key}`}
              onCancel={() => setEditing(null)}
              onSave={(fields, scope, keepOpen) =>
                void saveConfig(
                  `save:${group.key}`,
                  (config) => ({
                    config: applyRuleEdit(
                      config,
                      {
                        name: group.name,
                        origin: group.origin === "custom" ? "custom" : "builtin",
                        base: group.base,
                      },
                      fields,
                      scope,
                    ),
                  }),
                  `「${group.name}」已保存`,
                  keepOpen,
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
              <Muted theme={theme}>规则名称</Muted>
              <TextInput
                value={creating.name}
                onChangeText={(name) => setCreating({ name })}
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
                initialScope="all"
                projects={s.projects}
                sources={ALL_BUILTIN}
                presets={s.presets}
                saving={busy === "create"}
                onCancel={() => setCreating(null)}
                onSave={(fields, scope) =>
                  void saveConfig(
                    "create",
                    (config) => addCustomRule(config, creating.name, takenNames, fields, scope),
                    `已创建规则「${creating.name.trim()}」`,
                  )
                }
              />
            </>
          ) : (
            <Button theme={theme} label="新建规则" onPress={() => setCreating({ name: "" })} />
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
  {
    kind: "int",
    key: "commitPollSeconds",
    label: "检查“合入提交数”触发条件的最小间隔（秒，5-3600）",
    min: 5,
    max: 3600,
  },
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
          label="连续被驳回多少个任务后暂停规则"
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
      <MaintenanceDiagnostics theme={theme} />
      <Group theme={theme} title="高级">
        <FieldsCard fields={ADVANCED_FIELDS} values={values} save={save} />
      </Group>
    </SettingsSection>
  );
}

const DIAGNOSTIC_ROW_STYLE = { gap: 3 };

function MaintenanceDiagnostics({ theme }: { theme: PluginTheme }) {
  const statusCall = useRpc(statusRpc);
  const status = useQuery({
    queryKey: ["vibe-maintain", "status"],
    queryFn: async () => parseStatus(await statusCall({})),
    refetchInterval: 5_000,
  });
  return (
    <Group theme={theme} title="运行诊断">
      <Muted theme={theme}>
        所有规则输出均先规划，等待用户 /执行；运行次数与每日上限按规则 × 项目保留。
      </Muted>
      {status.error ? (
        <Muted theme={theme}>无法读取诊断：{formatRpcError(status.error)}</Muted>
      ) : null}
      {status.data?.configErrors.map((item) => (
        <Muted key={item.project} theme={theme}>
          {item.project}：{item.errors.join("；")}
        </Muted>
      ))}
      {status.data?.groups.flatMap((group) =>
        group.rows.map((row) => (
          <View key={row.id} style={DIAGNOSTIC_ROW_STYLE}>
            <Muted theme={theme}>
              {row.projectName} · {row.name}
            </Muted>
            <Muted theme={theme}>
              今日 {row.runsToday}/{row.dailyCap} 次 · {row.progressText ?? "按触发条件运行"}
            </Muted>
            <Muted theme={theme}>
              {row.blocked ? (BLOCKED_TEXT[row.blocked] ?? row.blocked) : "可运行"} ·{" "}
              {lastRunText(row.lastRun)}
            </Muted>
          </View>
        )),
      )}
    </Group>
  );
}


