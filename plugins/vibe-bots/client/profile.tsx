import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc, type PluginScreenProps, type PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsSection, SettingsSelect, SettingsSwitch, ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState, type PropsWithChildren } from "react";
import { StyleSheet, Text, View } from "react-native";
import { z } from "zod";
import { botsListRpc, botsUpdateRpc, botsArchiveRpc, projectDefaultBotSetRpc, modelsListRpc, memoriesAddRpc, memoriesUpdateRpc, memoriesRemoveRpc, BotViewSchema } from "../shared/rpc";
import type { BotMemory } from "../shared/vibe/contract/bots";
import { Feedback } from "./ui";
import { useBotConversation } from "./use-bot-conversation";
import { findBotForAgent } from "./profile-mapping";

function Page({ theme, children }: PropsWithChildren<{ theme: PluginTheme }>) {
  const styles = useProfileStyles(theme);
  return <ScrollView style={styles.page} contentContainerStyle={styles.pageContent}>{children}</ScrollView>;
}

function LongTextField({ theme, label, value, onChangeText }: { theme: PluginTheme; label: string; value: string; onChangeText(value: string): void }) {
  const styles = useProfileStyles(theme);
  return <View style={styles.fields}><Text style={styles.text}>{label}</Text><TextInput accessibilityLabel={label} value={value} onChangeText={onChangeText} multiline style={styles.longText} /></View>;
}

type BotView = z.infer<typeof BotViewSchema>;
function canAddBackupModel(backups: BotView["backupModels"], provider: string, model: string, thinking: string) {
  return !!provider && !!model && backups.length < 20 && !backups.some((item) => item.provider === provider && item.model === model && item.thinking === thinking);
}

function profileChanged(bot: BotView, draft: { name: string; title: string; instructions: string; presetId: string; provider: string; model: string; thinking: string; backupModels: BotView["backupModels"]; notifications: BotView["notifications"] }) {
  return JSON.stringify(draft) !== JSON.stringify({ name: bot.name, title: bot.title, instructions: bot.instructions, presetId: bot.presetId ?? "", provider: bot.provider ?? "", model: bot.model ?? "", thinking: bot.thinking, backupModels: bot.backupModels, notifications: bot.notifications });
}

interface ProfileProps extends Pick<PluginScreenProps, "theme" | "navigation"> { bot: BotView; tab?: PluginAgentPanelProps["tab"] }

export function BotProfilePanel(props: PluginAgentPanelProps) {
  const list = useRpc(botsListRpc);
  const query = useQuery({ queryKey: ["vibe-bots", "list"], queryFn: () => list({}), refetchInterval: 15000 });
  const bot = findBotForAgent(query.data?.bots ?? [], props.params.agentId);
  const retry = useCallback(() => { void query.refetch(); }, [query]);
  if (bot) return <Profile key={bot.id} theme={props.theme} navigation={props.navigation} tab={props.tab} bot={bot} />;
  return <Page theme={props.theme}><Feedback theme={props.theme} error={query.error} message={query.isLoading ? "正在加载…" : "此会话没有关联的 bot。"} /><SettingsAction label="" actionLabel="重试" onPress={retry} /></Page>;
}

// COMPAT(pluginThemeTokens): added in v0.13.0, remove after 2027-04-29.
const legacyTokens = { spacing: { 2: 8, 3: 12, 4: 16, 24: 96 }, fontSize: { xl: 18 }, borderRadius: { md: 8 }, borderWidth: { 1: 1 } };

function emptyModels(provider: string, loading: boolean, models: readonly unknown[] | undefined) {
  return !!provider && !loading && !models?.length;
}

function modelChoices(provider: string, loading: boolean, models: ReadonlyArray<{ id: string; name: string; isDefault: boolean }> | undefined) {
  return [{ label: emptyModels(provider, loading, models) ? "暂无缓存模型（可稍后重试或改选其它 provider）" : "请选择模型", value: "" }, ...(models ?? []).map((item) => ({ label: item.name + (item.isDefault ? "（默认）" : ""), value: item.id }))];
}

function useProfileStyles(theme: PluginTheme) {
  const spacing = theme.spacing ?? legacyTokens.spacing;
  const fontSize = theme.fontSize ?? legacyTokens.fontSize;
  const borderRadius = theme.borderRadius ?? legacyTokens.borderRadius;
  const borderWidth = theme.borderWidth ?? legacyTokens.borderWidth;
  return useMemo(() => StyleSheet.create({
    page: { flex: 1, backgroundColor: theme.colors.surface0 },
    pageContent: { padding: spacing[4], gap: spacing[3] },
    longText: { color: theme.colors.foreground, borderWidth: borderWidth[1], borderColor: theme.colors.border, borderRadius: borderRadius.md, padding: spacing[3], minHeight: spacing[24], textAlignVertical: "top" },
    title: { color: theme.colors.foreground, fontSize: fontSize.xl },
    muted: { color: theme.colors.foregroundMuted },
    text: { color: theme.colors.foreground },
    fields: { gap: spacing[2] },
    memory: { gap: spacing[2], borderBottomWidth: borderWidth[1], borderColor: theme.colors.border, paddingBottom: spacing[3] },
  }), [theme, spacing, fontSize, borderRadius, borderWidth]);
}


export function BotProfileScreen(props: PluginScreenProps) {
  const list = useRpc(botsListRpc);
  const query = useQuery({ queryKey: ["vibe-bots", "list"], queryFn: () => list({}), refetchInterval: 15000 });
  const bot = query.data?.bots.find((item) => item.id === props.params.botId);
  const retry = useCallback(() => { void query.refetch(); }, [query]);
  if (bot) return <Profile key={bot.id} {...props} bot={bot} />;
  return <Page theme={props.theme}><Feedback theme={props.theme} error={query.error} message={query.isLoading ? "正在加载…" : "找不到此 bot，可能已被归档。"} /><SettingsAction label="" actionLabel="重试" onPress={retry} /></Page>;
}

function Profile({ bot, theme, navigation, tab }: ProfileProps) {
  const styles = useProfileStyles(theme);
  const update = useRpc(botsUpdateRpc);
  const openAgent = useCallback((id: string) => navigation?.openAgent({ agentId: id }), [navigation]);
  const conversation = useBotConversation(bot.id, openAgent);
  const archive = useRpc(botsArchiveRpc);
  const setDefault = useRpc(projectDefaultBotSetRpc);
  const modelsList = useRpc(modelsListRpc);
  const client = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const models = useQuery({ queryKey: ["vibe-bots", "models", bot.projectId], queryFn: () => modelsList({ projectId: bot.projectId ?? undefined }), refetchInterval: refreshing ? 3000 : false });
  const [refreshError, setRefreshError] = useState("");
  const refreshModels = useCallback(() => {
    setRefreshing(true); setRefreshError("");
    void modelsList({ projectId: bot.projectId ?? undefined, refresh: true }).then(() => models.refetch()).catch((reason: unknown) => setRefreshError(String(reason))).finally(() => setRefreshing(false));
  }, [modelsList, bot.projectId, models]);
  const [name, setName] = useState(bot.name);
  const [title, setTitle] = useState(bot.title);
  const [instructions, setInstructions] = useState(bot.instructions);
  const [presetId, setPresetId] = useState(bot.presetId ?? "");
  const [provider, setProvider] = useState(bot.provider ?? "");
  const [model, setModel] = useState(bot.model ?? "");
  const [thinking, setThinking] = useState(bot.thinking);
  const [backupModels, setBackupModels] = useState(bot.backupModels);
  const [notifications, setNotifications] = useState(bot.notifications);
  const [page, setPage] = useState<"profile" | "instructions" | "memories">("profile");
  const [busy, setBusy] = useState(false);
  const [memoryDirty, setMemoryDirty] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const projectId = bot.projectId;
  const modified = profileChanged(bot, { name, title, instructions, presetId, provider, model, thinking, backupModels, notifications });
  useEffect(() => { tab?.setModified(modified || memoryDirty); }, [tab, modified, memoryDirty]);
  const run = useCallback(async (action: () => Promise<unknown>, success: string) => {
    setBusy(true); setError(""); setMessage("");
    try {
      await action();
      await client.invalidateQueries({ queryKey: ["vibe-bots"] });
      setMessage(success);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  }, [client]);
  const save = useCallback(() => {
    return run(() => update({ id: bot.id, patch: { name, title, instructions, presetId: presetId || null, provider: provider || null, model: model || null, thinking, backupModels, notifications } }), "已保存；运行中的模型变更会在空闲时应用。");
  }, [run, update, bot.id, name, title, instructions, presetId, provider, model, thinking, backupModels, notifications]);
  const actions = useMemo(() => ({
    profile: () => setPage("profile"),
    instructions: () => setPage("instructions"),
    memories: () => setPage("memories"),
    save: () => { void save(); },
    provider: (value: string) => { setProvider(value); setModel(""); setThinking(""); },
    model: (value: string) => { setModel(value); setThinking(""); },
    notifications: (enabled: boolean) => setNotifications((current) => ({ ...current, enabled })),
    completed: (completed: boolean) => setNotifications((current) => ({ ...current, completed })),
    failed: (failed: boolean) => setNotifications((current) => ({ ...current, failed })),
    setDefault: () => { if (projectId) void run(() => setDefault({ projectId, botId: bot.id }), "已设为默认项目 bot。"); },
    open: () => { void conversation.open(); },
    archive: () => { void run(async () => { await archive({ id: bot.id }); navigation?.openPluginScreen?.({ pluginId: "vibe-bots", screenId: "main" }); }, "bot 已归档。"); },
  }), [save, projectId, run, setDefault, bot.id, conversation, archive, navigation]);
  const backups = useMemo(() => backupModels.map((backup, index) => ({
    backup, remove: () => setBackupModels(backupModels.filter((_, i) => i !== index)),
  })), [backupModels]);
  const canAddBackup = canAddBackupModel(backupModels, provider, model, thinking);
  const addBackup = useCallback(() => setBackupModels((current) => [...current, { provider, model, thinking }]), [provider, model, thinking]);
  const selectedProvider = models.data?.providers.find((item) => item.provider === provider);
  const selectedModel = selectedProvider?.models.find((item) => item.id === model);
  const presets = useMemo(() => [{ label: "直接选择模型", value: "" }, ...(models.data?.presets ?? []).map((item) => ({ label: item.name, value: item.id }))], [models.data]);
  const providers = useMemo(() => [{ label: "请选择 provider", value: "" }, ...(models.data?.providers ?? []).map((item) => ({ label: item.provider, value: item.provider }))], [models.data]);
  const modelOptions = useMemo(() => modelChoices(provider, models.isLoading, selectedProvider?.models), [selectedProvider, provider, models.isLoading]);
  const thinkingOptions = useMemo(() => [{ label: "默认", value: "" }, ...(selectedModel?.thinkingOptions ?? []).map((item) => ({ label: item.name, value: item.id }))], [selectedModel]);
  if (page === "memories") return <MemoryList bot={bot} theme={theme} onBack={actions.profile} onDirtyChange={setMemoryDirty} />;
  if (page === "instructions") return <Page theme={theme}><SettingsAction label="" actionLabel="返回资料" onPress={actions.profile} /><LongTextField theme={theme} label="角色说明" value={instructions} onChangeText={setInstructions} /><SettingsAction label="" actionLabel={busy ? "正在保存…" : "保存"} disabled={busy} onPress={actions.save} /><Feedback theme={theme} error={error} message={message} /></Page>;
  return <Page theme={theme}>
    <Text style={styles.title}>{bot.name}</Text>
    <Text style={styles.muted}>{bot.title || "bot"}</Text>
    <SettingsSection title="身份"><SettingsCard>
    {bot.pendingModel ? <Text style={styles.muted}>模型变更待空闲时应用。</Text> : null}
    <SettingsInput label="名字" initialValue={name} onChangeText={setName} />
    <SettingsInput label="头衔" initialValue={title} onChangeText={setTitle} />
    </SettingsCard></SettingsSection>
    <SettingsSection title="模型与备用"><SettingsCard>
    <SettingsSelect label="模型 / 预设" value={presetId} options={presets} onValueChange={setPresetId} />
    <Button theme={theme} label={refreshing ? "正在刷新模型列表…" : "刷新模型列表"} disabled={refreshing} onPress={refreshModels} />
    <Feedback theme={theme} error={refreshError} />
    {!presetId ? <View style={styles.fields}><SettingsSelect label="Provider" value={provider} options={providers} onValueChange={actions.provider} /><SettingsSelect label="模型" value={model} options={modelOptions} onValueChange={actions.model} /><SettingsSelect label="思考强度" value={thinking} options={thinkingOptions} onValueChange={setThinking} /></View> : null}
    <Text style={styles.muted}>备用模型按顺序使用</Text>
    {backups.map(({ backup, remove }) => <View key={`${backup.provider}:${backup.model}:${backup.thinking}`} style={styles.fields}>
      <Text style={styles.text}>{backup.provider} / {backup.model}{backup.thinking ? ` · ${backup.thinking}` : ""}</Text>
      <SettingsAction label="" actionLabel="移除备用模型" onPress={remove} />
    </View>)}
    <SettingsAction label="" actionLabel="将当前模型加入备用" disabled={!canAddBackup} onPress={addBackup} />
    <Feedback theme={theme} error={models.error} />
    </SettingsCard></SettingsSection>
    <SettingsSection title="说明"><SettingsCard><SettingsAction label="角色说明" actionLabel="编辑" onPress={actions.instructions} /></SettingsCard></SettingsSection>
    <SettingsSection title="通知"><SettingsCard>
    <SettingsSwitch label="通知" value={notifications.enabled} onValueChange={actions.notifications} />
    <SettingsSwitch label="完成时通知" value={notifications.completed} onValueChange={actions.completed} />
    <SettingsSwitch label="失败时通知" value={notifications.failed} onValueChange={actions.failed} />
    {projectId ? <SettingsSwitch label="默认项目 bot" hint="环境故障通知与完成后的整理交给默认 bot；在另一个 bot 的资料里可更换。" value={bot.isDefault} disabled={busy || bot.isDefault} onValueChange={actions.setDefault} /> : null}
    </SettingsCard></SettingsSection>
    <SettingsAction label="" actionLabel={busy ? "正在保存…" : "保存资料"} disabled={busy || !name.trim()} onPress={actions.save} />
    <SettingsSection title="记忆"><SettingsCard><SettingsAction label={`长期记忆（${bot.memories.length}）`} actionLabel="查看" onPress={actions.memories} /></SettingsCard></SettingsSection>
    <SettingsSection title="例程"><SettingsCard><Text style={styles.muted}>例程将在此处显示。</Text></SettingsCard></SettingsSection>
    <SettingsAction label="" actionLabel={conversation.label} disabled={busy || conversation.disabled || !navigation} onPress={actions.open} />
    <Feedback theme={theme} error={conversation.error} />
    <SettingsAction label="" actionLabel="归档 bot" disabled={busy} onPress={actions.archive} />
    <Feedback theme={theme} error={error} message={message} />
  </Page>;
}

interface MemoryListProps { bot: BotView; theme: PluginTheme; onBack(): void; onDirtyChange(dirty: boolean): void }
function MemoryList({ bot, theme, onBack, onDirtyChange }: MemoryListProps) {
  const styles = useProfileStyles(theme);
  const add = useRpc(memoriesAddRpc);
  const update = useRpc(memoriesUpdateRpc);
  const remove = useRpc(memoriesRemoveRpc);
  const client = useQueryClient();
  const [editing, setEditing] = useState<BotMemory | "new" | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    onDirtyChange(editing !== null && text !== (editing === "new" ? "" : editing.text));
  }, [editing, text, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  const run = useCallback(async (action: () => Promise<unknown>, success: string) => {
    setBusy(true); setError(""); setMessage("");
    try { await action(); await client.invalidateQueries({ queryKey: ["vibe-bots"] }); setMessage(success); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }, [client]);
  const save = useCallback(async () => {
    if (!editing) return;
    await run(async () => {
      if (editing === "new") await add({ botId: bot.id, text });
      else await update({ botId: bot.id, id: editing.id, text });
      setEditing(null);
    }, "记忆已保存。");
  }, [editing, run, add, update, bot.id, text]);
  const actions = useMemo(() => ({
    save: () => { void save(); },
    back: () => setEditing(null),
    add: () => { setText(""); setEditing("new"); },
  }), [save]);
  const memories = useMemo(() => bot.memories.map((memory) => ({
    memory,
    edit: () => { setText(memory.text); setEditing(memory); },
    pin: () => { void run(() => update({ botId: bot.id, id: memory.id, pinned: !memory.pinned }), "置顶状态已更新。"); },
    remove: () => { void run(() => remove({ botId: bot.id, id: memory.id }), "记忆已删除。"); },
  })), [bot.memories, bot.id, run, update, remove]);
  if (editing) return <Page theme={theme}><SettingsAction label="" actionLabel="返回记忆列表" disabled={busy} onPress={actions.back} /><LongTextField theme={theme} label="记忆内容（个人偏好与经验）" value={text} onChangeText={setText} /><SettingsAction label="" actionLabel={busy ? "正在保存…" : "保存记忆"} disabled={busy || !text.trim()} onPress={actions.save} /><Feedback theme={theme} error={error} /></Page>;
  return <Page theme={theme}>
    <SettingsAction label="" actionLabel="返回资料" onPress={onBack} />
    <Text style={styles.muted}>个人记忆只存偏好与经验。项目记忆仍以 AGENTS.md / CLAUDE.md 为准。</Text>
    {memories.map(({ memory, edit, pin, remove: removeMemory }) => <View key={memory.id} style={styles.memory}>
      <Text style={styles.text} numberOfLines={3}>{memory.pinned ? "★ " : ""}{memory.text}</Text>
      <Text style={styles.muted}>{memory.source === "bot" ? "bot 记录" : "你添加的"} · {memory.updatedAt}</Text>
      <SettingsAction label="" actionLabel="查看 / 编辑全文" disabled={busy} onPress={edit} />
      <SettingsAction label="" actionLabel={memory.pinned ? "取消置顶" : "置顶"} disabled={busy} onPress={pin} />
      <SettingsAction label="" actionLabel="删除" disabled={busy} onPress={removeMemory} />
    </View>)}
    {bot.memories.length === 0 ? <Text style={styles.muted}>还没有长期记忆。</Text> : null}
    <SettingsAction label="" actionLabel="添加记忆" disabled={busy} onPress={actions.add} />
    <Feedback theme={theme} error={error} message={busy ? "正在保存…" : message} />
  </Page>;
}
