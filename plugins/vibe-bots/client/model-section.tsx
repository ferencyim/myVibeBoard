/* eslint-disable react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-new-object-as-prop, react-perf/jsx-no-new-array-as-prop -- Small plugin section; option lists depend on the loaded catalog. */
import { useRpc } from "@getpaseo/plugin/client";
import { SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { modelsListRpc } from "../shared/rpc";
import type { BotPatch } from "../shared/vibe/contract/bots";
import { modelChoices } from "./create-model";
import { Caption, ControlRow, ErrorLine, Group, OutlineButton } from "./settings-kit";
import type { BotView } from "./use-bot-saver";

/**
 * Model rows of the settings panel (preset / provider / model / thinking).
 * Replacement point for the new model picker (WP-150): swap this component's body for the picker
 * and keep the `bot` + `save(patch)` contract.
 */
export function ModelSection({ bot, save }: { bot: BotView; save(patch: BotPatch): Promise<boolean> }) {
  const modelsList = useRpc(modelsListRpc);
  const [refreshing, setRefreshing] = useState(false);
  const models = useQuery({ queryKey: ["vibe-bots", "models", bot.projectId], queryFn: () => modelsList({ projectId: bot.projectId ?? undefined }), staleTime: 60_000, refetchInterval: refreshing ? 3000 : false });
  const [refreshError, setRefreshError] = useState("");
  const refresh = useCallback(() => {
    setRefreshing(true); setRefreshError("");
    void modelsList({ projectId: bot.projectId ?? undefined, refresh: true }).then(() => models.refetch()).catch((reason: unknown) => setRefreshError(String(reason))).finally(() => setRefreshing(false));
  }, [modelsList, bot.projectId, models]);
  const provider = bot.provider ?? "";
  const model = bot.model ?? "";
  const presetId = bot.presetId ?? "";
  const selectedProvider = models.data?.providers.find((item) => item.provider === provider);
  const selectedModel = selectedProvider?.models.find((item) => item.id === model);
  const presets = useMemo(() => [{ label: "直接选择模型", value: "" }, ...(models.data?.presets ?? []).map((item) => ({ label: item.name, value: item.id }))], [models.data]);
  const providers = useMemo(() => [{ label: "请选择 provider", value: "" }, ...(models.data?.providers ?? []).map((item) => ({ label: item.provider, value: item.provider }))], [models.data]);
  const modelOptions = useMemo(() => modelChoices(selectedProvider?.models, !!provider && !models.isLoading), [selectedProvider, provider, models.isLoading]);
  const thinkingOptions = useMemo(() => [{ label: "默认", value: "" }, ...(selectedModel?.thinkingOptions ?? []).map((item) => ({ label: item.name, value: item.id }))], [selectedModel]);
  const changePreset = useCallback((value: string) => { void save({ presetId: value || null }); }, [save]);
  const changeProvider = useCallback((value: string) => { void save({ provider: value || null, model: null, thinking: "" }); }, [save]);
  const changeModel = useCallback((value: string) => { void save({ model: value || null, thinking: "" }); }, [save]);
  const changeThinking = useCallback((value: string) => { void save({ thinking: value }); }, [save]);
  return <>
    <Group title="模型">
      <ControlRow icon="Cpu" label="预设"><SettingsSelect inline label="预设" value={presetId} options={presets} onValueChange={changePreset} /></ControlRow>
      {!presetId ? <ControlRow label="Provider"><SettingsSelect inline label="Provider" value={provider} options={providers} onValueChange={changeProvider} /></ControlRow> : null}
      {!presetId ? <ControlRow label="模型"><SettingsSelect inline label="模型" value={model} options={modelOptions} onValueChange={changeModel} /></ControlRow> : null}
      {!presetId ? <ControlRow icon="Brain" label="思考强度"><SettingsSelect inline label="思考强度" value={bot.thinking} options={thinkingOptions} onValueChange={changeThinking} /></ControlRow> : null}
      <ControlRow label="模型列表"><OutlineButton label={refreshing ? "正在刷新…" : "刷新"} disabled={refreshing} onPress={refresh} /></ControlRow>
    </Group>
    {bot.pendingModel ? <Caption>模型变更待空闲时应用。</Caption> : null}
    <ErrorLine error={refreshError || models.error} />
  </>;
}
