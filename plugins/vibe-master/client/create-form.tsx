import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Modal, ModelPickerField, SettingsCard, SettingsSection, SettingsSelect, TextInput } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { botModelsListRpc as modelsListRpc } from "../shared/rpc";
import { Pressable } from "react-native";
function Button({ theme, label, onPress, disabled, primary }: { theme: PluginTheme; label: string; onPress(): void; disabled?: boolean; primary?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={{ minHeight: 36, paddingHorizontal: 16, justifyContent: "center", borderRadius: 8, borderWidth: 1, borderColor: primary ? theme.colors.accent : theme.colors.border, backgroundColor: primary ? theme.colors.accent : theme.colors.surface2, opacity: disabled ? 0.45 : 1 }}><Text style={{ color: primary ? theme.colors.accentForeground : theme.colors.foreground, fontWeight: "600" }}>{label}</Text></Pressable>;
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
  const styles = useMemo(() => ({
    input: { color: theme.colors.foreground, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: 10 },
    description: { color: theme.colors.foreground, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: 10, minHeight: 80 },
    content: { padding: 16, gap: 12 },
    muted: { color: theme.colors.foregroundMuted },
    danger: { color: theme.colors.statusDanger }, fields: { gap: 16, padding: 16 }, field: { gap: 6 }, label: { color: theme.colors.foregroundMuted, fontSize: 13 }, actions: { flexDirection: "row" as const, justifyContent: "flex-end" as const, gap: 8 },
  }), [theme]);
  const presets = useMemo(() => [{ label: "直接选择模型", value: "" }, ...(catalog.data?.presets ?? []).map((p) => ({ label: p.name, value: p.id }))], [catalog.data]);
  const changeModel = useCallback((nextProvider: string, nextModel: string) => { setProvider(nextProvider); setModel(nextModel); setThinking(""); }, []);
  const submit = useCallback(() => onSubmit({ name: name.trim(), title, instructions, presetId: presetId || null, provider: presetId ? null : provider, model: presetId ? null : model, thinking }), [onSubmit, name, title, instructions, presetId, provider, model, thinking]);
  const closeModal = useCallback((open: boolean) => { if (!open) onCancel(); }, [onCancel]);
  const canSubmit = presetId || (provider && model);
  return <Modal title="新建 bot" open onOpenChange={closeModal}>
    <Modal.Content contentContainerStyle={styles.content}>
      <SettingsSection title="基本资料"><SettingsCard><View style={styles.fields}>
      <View style={styles.field}><Text style={styles.label}>名字</Text>
      <TextInput accessibilityLabel="名字" placeholder="名字（必填）" placeholderTextColor={theme.colors.foregroundMuted} value={name} onChangeText={setName} maxLength={100} style={styles.input} /></View>
      <View style={styles.field}><Text style={styles.label}>头衔</Text>
      <TextInput accessibilityLabel="头衔" placeholder="头衔（可选）" placeholderTextColor={theme.colors.foregroundMuted} value={title} onChangeText={setTitle} maxLength={200} style={styles.input} /></View>
      <View style={styles.field}><Text style={styles.label}>角色说明</Text>
      <TextInput accessibilityLabel="角色说明" placeholder="角色说明（可选，也可稍后编辑）" placeholderTextColor={theme.colors.foregroundMuted} value={instructions} onChangeText={setInstructions} multiline maxLength={30000} style={styles.description} /></View>
      </View></SettingsCard></SettingsSection>
      <SettingsSection title="模型"><SettingsCard><View style={styles.fields}>
      <Text style={styles.muted}>{catalog.isLoading ? "正在读取缓存模型…" : "缓存目录没有价格信息，无法确定最低价；请确认或选择合适的模型。"}</Text>
      {catalog.error ? <Text style={styles.danger}>模型目录加载失败：{String(catalog.error)}</Text> : null}
      <SettingsSelect label="预设" value={presetId} options={presets} onValueChange={setPresetId} />
      {!presetId ? <View style={styles.fields}>
        <ModelPickerField projectId={projectId} providers={catalog.data?.providers ?? []} provider={provider} model={model} thinking={thinking} loading={catalog.isLoading} onSelect={changeModel} onSelectThinking={setThinking} />
      </View> : null}
      </View></SettingsCard></SettingsSection>
      {error ? <Text accessibilityRole="alert" style={styles.danger}>{error}</Text> : null}
      <View style={styles.actions}><Button theme={theme} label="取消" disabled={busy} onPress={onCancel} />
      <Button theme={theme} label={busy ? "正在新建…" : "新建"} primary disabled={busy || !name.trim() || !canSubmit} onPress={submit} /></View>
    </Modal.Content>
  </Modal>;
}
