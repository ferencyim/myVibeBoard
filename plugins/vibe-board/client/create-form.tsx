import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { ModelPickerField, Modal } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, TextInput } from "react-native";
import { botModelsListRpc as modelsListRpc } from "../shared/project-bots";
import { Pressable } from "react-native";
function Button({ theme, label, onPress, disabled }: { theme: PluginTheme; label: string; onPress(): void; disabled?: boolean }) {
  const styles = useMemo(() => ({ button: { padding: 10, opacity: disabled ? 0.5 : 1 }, text: { color: theme.colors.foreground } }), [theme, disabled]);
  return <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={styles.button}><Text style={styles.text}>{label}</Text></Pressable>;
}
import { suggestedModel } from "./create-model";

export function BotCreateForm({ theme, projectId, busy, error, onCancel, onSubmit }: {
  theme: PluginTheme; projectId?: string; busy: boolean; error?: string; onCancel(): void;
  onSubmit(value: { name: string; title: string; instructions: string; presetId: string | null; provider: string | null; model: string | null; thinking: string; permissionMode: "accept-edits" | "auto" | "full"; fastMode: boolean }): void;
}) {
  const list = useRpc(modelsListRpc);
  const [refreshing, setRefreshing] = useState(false);
  const catalog = useQuery({ queryKey: ["vibe-bots", "create-models", projectId], queryFn: () => list({ projectId }), refetchInterval: refreshing ? 3000 : false });
  const [refreshError, setRefreshError] = useState("");
  const refreshModels = useCallback(() => {
    setRefreshing(true); setRefreshError("");
    void list({ projectId, refresh: true }).then(() => catalog.refetch()).catch((reason: unknown) => setRefreshError(String(reason))).finally(() => setRefreshing(false));
  }, [list, projectId, catalog]);
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [thinking, setThinking] = useState("");
  const [fastMode, setFastMode] = useState(false);
  const [permissionMode, setPermissionMode] = useState<"accept-edits" | "auto" | "full">("auto");
  const [initialized, setInitialized] = useState(false);
  useEffect(() => {
    if (!catalog.data || initialized) return;
    const cheap = suggestedModel(catalog.data.providers);
    if (cheap) { setProvider(cheap.provider); setModel(cheap.model); }
    setInitialized(true);
  }, [catalog.data, initialized]);
  const selectedProvider = catalog.data?.providers.find((item) => item.provider === provider);
  const selectedModel = selectedProvider?.models.find((item) => item.id === model);
  const styles = useMemo(() => ({
    input: { color: theme.colors.foreground, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: 10 },
    description: { color: theme.colors.foreground, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: 10, minHeight: 80 },
    content: { padding: 16, gap: 12 },
    muted: { color: theme.colors.foregroundMuted },
    danger: { color: theme.colors.statusDanger }, fields: { gap: 8 },
  }), [theme]);
  const selectModel = useCallback((nextProvider: string, nextModel: string) => { setProvider(nextProvider); setModel(nextModel); setThinking(""); setFastMode(false); }, []);
  const selectThinking = useCallback((id: string) => setThinking(id), []);
  const selectPermission = useCallback((value: string) => setPermissionMode(value as "accept-edits" | "auto" | "full"), []);
  const submit = useCallback(() => onSubmit({ name: name.trim(), title, instructions, presetId: null, provider, model, thinking, permissionMode, fastMode }), [onSubmit, name, title, instructions, provider, model, thinking, permissionMode, fastMode]);
  const closeModal = useCallback((open: boolean) => { if (!open) onCancel(); }, [onCancel]);
  const canSubmit = !!provider && !!model;
  return <Modal title={`新建${projectId ? "项目 " : ""}bot`} open onOpenChange={closeModal}>
    <Modal.Content contentContainerStyle={styles.content}>
      <TextInput accessibilityLabel="名字" placeholder="名字（必填）" placeholderTextColor={theme.colors.foregroundMuted} value={name} onChangeText={setName} maxLength={100} style={styles.input} />
      <TextInput accessibilityLabel="头衔" placeholder="头衔（可选）" placeholderTextColor={theme.colors.foregroundMuted} value={title} onChangeText={setTitle} maxLength={200} style={styles.input} />
      <TextInput accessibilityLabel="角色说明" placeholder="角色说明（可选，也可稍后编辑）" placeholderTextColor={theme.colors.foregroundMuted} value={instructions} onChangeText={setInstructions} multiline maxLength={30000} style={styles.description} />
      <Text style={styles.muted}>{catalog.isLoading ? "正在读取缓存模型…" : "缓存目录没有价格信息，无法确定最低价；请确认或选择合适的模型。"}</Text>
      {catalog.error ? <Text style={styles.danger}>模型目录加载失败：{String(catalog.error)}</Text> : null}
      <Button theme={theme} label={refreshing ? "正在刷新模型列表…" : "刷新模型列表"} disabled={refreshing} onPress={refreshModels} />
      {refreshError ? <Text style={styles.danger}>刷新模型列表失败：{refreshError}</Text> : null}
      <ModelPickerField providers={catalog.data?.providers ?? []} provider={provider} model={model} thinking={thinking} loading={catalog.isLoading} onSelect={selectModel} onSelectThinking={selectThinking} fast={fastMode} onFastChange={provider === "claude" || provider === "codex" ? setFastMode : undefined} permission={permissionMode} onPermissionChange={selectPermission} />
      {error ? <Text accessibilityRole="alert" style={styles.danger}>{error}</Text> : null}
      <Button theme={theme} label={busy ? "正在新建…" : "确认新建"} disabled={busy || !name.trim() || !canSubmit} onPress={submit} />
      <Button theme={theme} label="取消" disabled={busy} onPress={onCancel} />
    </Modal.Content>
  </Modal>;
}
