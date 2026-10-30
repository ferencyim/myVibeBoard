/* eslint-disable react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-new-object-as-prop, react-perf/jsx-no-new-array-as-prop -- Small plugin section; option lists depend on the loaded catalog. */
import { useRpc } from "@getpaseo/plugin/client";
import { ModelPickerField, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { modelsListRpc } from "../shared/rpc";
import type { BotPatch } from "../shared/vibe/contract/bots";
import { Caption, ControlRow, ErrorLine, Group } from "./settings-kit";
import type { BotView } from "./use-bot-saver";

/** Model card of the settings panel: one row picker (provider · model · effort) with optimistic saving. */
export function ModelSection({ bot, save }: { bot: BotView; save(patch: BotPatch): Promise<boolean> }) {
  const modelsList = useRpc(modelsListRpc);
  const models = useQuery({ queryKey: ["vibe-bots", "models", bot.projectId], queryFn: () => modelsList({ projectId: bot.projectId ?? undefined }), staleTime: 60_000 });
  const { refetch } = models;
  const presetId = bot.presetId ?? "";
  const presets = useMemo(() => [{ label: "直接选择模型", value: "" }, ...(models.data?.presets ?? []).map((item) => ({ label: item.name, value: item.id }))], [models.data]);
  const changePreset = useCallback((value: string) => { void save({ presetId: value || null }); }, [save]);
  // 打开选择器时后台刷新模型目录，不阻塞选择器。
  const refreshInBackground = useCallback(() => {
    void modelsList({ projectId: bot.projectId ?? undefined, refresh: true }).then(() => refetch()).catch(() => undefined);
  }, [modelsList, bot.projectId, refetch]);
  const select = useCallback(async (provider: string, model: string) => {
    if (!(await save({ provider, model, thinking: "" }))) throw new Error("保存模型失败");
  }, [save]);
  const selectThinking = useCallback(async (id: string) => {
    if (!(await save({ thinking: id }))) throw new Error("保存思考强度失败");
  }, [save]);
  const hasPresets = (models.data?.presets.length ?? 0) > 0 || !!presetId;
  return <>
    <Group title="模型">
      {hasPresets ? <ControlRow icon="Cpu" label="预设"><SettingsSelect inline label="预设" value={presetId} options={presets} onValueChange={changePreset} /></ControlRow> : null}
      {!presetId ? <ModelPickerField providers={models.data?.providers ?? []} provider={bot.provider ?? ""} model={bot.model ?? ""} thinking={bot.thinking} loading={models.isLoading} onSelect={select} onSelectThinking={selectThinking} onOpen={refreshInBackground} /> : null}
    </Group>
    {bot.pendingModel ? <Caption>模型变更待空闲时应用。</Caption> : null}
    <ErrorLine error={models.error} />
  </>;
}
