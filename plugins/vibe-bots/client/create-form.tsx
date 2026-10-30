/* eslint-disable react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-new-object-as-prop, react-perf/jsx-no-new-array-as-prop -- Small plugin form; option lists depend on the loaded catalog. */
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { ModelPickerField, Modal } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { modelsListRpc } from "../shared/rpc";
import { suggestedModel } from "./create-model";
import { INSTRUCTIONS_MAX, NAME_MAX, TITLE_MAX } from "./profile-mapping";
import { Caption, ControlRow, ErrorLine, Field, Group, KitProvider, OutlineButton, TextArea } from "./settings-kit";

const contentStyle = { padding: 16, gap: 16 } as const;

export function BotCreateForm({ theme, projectId, busy, error, onCancel, onSubmit }: {
  theme: PluginTheme; projectId?: string; busy: boolean; error?: string; onCancel(): void;
  onSubmit(value: { name: string; title: string; instructions: string; presetId: string | null; provider: string | null; model: string | null; thinking: string; permissionMode: "accept-edits" | "auto" | "full"; fastMode: boolean }): void;
}) {
  const list = useRpc(modelsListRpc);
  const [refreshing, setRefreshing] = useState(false);
  const catalog = useQuery({ queryKey: ["vibe-bots", "create-models", projectId], queryFn: () => list({ projectId }), staleTime: 60_000, refetchInterval: refreshing ? 3000 : false });
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
  const selectModel = useCallback((nextProvider: string, nextModel: string) => { setProvider(nextProvider); setModel(nextModel); setThinking(""); setFastMode(false); }, []);
  const selectThinking = useCallback((id: string) => setThinking(id), []);
  const selectPermission = useCallback((value: string) => setPermissionMode(value as "accept-edits" | "auto" | "full"), []);
  const submit = useCallback(() => onSubmit({ name: name.trim(), title, instructions, presetId: null, provider, model, thinking, permissionMode, fastMode }), [onSubmit, name, title, instructions, provider, model, thinking, permissionMode, fastMode]);
  const closeModal = useCallback((open: boolean) => { if (!open) onCancel(); }, [onCancel]);
  const canSubmit = !!provider && !!model;
  return <Modal title={`新建${projectId ? "项目 " : ""}bot`} open onOpenChange={closeModal}>
    <Modal.Content contentContainerStyle={contentStyle}>
      <KitProvider theme={theme}>
        <Field label="名字" value={name} onChangeText={setName} placeholder="必填" maxLength={NAME_MAX} />
        <Field label="头衔" value={title} onChangeText={setTitle} placeholder="这个 bot 负责什么（可选）" maxLength={TITLE_MAX} />
        <TextArea label="角色说明" value={instructions} onChangeText={setInstructions} placeholder="可选，也可稍后编辑" error={instructions.length > INSTRUCTIONS_MAX ? `最多 ${INSTRUCTIONS_MAX} 个字符` : null} />
        <Group title="模型">
          <ModelPickerField providers={catalog.data?.providers ?? []} provider={provider} model={model} thinking={thinking} loading={catalog.isLoading} onSelect={selectModel} onSelectThinking={selectThinking} fast={fastMode} onFastChange={provider === "claude" || provider === "codex" ? setFastMode : undefined} permission={permissionMode} onPermissionChange={selectPermission} />
          <ControlRow label="模型列表"><OutlineButton label={refreshing ? "正在刷新…" : "刷新"} disabled={refreshing} onPress={refreshModels} /></ControlRow>
        </Group>
        <Caption>{catalog.isLoading ? "正在读取缓存模型…" : "缓存目录没有价格信息，无法确定最低价；请确认或选择合适的模型。"}</Caption>
        {catalog.error ? <ErrorLine error={`模型目录加载失败：${String(catalog.error)}`} /> : null}
        {refreshError ? <ErrorLine error={`刷新模型列表失败：${refreshError}`} /> : null}
        <ErrorLine error={error} />
        <OutlineButton label={busy ? "正在新建…" : "确认新建"} disabled={busy || !name.trim() || !canSubmit} onPress={submit} />
        <OutlineButton label="取消" disabled={busy} onPress={onCancel} />
      </KitProvider>
    </Modal.Content>
  </Modal>;
}
