import type { PluginTheme } from "@getpaseo/plugin";
import {
  useRpc,
  useSettings,
  type PluginScreenProps,
  type PluginSidebarItemProps,
  type PluginSurfaceProps,
} from "@getpaseo/plugin/client";
import { SettingsCard, SettingsInput, SettingsSection, SettingsSelect, SettingsSwitch, SidebarRow } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import {
  masterSettings,
  permissionRpc,
  sessionsRpc,
  statusRpc,
  switchRpc,
} from "../shared/rpc";
import { sessionDetail, sessionTitle, switchChoices, targetLabel, type SwitchChoice } from "./format";

/** Modes a provider may offer; one the provider lacks falls back to auto. */
const PERMISSION_CHOICES = [
  { label: "自动（推荐）", value: "auto" },
  { label: "每步都询问（Claude: default）", value: "default" },
  { label: "自动接受文件修改（Claude）", value: "acceptEdits" },
  { label: "自动审查（Codex）", value: "auto-review" },
  { label: "完全访问（Codex）", value: "full-access" },
  { label: "绕过权限（Claude）", value: "bypassPermissions" },
] as const;

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

function levelColor(theme: PluginTheme, level: SwitchChoice["level"]): string {
  if (level === "exhausted") return theme.colors.statusDanger;
  if (level === "tight") return theme.colors.statusWarning;
  return theme.colors.foregroundMuted;
}

export function MasterScreen({ theme, navigation }: PluginScreenProps) {
  const queryClient = useQueryClient();
  const statusCall = useRpc(statusRpc);
  const switchCall = useRpc(switchRpc);
  const permissionCall = useRpc(permissionRpc);
  const sessionsCall = useRpc(sessionsRpc);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const status = useQuery({
    queryKey: ["vibe-master", "status"],
    queryFn: () => statusCall({ includeProviders: true }),
    refetchInterval: 5_000,
  });
  const sessions = useQuery({
    queryKey: ["vibe-master", "sessions"],
    queryFn: () => sessionsCall({ limit: 30 }),
    refetchInterval: 10_000,
  });
  const s = status.data;

  const choose = async (choice: SwitchChoice) => {
    setBusy(choice.key);
    setError(null);
    try {
      await switchCall({ ...choice.request, reason: "在总 agent 页面切换" });
      await queryClient.invalidateQueries({ queryKey: ["vibe-master"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const choosePermission = async (mode: string) => {
    setBusy(`permission:${mode}`);
    setError(null);
    try {
      await permissionCall({ mode });
      await queryClient.invalidateQueries({ queryKey: ["vibe-master"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: 16, gap: 12 }}>
      {status.error ? (
        <Text style={{ color: theme.colors.statusDanger }}>无法加载总 agent：{String(status.error)}</Text>
      ) : null}
      {!s ? <Muted theme={theme}>加载中...</Muted> : null}
      {s ? (
        <>
          <Section theme={theme} title="总 agent">
            <Text style={{ color: theme.colors.foreground }}>{targetLabel(s.target)}</Text>
            <Muted theme={theme}>
              {s.targetSource === "switched" ? "你手动切换的订阅" : "设置里的默认订阅"}
              {s.session ? ` - 会话${s.session.state}` : " - 尚无会话"}
              {s.paseoReady ? "" : " - 等待 daemon"}
            </Muted>
            {!s.enabled ? <Muted theme={theme}>总 agent 已在设置中停用。</Muted> : null}
            {s.lastAlert ? (
              <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
                {s.lastAlert.message}（{s.lastAlert.at.slice(11, 16)} UTC）
              </Text>
            ) : null}
          </Section>

          <Section theme={theme} title="历次会话">
            <Muted theme={theme}>
              切换订阅或权限模式后，旧会话不会被归档，可随时打开查看当时的对话。新会话的第一条消息带有插件按看板生成的交接摘要。
            </Muted>
            {(sessions.data?.sessions ?? []).map((row) => (
              <View
                key={row.sessionId}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: row.current ? theme.colors.accent : theme.colors.border,
                  backgroundColor: theme.colors.surface2,
                  padding: 10,
                }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={{ color: theme.colors.foreground }}>{sessionTitle(row)}</Text>
                  <Muted theme={theme}>{sessionDetail(row)}</Muted>
                </View>
                {navigation ? (
                  <Pressable
                    onPress={() => navigation.openAgent({ agentId: row.agentId })}
                    style={{ borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, paddingHorizontal: 12, paddingVertical: 6 }}
                  >
                    <Text style={{ color: theme.colors.foreground }}>打开</Text>
                  </Pressable>
                ) : null}
              </View>
            ))}
            {sessions.data && sessions.data.sessions.length === 0 ? <Muted theme={theme}>还没有总 agent 会话。</Muted> : null}
            {sessions.error ? <Muted theme={theme}>无法加载会话列表：{String(sessions.error)}</Muted> : null}
            {!navigation ? <Muted theme={theme}>当前客户端不支持从插件打开会话，请在会话列表中按标题 Vibe Master 查找。</Muted> : null}
          </Section>

          <Section theme={theme} title="队列">
            <Muted theme={theme}>
              {s.queue.running
                ? `正在处理 ${s.queue.running.kind}${s.queue.running.cardKey ? `（${s.queue.running.cardKey}）` : ""}`
                : "空闲"}
              {s.queue.blocked ? ` - ${s.queue.blocked} 个任务在等待 daemon 或额度` : ""}
            </Muted>
            {s.queue.pending.map((j, i) => (
              <Text key={i} style={{ color: theme.colors.foreground, fontSize: 13 }}>
                {j.kind} {j.cardKey ?? ""}
                {j.dueInSeconds > 0 ? ` ${j.dueInSeconds} 秒后` : " 已排队"}
              </Text>
            ))}
          </Section>

          {s.permission ? (
            <Section theme={theme} title="权限模式">
              <Text style={{ color: theme.colors.foreground }}>
                {s.permission.auto ? "自动" : s.permission.label}
                {s.permission.modeId && s.permission.auto ? `（${s.permission.label}）` : ""}
                {!s.permission.modeId ? "（provider 默认）" : ""}
              </Text>
              <Muted theme={theme}>
                {s.permission.source === "switched" ? "你手动切换的模式" : "设置里的默认模式"}。对总 agent 和规划会话生效；运行中的会话会以新模式重启，卡片不受影响。
              </Muted>
              {[
                { id: "auto", label: "自动（provider 的自动审批模式）" },
                ...s.permission.options.map((o) => ({ id: o.id, label: o.label })),
                ...(s.permission.source === "switched" ? [{ id: "settings", label: "跟随设置默认值" }] : []),
              ].map((option) => {
                const active = option.id !== "settings" && (option.id === "auto" ? s.permission!.auto : option.id === s.permission!.modeId && !s.permission!.auto);
                return (
                  <Pressable
                    key={option.id}
                    disabled={busy !== null || active}
                    onPress={() => void choosePermission(option.id)}
                    style={{
                      borderRadius: 8,
                      borderWidth: 1,
                      borderColor: active ? theme.colors.accent : theme.colors.border,
                      backgroundColor: theme.colors.surface2,
                      padding: 10,
                      opacity: busy !== null && busy !== `permission:${option.id}` ? 0.5 : 1,
                    }}
                  >
                    <Text style={{ color: theme.colors.foreground }}>
                      {active ? "当前：" : ""}
                      {option.label}
                      {busy === `permission:${option.id}` ? " ..." : ""}
                    </Text>
                  </Pressable>
                );
              })}
            </Section>
          ) : null}

          <Section theme={theme} title="切换订阅">
            <Muted theme={theme}>卡片、评估和记忆都在看板上，切换后用同一批卡片继续。</Muted>
            {error ? <Text style={{ color: theme.colors.statusDanger }}>{error}</Text> : null}
            {switchChoices(s.providers, s.target).map((choice) => (
              <Pressable
                key={choice.key}
                disabled={busy !== null || choice.active}
                onPress={() => void choose(choice)}
                style={{
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: choice.active ? theme.colors.accent : theme.colors.border,
                  backgroundColor: theme.colors.surface2,
                  padding: 10,
                  opacity: busy !== null && busy !== choice.key ? 0.5 : 1,
                }}
              >
                <Text style={{ color: theme.colors.foreground }}>
                  {choice.active ? "当前：" : ""}
                  {choice.label}
                  {busy === choice.key ? " ..." : ""}
                </Text>
                <Text style={{ color: levelColor(theme, choice.level), fontSize: 12 }}>{choice.detail}</Text>
              </Pressable>
            ))}
            {s.providers.length === 0 ? <Muted theme={theme}>还没有 provider 信息。</Muted> : null}
          </Section>

          {s.switchHistory.length ? (
            <Section theme={theme} title="切换记录">
              {s.switchHistory.slice(-5).map((h, i) => (
                <Muted key={i} theme={theme}>
                  {h.at.slice(0, 16).replace("T", " ")}：{h.from} 到 {h.to}
                  {h.reason ? `（${h.reason}）` : ""}
                </Muted>
              ))}
            </Section>
          ) : null}
        </>
      ) : null}
    </ScrollView>
  );
}

export function MasterSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Bot"
      label="总 agent"
      active={currentScreen?.screenId === "main"}
      onPress={() => openScreen({ screenId: "main" })}
    />
  );
}

/** A settings group that can be folded away. */
function Group({
  theme,
  title,
  initiallyOpen = false,
  children,
}: {
  theme: PluginTheme;
  title: string;
  initiallyOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <View style={{ gap: 8 }}>
      <Pressable onPress={() => setOpen(!open)} style={{ paddingVertical: 8 }}>
        <Text style={{ color: theme.colors.foreground, fontWeight: "600", fontSize: 15 }}>
          {open ? "▾ " : "▸ "}
          {title}
        </Text>
      </Pressable>
      {open ? children : null}
    </View>
  );
}

const Button = ({ theme, label, onPress, disabled }: { theme: PluginTheme; label: string; onPress(): void; disabled?: boolean }) => (
  <Pressable
    disabled={disabled}
    onPress={onPress}
    style={{
      borderRadius: 8,
      borderWidth: 1,
      borderColor: theme.colors.border,
      paddingHorizontal: 12,
      paddingVertical: 6,
      opacity: disabled ? 0.5 : 1,
    }}
  >
    <Text style={{ color: theme.colors.foreground }}>{label}</Text>
  </Pressable>
);

/** Host navigation to another plugin's screen (a fork addition; absent on older hosts). */
type CrossPluginNavigation = {
  openPluginScreen?: (input: { pluginId: string; screenId: string }) => void;
};

export function MasterSettingsScreen({ theme, navigation }: PluginSurfaceProps) {
  const settings = useSettings(masterSettings);
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
  const num = (text: string, fallback: number) => {
    const n = Number(text);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const integer = (text: string, fallback: number, min: number, max: number) =>
    Math.round(Math.min(max, Math.max(min, num(text, fallback))));

  return (
    <SettingsSection title="总 agent 设置（手动切换会覆盖默认的 provider 和模型）">
      <Group theme={theme} title="基础" initiallyOpen>
        <SettingsCard>
          <SettingsSwitch label="启用总 agent" value={values.enabled} onValueChange={(enabled: boolean) => save({ ...values, enabled })} />
          <SettingsInput label="Provider" initialValue={values.provider} onChangeText={(provider) => save({ ...values, provider: provider.trim() || "claude" })} />
          <SettingsInput
            label="模型 id（留空：Claude 用 Opus，其它用默认模型）"
            initialValue={values.model}
            onChangeText={(model) => save({ ...values, model: model.trim() })}
          />
          <SettingsInput
            label="思考档位（留空为默认，max 为最高）"
            initialValue={values.thinking}
            onChangeText={(thinking) => save({ ...values, thinking: thinking.trim() })}
          />
          <SettingsSelect
            label="总 agent 与规划会话的权限模式（自动 = provider 的自动审批模式）"
            value={values.permissionMode}
            options={PERMISSION_CHOICES}
            onValueChange={(permissionMode: string) => save({ ...values, permissionMode })}
          />
          <SettingsInput
            label="额度低于多少百分比时提醒"
            initialValue={String(values.quotaLowPct)}
            onChangeText={(text) => save({ ...values, quotaLowPct: Math.min(90, num(text, 20)) })}
          />
        </SettingsCard>
      </Group>

      <Group theme={theme} title="触发：什么时候唤醒总 agent">
        <SettingsCard>
          <SettingsSwitch
            label="新建草稿后自动审查"
            value={values.autoAssessOnCreate}
            onValueChange={(autoAssessOnCreate: boolean) => save({ ...values, autoAssessOnCreate })}
          />
          <SettingsSwitch
            label="修改草稿后自动审查"
            hint="只看标题、描述、验收标准、参考图和标签；总 agent 自己的回写不会触发。"
            value={values.autoAssessOnEdit}
            onValueChange={(autoAssessOnEdit: boolean) => save({ ...values, autoAssessOnEdit })}
          />
          <SettingsSwitch
            label="卡片移回草稿后自动审查"
            value={values.autoAssessOnMoveToDraft}
            onValueChange={(autoAssessOnMoveToDraft: boolean) => save({ ...values, autoAssessOnMoveToDraft })}
          />
          <SettingsInput
            label="防抖秒数（无编辑多久后才审查，1-600）"
            hint="看板上的「让总 agent 审查」不受以上开关和防抖限制，立即审查。"
            initialValue={String(values.debounceSeconds)}
            onChangeText={(text) => save({ ...values, debounceSeconds: integer(text, 30, 1, 600) })}
          />
          <SettingsSwitch
            label="启动时补扫未审查的草稿和未整理的完成卡"
            value={values.sweepOnStart}
            onValueChange={(sweepOnStart: boolean) => save({ ...values, sweepOnStart })}
          />
          <SettingsInput
            label="补扫草稿数量（最新的 N 张，1-50）"
            initialValue={String(values.sweepDraftLimit)}
            onChangeText={(text) => save({ ...values, sweepDraftLimit: integer(text, 10, 1, 50) })}
          />
          <SettingsSwitch
            label="执行会话求助时唤醒（给你提建议，不替你回答）"
            value={values.wakeOnSessionWaiting}
            onValueChange={(wakeOnSessionWaiting: boolean) => save({ ...values, wakeOnSessionWaiting })}
          />
          <SettingsSwitch
            label="卡片完成后整理项目记忆"
            value={values.consolidateOnDone}
            onValueChange={(consolidateOnDone: boolean) => save({ ...values, consolidateOnDone })}
          />
          <SettingsSwitch
            label="维护需求文档（卡片完成时允许总 agent 更新并提交）"
            hint="只提交需求文档这一个文件，不推送；仓库忙或文件被忽略时只在卡片上记一条备注并提醒。"
            value={values.maintainRequirements}
            onValueChange={(maintainRequirements: boolean) => save({ ...values, maintainRequirements })}
          />
        </SettingsCard>
      </Group>

      <Group theme={theme} title="项目上下文">
        <SettingsCard>
          <SettingsInput
            label="需求文档摘录的最大字符数（0 为不附带，默认 6000）"
            hint="超长会截断并注明；被截断时总 agent 不会改写需求文档。"
            initialValue={String(values.requirementsExcerptChars)}
            onChangeText={(text) => {
              const n = Number(text);
              save({ ...values, requirementsExcerptChars: Number.isFinite(n) ? Math.round(Math.min(50_000, Math.max(0, n))) : 6000 });
            }}
          />
        </SettingsCard>
      </Group>

      <Group theme={theme} title="提示词与规则">
        <View style={{ gap: 8 }}>
          <Muted theme={theme}>
            总 agent 的系统规则、规则补充、唤醒消息、规划会话与交接文字都集中在「Agent 行为」页编辑，可按项目覆盖，也能恢复默认。这里不再重复编辑。
          </Muted>
          {(navigation as CrossPluginNavigation | undefined)?.openPluginScreen ? (
            <Button
              theme={theme}
              label="打开「Agent 行为」页"
              onPress={() =>
                (navigation as CrossPluginNavigation).openPluginScreen!({ pluginId: "vibe-board", screenId: "behaviour" })
              }
            />
          ) : (
            <Muted theme={theme}>在侧栏的「Agent 行为」入口中打开。</Muted>
          )}
        </View>
      </Group>

      <Group theme={theme} title="高级：自动化参数">
        <SettingsCard>
          <SettingsInput
            label="向总 agent 提问的超时（分钟，1-120）"
            initialValue={String(values.askTimeoutMinutes)}
            onChangeText={(text) => save({ ...values, askTimeoutMinutes: integer(text, 5, 1, 120) })}
          />
          <SettingsInput
            label="规划会话单回合超时（分钟，1-120）"
            initialValue={String(values.planTurnTimeoutMinutes)}
            onChangeText={(text) => save({ ...values, planTurnTimeoutMinutes: integer(text, 10, 1, 120) })}
          />
          <SettingsInput
            label="规划探路兵超时（分钟，1-120）"
            initialValue={String(values.scoutTimeoutMinutes)}
            onChangeText={(text) => save({ ...values, scoutTimeoutMinutes: integer(text, 5, 1, 120) })}
          />
          <SettingsInput
            label="每条用户消息最多探路轮数（0-10）"
            initialValue={String(values.maxResearchRounds)}
            onChangeText={(text) => save({ ...values, maxResearchRounds: Math.round(Math.min(10, Math.max(0, Number(text) || 0))) })}
          />
          <SettingsInput
            label="规划会话一次处理最多连续回合数（1-100）"
            initialValue={String(values.maxPlanLoops)}
            onChangeText={(text) => save({ ...values, maxPlanLoops: integer(text, 10, 1, 100) })}
          />
          <SettingsInput
            label="回复格式不合规时的重试次数（0-5，0 为不重试）"
            initialValue={String(values.jsonRepairRetries)}
            onChangeText={(text) => save({ ...values, jsonRepairRetries: Math.round(Math.min(5, Math.max(0, Number(text) || 0))) })}
          />
          <SettingsInput
            label="采纳建议后不重新审查的窗口（秒，1-600）"
            initialValue={String(values.proposalWindowSeconds)}
            onChangeText={(text) => save({ ...values, proposalWindowSeconds: integer(text, 15, 1, 600) })}
          />
          <SettingsInput
            label="启动补扫：多少小时内完成的卡要整理记忆（1-720）"
            initialValue={String(values.sweepDoneWindowHours)}
            onChangeText={(text) => save({ ...values, sweepDoneWindowHours: integer(text, 48, 1, 720) })}
          />
          <SettingsInput
            label="额度偏低提醒的冷却（分钟，1-1440）"
            initialValue={String(values.alertCooldownQuotaLowMinutes)}
            onChangeText={(text) => save({ ...values, alertCooldownQuotaLowMinutes: integer(text, 360, 1, 1440) })}
          />
          <SettingsInput
            label="额度报错 / 等待批准提醒的冷却（分钟，1-1440）"
            initialValue={String(values.alertCooldownUrgentMinutes)}
            onChangeText={(text) => save({ ...values, alertCooldownUrgentMinutes: integer(text, 10, 1, 1440) })}
          />
          <SettingsInput
            label="维护暂停 / 需求文档失败提醒的冷却（分钟，1-1440）"
            initialValue={String(values.alertCooldownRoutineMinutes)}
            onChangeText={(text) => save({ ...values, alertCooldownRoutineMinutes: integer(text, 60, 1, 1440) })}
          />
          <SettingsInput
            label="项目块里列出的其它未完成卡片数量（0-200）"
            initialValue={String(values.projectBlockCardLimit)}
            onChangeText={(text) => save({ ...values, projectBlockCardLimit: Math.round(Math.min(200, Math.max(0, Number(text) || 0))) })}
          />
          <SettingsInput
            label="交接摘要的最大字符数（500-30000）"
            initialValue={String(values.handoffMaxChars)}
            onChangeText={(text) => save({ ...values, handoffMaxChars: integer(text, 3500, 500, 30000) })}
          />
          <SettingsInput
            label="交接摘要回看的天数（1-60）"
            initialValue={String(values.handoffRecentDays)}
            onChangeText={(text) => save({ ...values, handoffRecentDays: integer(text, 7, 1, 60) })}
          />
        </SettingsCard>
      </Group>
    </SettingsSection>
  );
}
