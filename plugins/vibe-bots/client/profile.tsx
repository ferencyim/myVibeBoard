import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { z } from "zod";
import { botsListRpc, botsUpdateRpc, botsArchiveRpc, projectDefaultBotSetRpc, modelsListRpc, memoriesAddRpc, memoriesUpdateRpc, memoriesRemoveRpc, BotViewSchema } from "../shared/rpc";
import type { BotMemory } from "../shared/vibe/contract/bots";
import { Button, Feedback, Field, Page } from "./ui";
import { useBotConversation } from "./use-bot-conversation";

type BotView = z.infer<typeof BotViewSchema>;
interface ProfileProps extends PluginScreenProps { bot: BotView }

function useProfileStyles(theme: PluginTheme) {
  return useMemo(() => StyleSheet.create({
    title: { color: theme.colors.foreground, fontSize: 20 },
    muted: { color: theme.colors.foregroundMuted },
    text: { color: theme.colors.foreground },
    fields: { gap: 8 },
    memory: { gap: 8, borderBottomWidth: 1, borderColor: theme.colors.border, paddingBottom: 12 },
  }), [theme]);
}


export function BotProfileScreen(props: PluginScreenProps) {
  const list = useRpc(botsListRpc);
  const query = useQuery({ queryKey: ["vibe-bots", "list"], queryFn: () => list({}), refetchInterval: 15000 });
  const bot = query.data?.bots.find((item) => item.id === props.params.botId);
  const retry = useCallback(() => { void query.refetch(); }, [query]);
  if (bot) return <Profile key={bot.id} {...props} bot={bot} />;
  return <Page theme={props.theme}><Feedback theme={props.theme} error={query.error} message={query.isLoading ? "正在加载…" : "找不到此 bot，可能已被归档。"} /><Button theme={props.theme} label="重试" onPress={retry} /></Page>;
}

function Profile({ bot, theme, navigation }: ProfileProps) {
  const styles = useProfileStyles(theme);
  const update = useRpc(botsUpdateRpc);
  const openAgent = useCallback((id: string) => navigation?.openAgent({ agentId: id }), [navigation]);
  const conversation = useBotConversation(bot.id, openAgent);
  const archive = useRpc(botsArchiveRpc);
  const setDefault = useRpc(projectDefaultBotSetRpc);
  const modelsList = useRpc(modelsListRpc);
  const client = useQueryClient();
  const models = useQuery({ queryKey: ["vibe-bots", "models"], queryFn: () => modelsList({}) });
  const [name, setName] = useState(bot.name);
  const [title, setTitle] = useState(bot.title);
  const [instructions, setInstructions] = useState(bot.instructions);
  const [presetId, setPresetId] = useState(bot.presetId ?? "");
  const [provider, setProvider] = useState(bot.provider ?? "");
  const [model, setModel] = useState(bot.model ?? "");
  const [thinking, setThinking] = useState(bot.thinking);
  const [notifications, setNotifications] = useState(bot.notifications);
  const [page, setPage] = useState<"profile" | "instructions" | "memories">("profile");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const projectId = bot.projectId;
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
    return run(() => update({ id: bot.id, patch: { name, title, instructions, presetId: presetId || null, provider: provider || null, model: model || null, thinking, notifications } }), "已保存；运行中的模型变更会在空闲时应用。");
  }, [run, update, bot.id, name, title, instructions, presetId, provider, model, thinking, notifications]);
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
  const selectedProvider = models.data?.providers.find((item) => item.provider === provider);
  const selectedModel = selectedProvider?.models.find((item) => item.id === model);
  const presets = useMemo(() => [{ label: "直接选择模型", value: "" }, ...(models.data?.presets ?? []).map((item) => ({ label: item.name, value: item.id }))], [models.data]);
  const providers = useMemo(() => [{ label: "请选择 provider", value: "" }, ...(models.data?.providers ?? []).map((item) => ({ label: item.provider, value: item.provider }))], [models.data]);
  const modelOptions = useMemo(() => [{ label: "请选择模型", value: "" }, ...(selectedProvider?.models ?? []).map((item) => ({ label: item.name + (item.isDefault ? "（默认）" : ""), value: item.id }))], [selectedProvider]);
  const thinkingOptions = useMemo(() => [{ label: "默认", value: "" }, ...(selectedModel?.thinkingOptions ?? []).map((item) => ({ label: item.name, value: item.id }))], [selectedModel]);
  if (page === "memories") return <MemoryList bot={bot} theme={theme} onBack={actions.profile} />;
  if (page === "instructions") return <Page theme={theme}><Button theme={theme} label="返回资料" onPress={actions.profile} /><Field theme={theme} label="角色说明" value={instructions} onChangeText={setInstructions} multiline /><Button theme={theme} label={busy ? "正在保存…" : "保存"} disabled={busy} onPress={actions.save} /><Feedback theme={theme} error={error} message={message} /></Page>;
  return <Page theme={theme}>
    <Text style={styles.title}>{bot.name}</Text>
    {bot.pendingModel ? <Text style={styles.muted}>模型变更待空闲时应用。</Text> : null}
    <Field theme={theme} label="名字" value={name} onChangeText={setName} />
    <Field theme={theme} label="头衔" value={title} onChangeText={setTitle} />
    <Button theme={theme} label="编辑角色说明" onPress={actions.instructions} />
    <SettingsSelect label="模型 / 预设" value={presetId} options={presets} onValueChange={setPresetId} />
    {!presetId ? <View style={styles.fields}><SettingsSelect label="Provider" value={provider} options={providers} onValueChange={actions.provider} /><SettingsSelect label="模型" value={model} options={modelOptions} onValueChange={actions.model} /><SettingsSelect label="思考强度" value={thinking} options={thinkingOptions} onValueChange={setThinking} /></View> : null}
    <Feedback theme={theme} error={models.error} />
    <SettingsSwitch label="通知" value={notifications.enabled} onValueChange={actions.notifications} />
    <SettingsSwitch label="完成时通知" value={notifications.completed} onValueChange={actions.completed} />
    <SettingsSwitch label="失败时通知" value={notifications.failed} onValueChange={actions.failed} />
    {projectId ? <SettingsSwitch label="默认项目 bot" hint="环境故障通知与完成后的整理交给默认 bot；在另一个 bot 的资料里可更换。" value={bot.isDefault} disabled={busy || bot.isDefault} onValueChange={actions.setDefault} /> : null}
    <Button theme={theme} label={busy ? "正在保存…" : "保存资料"} disabled={busy || !name.trim()} onPress={actions.save} />
    <Button theme={theme} label="长期记忆" onPress={actions.memories} />
    <Button theme={theme} label={conversation.label} disabled={busy || conversation.disabled || !navigation} onPress={actions.open} />
    <Feedback theme={theme} error={conversation.error} />
    <Button theme={theme} label="归档 bot" disabled={busy} onPress={actions.archive} />
    <Feedback theme={theme} error={error} message={message} />
  </Page>;
}

interface MemoryListProps { bot: BotView; theme: PluginTheme; onBack(): void }
function MemoryList({ bot, theme, onBack }: MemoryListProps) {
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
  if (editing) return <Page theme={theme}><Button theme={theme} label="返回记忆列表" disabled={busy} onPress={actions.back} /><Field theme={theme} label="记忆内容（个人偏好与经验）" value={text} onChangeText={setText} multiline /><Button theme={theme} label={busy ? "正在保存…" : "保存记忆"} disabled={busy || !text.trim()} onPress={actions.save} /><Feedback theme={theme} error={error} /></Page>;
  return <Page theme={theme}>
    <Button theme={theme} label="返回资料" onPress={onBack} />
    <Text style={styles.muted}>个人记忆只存偏好与经验。项目记忆仍以 AGENTS.md / CLAUDE.md 为准。</Text>
    {memories.map(({ memory, edit, pin, remove: removeMemory }) => <View key={memory.id} style={styles.memory}>
      <Text style={styles.text} numberOfLines={3}>{memory.pinned ? "★ " : ""}{memory.text}</Text>
      <Text style={styles.muted}>{memory.source === "bot" ? "bot 记录" : "你添加的"} · {memory.updatedAt}</Text>
      <Button theme={theme} label="查看 / 编辑全文" disabled={busy} onPress={edit} />
      <Button theme={theme} label={memory.pinned ? "取消置顶" : "置顶"} disabled={busy} onPress={pin} />
      <Button theme={theme} label="删除" disabled={busy} onPress={removeMemory} />
    </View>)}
    {bot.memories.length === 0 ? <Text style={styles.muted}>还没有长期记忆。</Text> : null}
    <Button theme={theme} label="添加记忆" disabled={busy} onPress={actions.add} />
    <Feedback theme={theme} error={error} message={busy ? "正在保存…" : message} />
  </Page>;
}
