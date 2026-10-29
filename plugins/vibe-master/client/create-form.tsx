import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Modal, ScrollView, Text, TextInput, View } from "react-native";
import { botModelsListRpc as modelsListRpc } from "../shared/rpc";
import { Pressable } from "react-native";
function Button({ theme, label, onPress, disabled }: { theme: PluginTheme; label: string; onPress(): void; disabled?: boolean }) {
  const styles = useMemo(() => ({ button: { padding: 10, opacity: disabled ? 0.5 : 1 }, text: { color: theme.colors.foreground } }), [theme, disabled]);
  return <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={styles.button}><Text style={styles.text}>{label}</Text></Pressable>;
}
import { suggestedModel } from "./create-model";

export function BotCreateForm({ theme, projectId, busy, error, onCancel, onSubmit }: {
  theme: PluginTheme; projectId?: string; busy: boolean; error?: string; onCancel(): void;
  onSubmit(value: { name: string; title: string; instructions: string; presetId: string | null; provider: string | null; model: string | null; thinking: string }): void;
}) {
  const list = useRpc(modelsListRpc);
  const catalog = useQuery({ queryKey: ["vibe-bots", "create-models", projectId], queryFn: () => list({ projectId }) });
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [presetId, setPresetId] = useState("");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [thinking, setThinking] = useState("");
  const [initialized, setInitialized] = useState(false);
  useEffect(() => {
    if (!catalog.data || initialized) return;
    const preset = catalog.data.presets.find((item) => item.id === catalog.data.defaultPresetId);
    if (preset) setPresetId(preset.id);
    else {
      const cheap = suggestedModel(catalog.data.providers);
      if (cheap) { setProvider(cheap.provider); setModel(cheap.model); }
    }
    setInitialized(true);
  }, [catalog.data, initialized]);
  const selectedProvider = catalog.data?.providers.find((item) => item.provider === provider);
  const selectedModel = selectedProvider?.models.find((item) => item.id === model);
  const styles = useMemo(() => ({
    input: { color: theme.colors.foreground, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: 10 },
    description: { color: theme.colors.foreground, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: 10, minHeight: 80 },
    page: { flex: 1, backgroundColor: theme.colors.surface0 }, content: { padding: 16, gap: 12 },
    text: { color: theme.colors.foreground }, muted: { color: theme.colors.foregroundMuted },
    danger: { color: theme.colors.statusDanger }, fields: { gap: 8 },
  }), [theme]);
  const presets = useMemo(() => [{ label: "直接选择模型", value: "" }, ...(catalog.data?.presets ?? []).map((p) => ({ label: p.name, value: p.id }))], [catalog.data]);
  const providers = useMemo(() => [{ label: "请选择 provider", value: "" }, ...(catalog.data?.providers ?? []).map((p) => ({ label: p.provider, value: p.provider }))], [catalog.data]);
  const modelOptions = useMemo(() => [{ label: "请选择模型", value: "" }, ...(selectedProvider?.models ?? []).map((m) => ({ label: m.name, value: m.id }))], [selectedProvider]);
  const thinkingOptions = useMemo(() => [{ label: "默认", value: "" }, ...(selectedModel?.thinkingOptions ?? []).map((o) => ({ label: o.name, value: o.id }))], [selectedModel]);
  const changeProvider = useCallback((v: string) => { setProvider(v); setModel(""); setThinking(""); }, []);
  const changeModel = useCallback((v: string) => { setModel(v); setThinking(""); }, []);
  const submit = useCallback(() => onSubmit({ name: name.trim(), title, instructions, presetId: presetId || null, provider: presetId ? null : provider, model: presetId ? null : model, thinking }), [onSubmit, name, title, instructions, presetId, provider, model, thinking]);
  const canSubmit = presetId || (provider && model);
  return <Modal visible transparent={false} onRequestClose={onCancel}>
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <Text style={styles.text}>新建{projectId ? "项目 " : ""}bot</Text>
      <TextInput accessibilityLabel="名字" placeholder="名字（必填）" placeholderTextColor={theme.colors.foregroundMuted} value={name} onChangeText={setName} maxLength={100} style={styles.input} />
      <TextInput accessibilityLabel="头衔" placeholder="头衔（可选）" placeholderTextColor={theme.colors.foregroundMuted} value={title} onChangeText={setTitle} maxLength={200} style={styles.input} />
      <TextInput accessibilityLabel="角色说明" placeholder="角色说明（可选，也可稍后编辑）" placeholderTextColor={theme.colors.foregroundMuted} value={instructions} onChangeText={setInstructions} multiline maxLength={30000} style={styles.description} />
      <Text style={styles.muted}>{catalog.isLoading ? "正在读取缓存模型…" : "缓存目录没有价格信息，无法确定最低价；请确认或选择合适的模型。"}</Text>
      {catalog.error ? <Text style={styles.danger}>模型目录加载失败：{String(catalog.error)}</Text> : null}
      <SettingsSelect label="预设" value={presetId} options={presets} onValueChange={setPresetId} />
      {!presetId ? <View style={styles.fields}>
        <SettingsSelect label="Provider" value={provider} options={providers} onValueChange={changeProvider} />
        <SettingsSelect label="模型" value={model} options={modelOptions} onValueChange={changeModel} />
        <SettingsSelect label="思考强度" value={thinking} options={thinkingOptions} onValueChange={setThinking} />
      </View> : null}
      {error ? <Text accessibilityRole="alert" style={styles.danger}>{error}</Text> : null}
      <Button theme={theme} label={busy ? "正在新建…" : "确认新建"} disabled={busy || !name.trim() || !canSubmit} onPress={submit} />
      <Button theme={theme} label="取消" disabled={busy} onPress={onCancel} />
    </ScrollView>
  </Modal>;
}
