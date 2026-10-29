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
  SettingsSelect,
  SettingsSwitch,
  SidebarRow,
} from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  masterSettings,
  permissionRpc,
  sessionsRpc,
  statusRpc,
  type PresetChoice,
} from "../shared/rpc";
import { formatRpcError } from "../shared/vibe/ui/rpc-error";
import {
  dispatchLabel,
  presetChoices,
  presetModelLabel,
  quotaLabel,
  sessionDetail,
  sessionTitle,
  targetLabel,
} from "./format";
import { MasterPrompts } from "./prompts";

/** Modes a provider may offer; one the provider lacks falls back to auto. */
const PERMISSION_CHOICES = [
  { label: "跟随预设", value: "preset" },
  { label: "自动（推荐）", value: "auto" },
  { label: "每步都询问（Claude: default）", value: "default" },
  { label: "自动接受文件修改（Claude）", value: "acceptEdits" },
  { label: "自动审查（Codex）", value: "auto-review" },
  { label: "完全访问（Codex）", value: "full-access" },
  { label: "绕过权限（Claude）", value: "bypassPermissions" },
] as const;

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
        borderRadius: 10,
        padding: 12,
        gap: 8,
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

function levelColor(theme: PluginTheme, level: PresetChoice["level"]): string {
  if (level === "exhausted") return theme.colors.statusDanger;
  if (level === "tight") return theme.colors.statusWarning;
  return theme.colors.foregroundMuted;
}

export function MasterScreen(props: PluginScreenProps) {
  const { theme, navigation } = props;
  const queryClient = useQueryClient();
  const statusCall = useRpc(statusRpc);
  const permissionCall = useRpc(permissionRpc);
  const sessionsCall = useRpc(sessionsRpc);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const status = useQuery({
    queryKey: ["vibe-master", "status"],
    queryFn: () => statusCall({}),
    refetchInterval: 5_000,
  });
  const sessions = useQuery({
    queryKey: ["vibe-master", "sessions"],
    queryFn: () => sessionsCall({ limit: 30 }),
    refetchInterval: 10_000,
  });
  const s = status.data;

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
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding: 16, gap: 12 }}
    >
      <MasterConfiguration {...props} />
      {status.error ? (
        <Text style={{ color: theme.colors.statusDanger }}>
          无法加载总 agent：{formatRpcError(status.error)}
        </Text>
      ) : null}
      {error ? <Text style={{ color: theme.colors.statusDanger }}>{error}</Text> : null}
      {!s ? <Muted theme={theme}>加载中...</Muted> : null}
      {s ? (
        <>
          <Section theme={theme} title="总 agent">
            <Text style={{ color: theme.colors.foreground }}>
              {s.preset ? `${s.preset.name}（${targetLabel(s.target)}）` : "尚未选择预设"}
            </Text>
            <Muted theme={theme}>
              {s.preset
                ? s.preset.migrated
                  ? "沿用旧设置匹配到的预设，请在上方确认"
                  : "上方选择的预设"
                : "请在上方选一个预设"}
              {s.session ? ` - 会话${s.session.state}` : " - 尚无会话"}
              {s.paseoReady ? "" : " - 等待 daemon"}
            </Muted>
            <Muted theme={theme}>{dispatchLabel(s.dispatch)}</Muted>
            {!s.enabled ? <Muted theme={theme}>总 agent 已停用，可在上方启用。</Muted> : null}
            {s.lastAlert ? (
              <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
                {s.lastAlert.message}（{s.lastAlert.at.slice(11, 16)} UTC）
              </Text>
            ) : null}
          </Section>

          <Section theme={theme} title="历次会话">
            <Muted theme={theme}>
              更换预设或权限模式后，旧会话不会被归档，可随时打开查看当时的对话。新会话的第一条消息带有插件按任务快照生成的交接摘要。
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
                    style={{
                      borderRadius: 8,
                      borderWidth: 1,
                      borderColor: theme.colors.border,
                      paddingHorizontal: 12,
                      paddingVertical: 6,
                    }}
                  >
                    <Text style={{ color: theme.colors.foreground }}>打开</Text>
                  </Pressable>
                ) : null}
              </View>
            ))}
            {sessions.data && sessions.data.sessions.length === 0 ? (
              <Muted theme={theme}>还没有总 agent 会话。</Muted>
            ) : null}
            {sessions.error ? (
              <Muted theme={theme}>无法加载会话列表：{formatRpcError(sessions.error)}</Muted>
            ) : null}
            {!navigation ? (
              <Muted theme={theme}>
                当前客户端不支持从插件打开会话，请在会话列表中按标题 Vibe Master 查找。
              </Muted>
            ) : null}
          </Section>

          <Section theme={theme} title="队列">
            <Muted theme={theme}>
              {s.queue.running
                ? `正在处理 ${s.queue.running.kind}${s.queue.running.workspaceId ? `（${s.queue.running.workspaceId}）` : ""}`
                : "空闲"}
              {s.queue.blocked ? ` - ${s.queue.blocked} 个任务在等待 daemon 或额度` : ""}
            </Muted>
            {s.queue.pending.map((j, i) => (
              <Text key={i} style={{ color: theme.colors.foreground, fontSize: 13 }}>
                {j.kind} {j.workspaceId ?? ""}
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
                {s.permission.source === "switched" ? "你手动切换的模式" : "设置里的默认模式"}。对总
                agent 生效；运行中的总 agent 会以新模式重建，任务不受影响。
              </Muted>
              {[
                { id: "auto", label: "自动（provider 的自动审批模式）" },
                ...s.permission.options.map((o) => ({ id: o.id, label: o.label })),
                ...(s.permission.source === "switched"
                  ? [{ id: "settings", label: "跟随设置默认值" }]
                  : []),
              ].map((option) => {
                const active =
                  option.id !== "settings" &&
                  (option.id === "auto"
                    ? s.permission!.auto
                    : option.id === s.permission!.modeId && !s.permission!.auto);
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

export function PromptLibrarySidebarItem({
  openPromptLibrary,
  isPromptLibraryActive,
}: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="BookOpen"
      label="提示词仓库"
      active={isPromptLibraryActive}
      onPress={openPromptLibrary}
    />
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

/** Agent preset picker for the master: shared preset rows (name, provider / model, quota). */
function PresetPicker({
  theme,
  presets,
  selectedId,
  migrated,
  loaded,
  onChange,
}: {
  theme: PluginTheme;
  presets: readonly PresetChoice[];
  selectedId: string;
  migrated: boolean;
  loaded: boolean;
  onChange(presetId: string): void;
}) {
  const choices = presetChoices(presets);
  return (
    <View style={{ gap: 6, padding: 12 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 14 }}>模型（预设）</Text>
      <Muted theme={theme}>
        按预设内的模型顺序使用，不可用时自动切换下一个。换预设后旧会话保留，新会话带交接摘要。
      </Muted>
      {loaded && !selectedId ? (
        <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
          还没有选预设：选之前总 agent 不工作，派发会回落到调度器规则。
        </Text>
      ) : null}
      {migrated ? (
        <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
          当前沿用旧设置匹配到的预设，点一下确认即可保存。
        </Text>
      ) : null}
      {choices.map((p) => {
        const selected = p.id === selectedId;
        return (
          <Pressable
            key={p.id}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            onPress={() => onChange(p.id)}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              padding: 10,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: selected ? theme.colors.accent : theme.colors.border,
              backgroundColor: selected ? theme.colors.surface2 : theme.colors.surface1,
            }}
          >
            <View style={{ flex: 1 }}>
              <Text style={{ color: theme.colors.foreground, fontSize: 14 }} numberOfLines={1}>
                {p.name}
              </Text>
              <Muted theme={theme}>{presetModelLabel(p)}</Muted>
            </View>
            <Text style={{ color: levelColor(theme, p.level), fontSize: 12 }}>{quotaLabel(p)}</Text>
          </Pressable>
        );
      })}
      {loaded && choices.length === 0 ? (
        <Muted theme={theme}>还没有预设，请先在「Agent 行为」设置里添加。</Muted>
      ) : null}
    </View>
  );
}

const Button = ({
  theme,
  label,
  onPress,
  disabled,
}: {
  theme: PluginTheme;
  label: string;
  onPress(): void;
  disabled?: boolean;
}) => (
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

export function MasterSettingsScreen({ theme, navigation }: PluginSurfaceProps) {
  const nav = navigation as
    | { openPluginScreen?: (input: { pluginId: string; screenId: string }) => void }
    | undefined;
  return (
    <SettingsSection title="总 agent">
      <Muted theme={theme}>总 agent 的预设、自动化、权限和提示词均在总 agent 面板中设置。</Muted>
      {nav?.openPluginScreen ? (
        <Button
          theme={theme}
          label="打开总 agent 面板"
          onPress={() => nav.openPluginScreen!({ pluginId: "vibe-master", screenId: "main" })}
        />
      ) : (
        <Muted theme={theme}>请从侧栏打开「总 agent」。</Muted>
      )}
    </SettingsSection>
  );
}

function MasterConfiguration(props: PluginSurfaceProps) {
  const { theme } = props;
  const settings = useSettings(masterSettings);
  const statusCall = useRpc(statusRpc);
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: ["vibe-master", "status"],
    queryFn: () => statusCall({}),
    staleTime: 10_000,
    retry: false,
  });
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
    <SettingsSection title="总 agent 设置">
      <Group theme={theme} title="基础" initiallyOpen>
        <SettingsCard>
          <SettingsSwitch
            label="启用总 agent"
            value={values.enabled}
            onValueChange={(enabled: boolean) => save({ ...values, enabled })}
          />
          <PresetPicker
            theme={theme}
            presets={status.data?.presets ?? []}
            selectedId={values.presetId || status.data?.preset?.id || ""}
            migrated={!values.presetId && !!status.data?.preset?.migrated}
            loaded={!!status.data}
            onChange={(presetId) => {
              void settings
                .save({ ...values, presetId, provider: "", model: "", thinking: "" }, revision)
                .then(() => queryClient.invalidateQueries({ queryKey: ["vibe-master"] }));
            }}
          />
          <SettingsSwitch
            label="由总 agent 决定先派发哪些待办卡"
            hint="调度器有空位时，总 agent 为已确认排队任务推荐顺序，仍由调度器检查资源与文件冲突后放行。关闭或总 agent 不可用时按确认时间 FIFO 派发。"
            value={values.dispatch}
            onValueChange={(dispatch: boolean) => save({ ...values, dispatch })}
          />
          <SettingsSelect
            label="权限模式（跟随预设 = 使用当前候选模型的权限）"
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
          <Muted theme={theme}>
            方案、执行与验收由原生任务的对应角色负责。总 agent
            只推荐已确认任务的派发顺序，并在任务完成后整理项目记忆。
          </Muted>
          <SettingsSwitch
            label="启动时补扫未整理的完成任务"
            value={values.sweepOnStart}
            onValueChange={(sweepOnStart: boolean) => save({ ...values, sweepOnStart })}
          />
          <SettingsSwitch
            label="任务完成后整理项目记忆"
            value={values.consolidateOnDone}
            onValueChange={(consolidateOnDone: boolean) => save({ ...values, consolidateOnDone })}
          />
          <SettingsSwitch
            label="维护需求文档（任务完成时允许总 agent 更新并提交）"
            hint="只提交需求文档这一个文件，不推送；仓库忙或文件被忽略时只在任务摘要中记录并提醒。"
            value={values.maintainRequirements}
            onValueChange={(maintainRequirements: boolean) =>
              save({ ...values, maintainRequirements })
            }
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
              save({
                ...values,
                requirementsExcerptChars: Number.isFinite(n)
                  ? Math.round(Math.min(50_000, Math.max(0, n)))
                  : 6000,
              });
            }}
          />
        </SettingsCard>
      </Group>

      <Group theme={theme} title="提示词与规则">
        <MasterPrompts {...props} />
      </Group>

      <Group theme={theme} title="高级：自动化参数">
        <SettingsCard>
          <SettingsInput
            label="总 agent 选择派发的超时（秒，10-600）"
            initialValue={String(values.dispatchTimeoutSeconds)}
            onChangeText={(text) =>
              save({ ...values, dispatchTimeoutSeconds: integer(text, 120, 10, 600) })
            }
          />
          <SettingsInput
            label="向总 agent 提问的超时（分钟，1-120）"
            initialValue={String(values.askTimeoutMinutes)}
            onChangeText={(text) =>
              save({ ...values, askTimeoutMinutes: integer(text, 5, 1, 120) })
            }
          />

          <SettingsInput
            label="回复格式不合规时的重试次数（0-5，0 为不重试）"
            initialValue={String(values.jsonRepairRetries)}
            onChangeText={(text) =>
              save({
                ...values,
                jsonRepairRetries: Math.round(Math.min(5, Math.max(0, Number(text) || 0))),
              })
            }
          />

          <SettingsInput
            label="额度偏低提醒的冷却（分钟，1-1440）"
            initialValue={String(values.alertCooldownQuotaLowMinutes)}
            onChangeText={(text) =>
              save({ ...values, alertCooldownQuotaLowMinutes: integer(text, 360, 1, 1440) })
            }
          />
          <SettingsInput
            label="额度报错 / 等待批准提醒的冷却（分钟，1-1440）"
            initialValue={String(values.alertCooldownUrgentMinutes)}
            onChangeText={(text) =>
              save({ ...values, alertCooldownUrgentMinutes: integer(text, 10, 1, 1440) })
            }
          />
          <SettingsInput
            label="维护暂停 / 需求文档失败提醒的冷却（分钟，1-1440）"
            initialValue={String(values.alertCooldownRoutineMinutes)}
            onChangeText={(text) =>
              save({ ...values, alertCooldownRoutineMinutes: integer(text, 60, 1, 1440) })
            }
          />

          <SettingsInput
            label="交接摘要的最大字符数（500-30000）"
            initialValue={String(values.handoffMaxChars)}
            onChangeText={(text) =>
              save({ ...values, handoffMaxChars: integer(text, 3500, 500, 30000) })
            }
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
