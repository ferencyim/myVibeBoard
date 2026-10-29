import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { z } from "zod";
import { botsListRpc, botsUpdateRpc, botsOpenRpc, botsArchiveRpc, projectDefaultBotSetRpc, modelsListRpc, memoriesAddRpc, memoriesUpdateRpc, memoriesRemoveRpc, BotViewSchema } from "../shared/rpc";
import type { BotMemory } from "../shared/vibe/contract/bots";
import { Button, Feedback, Field, Page } from "./ui";

type BotView = z.infer<typeof BotViewSchema>;
interface ProfileProps extends PluginScreenProps { bot: BotView }

export function BotProfileScreen(props: PluginScreenProps) {
  const list = useRpc(botsListRpc);
  const query = useQuery({ queryKey: ["vibe-bots", "list"], queryFn: () => list({}), refetchInterval: 15000 });
  const bot = query.data?.bots.find((item) => item.id === props.params.botId);
  if (bot) return <Profile key={bot.id} {...props} bot={bot} />;
  return <Page theme={props.theme}><Feedback theme={props.theme} error={query.error} message={query.isLoading ? "正在加载…" : "找不到此 bot，可能已被归档。"} /><Button theme={props.theme} label="重试" onPress={() => void query.refetch()} /></Page>;
}

function Profile({ bot, theme, navigation }: ProfileProps) {
  const update = useRpc(botsUpdateRpc);
  const open = useRpc(botsOpenRpc);
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
  const selectedProvider = models.data?.providers.find((item) => item.provider === provider);
  const selectedModel = selectedProvider?.models.find((item) => item.id === model);
  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true); setError(""); setMessage("");
    try {
      await action();
      await client.invalidateQueries({ queryKey: ["vibe-bots"] });
      setMessage(success);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  }
  function save() {
    return run(() => update({ id: bot.id, patch: { name, title, instructions, presetId: presetId || null, provider: provider || null, model: model || null, thinking, notifications } }), "已保存；运行中的模型变更会在空闲时应用。");
  }
  if (page === "memories") return <MemoryList bot={bot} theme={theme} onBack={() => setPage("profile")} />;
  if (page === "instructions") return <Page theme={theme}><Button theme={theme} label="返回资料" onPress={() => setPage("profile")} /><Field theme={theme} label="角色说明" value={instructions} onChangeText={setInstructions} multiline /><Button theme={theme} label={busy ? "正在保存…" : "保存"} disabled={busy} onPress={() => void save()} /><Feedback theme={theme} error={error} message={message} /></Page>;
  const presets = [{ label: "直接选择模型", value: "" }, ...(models.data?.presets ?? []).map((item) => ({ label: item.name, value: item.id }))];
  const providers = [{ label: "请选择 provider", value: "" }, ...(models.data?.providers ?? []).map((item) => ({ label: item.provider, value: item.provider }))];
  const modelOptions = [{ label: "请选择模型", value: "" }, ...(selectedProvider?.models ?? []).map((item) => ({ label: item.name + (item.isDefault ? "（默认）" : ""), value: item.id }))];
  const thinkingOptions = [{ label: "默认", value: "" }, ...(selectedModel?.thinkingOptions ?? []).map((item) => ({ label: item.name, value: item.id }))];
  return <Page theme={theme}>
    <Text style={{ color: theme.colors.foreground, fontSize: 20 }}>{bot.name}</Text>
    {bot.pendingModel ? <Text style={{ color: theme.colors.foregroundMuted }}>模型变更待空闲时应用。</Text> : null}
    <Field theme={theme} label="名字" value={name} onChangeText={setName} />
    <Field theme={theme} label="头衔" value={title} onChangeText={setTitle} />
    <Button theme={theme} label="编辑角色说明" onPress={() => setPage("instructions")} />
    <SettingsSelect label="模型 / 预设" value={presetId} options={presets} onValueChange={setPresetId} />
    {!presetId ? <View style={{ gap: 8 }}><SettingsSelect label="Provider" value={provider} options={providers} onValueChange={(value) => { setProvider(value); setModel(""); setThinking(""); }} /><SettingsSelect label="模型" value={model} options={modelOptions} onValueChange={(value) => { setModel(value); setThinking(""); }} /><SettingsSelect label="思考强度" value={thinking} options={thinkingOptions} onValueChange={setThinking} /></View> : null}
    <Feedback theme={theme} error={models.error} />
    <SettingsSwitch label="通知" value={notifications.enabled} onValueChange={(enabled) => setNotifications({ ...notifications, enabled })} />
    <SettingsSwitch label="完成时通知" value={notifications.completed} onValueChange={(completed) => setNotifications({ ...notifications, completed })} />
    <SettingsSwitch label="失败时通知" value={notifications.failed} onValueChange={(failed) => setNotifications({ ...notifications, failed })} />
    {projectId ? <SettingsSwitch label="默认项目 bot" hint="环境故障通知与完成后的整理交给默认 bot；在另一个 bot 的资料里可更换。" value={bot.isDefault} disabled={busy || bot.isDefault} onValueChange={() => void run(() => setDefault({ projectId, botId: bot.id }), "已设为默认项目 bot。")} /> : null}
    <Button theme={theme} label={busy ? "正在保存…" : "保存资料"} disabled={busy || !name.trim()} onPress={() => void save()} />
    <Button theme={theme} label="长期记忆" onPress={() => setPage("memories")} />
    <Button theme={theme} label="打开主对话" disabled={busy || !navigation} onPress={() => void run(async () => { const result = await open({ id: bot.id }); navigation?.openAgent({ agentId: result.agentId }); }, "已打开主对话。")} />
    <Button theme={theme} label="归档 bot" disabled={busy} onPress={() => void run(async () => { await archive({ id: bot.id }); navigation?.openPluginScreen?.({ pluginId: "vibe-bots", screenId: "main" }); }, "bot 已归档。")} />
    <Feedback theme={theme} error={error} message={message} />
  </Page>;
}

interface MemoryListProps { bot: BotView; theme: PluginTheme; onBack(): void }
function MemoryList({ bot, theme, onBack }: MemoryListProps) {
  const add = useRpc(memoriesAddRpc);
  const update = useRpc(memoriesUpdateRpc);
  const remove = useRpc(memoriesRemoveRpc);
  const client = useQueryClient();
  const [editing, setEditing] = useState<BotMemory | "new" | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true); setError(""); setMessage("");
    try { await action(); await client.invalidateQueries({ queryKey: ["vibe-bots"] }); setMessage(success); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  async function save() {
    if (!editing) return;
    await run(async () => {
      if (editing === "new") await add({ botId: bot.id, text });
      else await update({ botId: bot.id, id: editing.id, text });
      setEditing(null);
    }, "记忆已保存。");
  }
  if (editing) return <Page theme={theme}><Button theme={theme} label="返回记忆列表" disabled={busy} onPress={() => setEditing(null)} /><Field theme={theme} label="记忆内容（个人偏好与经验）" value={text} onChangeText={setText} multiline /><Button theme={theme} label={busy ? "正在保存…" : "保存记忆"} disabled={busy || !text.trim()} onPress={() => void save()} /><Feedback theme={theme} error={error} /></Page>;
  return <Page theme={theme}>
    <Button theme={theme} label="返回资料" onPress={onBack} />
    <Text style={{ color: theme.colors.foregroundMuted }}>个人记忆只存偏好与经验。项目记忆仍以 AGENTS.md / CLAUDE.md 为准。</Text>
    {bot.memories.map((memory) => <View key={memory.id} style={{ gap: 8, borderBottomWidth: 1, borderColor: theme.colors.border, paddingBottom: 12 }}>
      <Text style={{ color: theme.colors.foreground }} numberOfLines={3}>{memory.pinned ? "★ " : ""}{memory.text}</Text>
      <Text style={{ color: theme.colors.foregroundMuted }}>{memory.source === "bot" ? "bot 记录" : "你添加的"} · {memory.updatedAt}</Text>
      <Button theme={theme} label="查看 / 编辑全文" disabled={busy} onPress={() => { setText(memory.text); setEditing(memory); }} />
      <Button theme={theme} label={memory.pinned ? "取消置顶" : "置顶"} disabled={busy} onPress={() => void run(() => update({ botId: bot.id, id: memory.id, pinned: !memory.pinned }), "置顶状态已更新。")} />
      <Button theme={theme} label="删除" disabled={busy} onPress={() => void run(() => remove({ botId: bot.id, id: memory.id }), "记忆已删除。")} />
    </View>)}
    {bot.memories.length === 0 ? <Text style={{ color: theme.colors.foregroundMuted }}>还没有长期记忆。</Text> : null}
    <Button theme={theme} label="添加记忆" disabled={busy} onPress={() => { setText(""); setEditing("new"); }} />
    <Feedback theme={theme} error={error} message={busy ? "正在保存…" : message} />
  </Page>;
}
