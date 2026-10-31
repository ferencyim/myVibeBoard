/* eslint-disable react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-new-object-as-prop, react-perf/jsx-no-new-array-as-prop -- Small plugin section; option lists depend on the loaded catalog. */
import { useRpc } from "@getpaseo/plugin/client";
import { ModelPickerField } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { modelsListRpc } from "../shared/rpc";
import type { BotPatch } from "../shared/vibe/contract/bots";
import { Caption, ErrorLine, Group } from "./settings-kit";
import type { BotView } from "./use-bot-saver";

/** Model card of the settings panel: one row picker (provider · model · effort) with optimistic saving. */
export function ModelSection({ bot, save }: { bot: BotView; save(patch: BotPatch): Promise<boolean> }) {
  const modelsList = useRpc(modelsListRpc);
  const models = useQuery({ queryKey: ["vibe-bots", "models", bot.projectId], queryFn: () => modelsList({ projectId: bot.projectId ?? undefined }), staleTime: 60_000 });
  const { refetch } = models;
  const presetId = bot.presetId ?? "";
  // 旧数据可能还挂着预设：展开成它的首选模型显示，用户重新选择后即不再使用预设。
  const legacyPreset = models.data?.presets.find((item) => item.id === bot.presetId);
  // 打开选择器时后台刷新模型目录，不阻塞选择器。
  const refreshInBackground = useCallback(() => {
    void modelsList({ projectId: bot.projectId ?? undefined, refresh: true }).then(() => refetch()).catch(() => undefined);
  }, [modelsList, bot.projectId, refetch]);
  const select = useCallback(async (provider: string, model: string) => {
    if (!(await save({ provider, model, thinking: "", presetId: null, fastMode: false }))) throw new Error("保存模型失败");
  }, [save]);
  const selectThinking = useCallback(async (id: string) => {
    if (!(await save({ thinking: id }))) throw new Error("保存思考强度失败");
  }, [save]);
  const selectPermission = useCallback(async (value: string) => {
    if (!(await save({ permissionMode: value as BotView["permissionMode"] }))) throw new Error("保存权限失败");
  }, [save]);
  const selectFast = useCallback(async (value: boolean) => {
    if (!(await save({ fastMode: value }))) throw new Error("保存快速模式失败");
  }, [save]);
  const fastProvider = bot.provider === "claude" || bot.provider === "codex";
  return <>
    <Group title="模型">
      <ModelPickerField providers={models.data?.providers ?? []} provider={bot.provider ?? ""} model={bot.model ?? ""} thinking={bot.thinking} loading={models.isLoading} onSelect={select} onSelectThinking={selectThinking} fast={bot.fastMode} onFastChange={fastProvider ? selectFast : undefined} permission={bot.permissionMode} onPermissionChange={selectPermission} onOpen={refreshInBackground} onRefresh={refreshInBackground} />
    </Group>
    {legacyPreset ? <Caption>{`仍沿用角色设置「${legacyPreset.name}」；在上面重新选择模型后将不再使用预设。`}</Caption> : null}
    {bot.pendingModel ? <Caption>模型变更待空闲时应用。</Caption> : null}
    <ErrorLine error={models.error} />
  </>;
}
