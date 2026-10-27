// Default models per job (WP-108): the global level (管理 → Agent 预设, top) and the project level
// (project edit form, each job may follow the global default). One editor for both.

import { useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import React, { useState } from "react";
import { Text, View } from "react-native";
import { MODEL_ROLES, type ModelDefaults, type Preset } from "../../shared/vibe/contract";
import { errorMessage } from "../common/logic";
import { queryKey, type BoardApi } from "../common/api";
import { Btn, Muted } from "../common/ui";
import { ModelPicker } from "./ModelPicker";
const MODEL_ROLE_LABELS = {
  scout: "探路",
  worker: "执行主代理",
  subagent: "执行子代理",
  reviewer: "代码复核",
  verifier: "验证",
};
import { plannersOf, setDefault, setPlanner } from "./logic";

/** The #2 方案 list: the first model writes, the rest review in order; then the single jobs.
 *  `inherited` (project level) names the global default each job follows when empty. */
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
  const planners = plannersOf(value);
  const inheritedPlanners = inherited ? plannersOf(inherited) : [];
  const inheritedNames = inheritedPlanners.map((id) => nameOf(id) ?? id).join(" → ");
  return (
    <View style={{ gap: 4 }}>
      <Muted>
        方案模型（#2 方案）：第 1 个写方案，其余依次审阅，最后由第 1 个汇总修订。
        {inherited ? (inheritedNames ? `留空沿用全局：${inheritedNames}` : "留空沿用全局（未设置）") : ""}
      </Muted>
      {planners.map((id, index) => (
        <ModelPicker
          key={`planner-${index}`}
          label={index === 0 ? "方案 · 写方案" : `方案 · 审阅 ${index}`}
          presets={presets}
          value={id}
          noneLabel="移除"
          onChange={(presetId) => onChange(setPlanner(value, index, presetId))}
        />
      ))}
      <ModelPicker
        key={`planner-add-${planners.length}`}
        label={planners.length ? "方案 · 添加审阅模型（可选）" : "方案 · 写方案"}
        presets={presets}
        value={null}
        noneLabel={planners.length ? "不添加" : inherited ? "沿用全局" : "不设置"}
        onChange={(presetId) => presetId && onChange(setPlanner(value, planners.length, presetId))}
      />
      {MODEL_ROLES.filter(
        (role): role is keyof typeof MODEL_ROLE_LABELS => role in MODEL_ROLE_LABELS,
      ).map((role) => (
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
        新任务按「项目 → 全局」选择角色模型；任务中的临时选择优先。项目可在项目编辑里单独覆盖。
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
