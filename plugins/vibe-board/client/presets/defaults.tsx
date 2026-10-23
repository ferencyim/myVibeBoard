// Default models per job (WP-108): the global level (管理 → Agent 预设, top) and the project level
// (project edit form, each job may follow the global default). One editor for both.

import { useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import React, { useState } from "react";
import { Text, View } from "react-native";
import { MODEL_ROLES, type ModelDefaults, type Preset } from "../../shared/vibe/contract";
import { errorMessage } from "../board/logic";
import { queryKey, type BoardApi } from "../common/api";
import { Btn, Muted } from "../common/ui";
import { ModelPicker } from "../planning/ModelPicker";
import { MODEL_ROLE_LABELS } from "../planning/logic";
import { setDefault } from "./logic";

/** Seven pickers. `inherited` (project level) names the global default each job follows when empty. */
export function DefaultModelsEditor({
  value,
  onChange,
  presets,
  inherited,
}: {
  value: ModelDefaults;
  onChange: (next: ModelDefaults) => void;
  presets: readonly Preset[];
  inherited?: ModelDefaults;
}) {
  const nameOf = (id: string | null | undefined) => presets.find((p) => p.id === id)?.name ?? null;
  return (
    <View style={{ gap: 4 }}>
      {MODEL_ROLES.map((role) => (
        <ModelPicker
          key={role}
          label={MODEL_ROLE_LABELS[role]}
          presets={presets}
          value={value[role] ?? null}
          noneLabel={
            inherited
              ? nameOf(inherited[role])
                ? `沿用全局：${nameOf(inherited[role])}`
                : "沿用全局（未设置）"
              : "不设置"
          }
          onChange={(id) => onChange(setDefault(value, role, id))}
        />
      ))}
    </View>
  );
}

/** Global defaults with their own save button (top of the Agent 预设 tab). */
export function GlobalDefaultsPanel({
  api,
  presets,
}: {
  api: BoardApi;
  presets: readonly Preset[];
}) {
  const toast = useToast();
  const query = useQuery({
    queryKey: queryKey("defaults"),
    queryFn: () => api.defaultsGet({}),
    retry: false,
  });
  const [draft, setDraft] = useState<ModelDefaults | null>(null);
  const saved = query.data?.global ?? {};
  const shown = draft ?? saved;
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(saved);
  const save = async () => {
    try {
      await api.defaultsSet({ global: shown });
      setDraft(null);
      await query.refetch();
      toast.show("已保存默认模型", { variant: "success" });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ fontWeight: "600" }}>默认模型（全局）</Text>
      <Muted>
        新卡片按「项目 → 全局」预填各项模型；卡片没选时运行也按此回落（探路、复核没选表示不做）。项目可在项目编辑里单独覆盖。
      </Muted>
      {query.error ? <Muted>{errorMessage(query.error)}</Muted> : null}
      <DefaultModelsEditor value={shown} presets={presets} onChange={setDraft} />
      {dirty ? (
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Btn variant="primary" label="保存默认模型" onPress={save} />
          <Btn label="放弃修改" onPress={() => setDraft(null)} />
        </View>
      ) : null}
    </View>
  );
}
