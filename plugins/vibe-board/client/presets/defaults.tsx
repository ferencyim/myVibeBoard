import { SettingsCard, SettingsSelect, SettingsSection } from "@getpaseo/plugin/client/ui";
import React, { useCallback, useMemo } from "react";
import { StyleSheet, View } from "react-native";
import type { ModelDefaults, Preset } from "../../shared/vibe/contract";
import { Btn } from "../common/ui";
import { plannersOf, setPlanner } from "./logic";
import {
  DEFAULT_MODEL_FIELDS,
  DISABLED,
  INHERIT,
  defaultPlannerLabel,
  inheritedDefaultLabel,
  setModelDefault,
  type DefaultModelField,
} from "./defaults-model";

interface EditorProps {
  value: ModelDefaults;
  onChange: (next: ModelDefaults) => void;
  presets: readonly Preset[];
  inherited?: ModelDefaults;
  disabled?: boolean;
}
function optionsFor(presets: readonly Preset[], id?: string | null) {
  const choices = presets.map((p) => ({ value: p.id, label: p.name }));
  if (id && !presets.some((p) => p.id === id)) choices.push({ value: id, label: id });
  return choices;
}
function RoleField({
  value,
  onChange,
  presets,
  inherited,
  disabled,
  role,
  label,
}: EditorProps & { role: DefaultModelField; label: string }) {
  const options = useMemo(() => {
    const nameOf = (id: string) => presets.find((p) => p.id === id)?.name ?? id;
    let inheritLabel = role === "main" ? "守护进程默认模型" : "沿用 #1 模型";
    if (inherited) inheritLabel = inheritedDefaultLabel(role, inherited, nameOf);
    const choices = [{ value: INHERIT, label: inheritLabel }];
    if (role === "scout" || role === "reviewer") choices.push({ value: DISABLED, label: "不启用" });
    return [...choices, ...optionsFor(presets, value[role])];
  }, [presets, inherited, role, value]);
  const change = useCallback(
    (selection: string) => onChange(setModelDefault(value, role, selection)),
    [onChange, value, role],
  );
  return (
    <SettingsSelect
      disabled={disabled}
      label={label}
      value={value[role] === null ? DISABLED : (value[role] ?? INHERIT)}
      options={options}
      onValueChange={change}
    />
  );
}
function PlannerField({
  value,
  onChange,
  presets,
  disabled,
  index,
  id,
}: EditorProps & { index: number; id: string }) {
  const options = useMemo(
    () => [{ value: INHERIT, label: "移除" }, ...optionsFor(presets, id)],
    [presets, id],
  );
  const change = useCallback(
    (selected: string) =>
      onChange(setPlanner(value, index, selected === INHERIT ? null : selected)),
    [value, onChange, index],
  );
  return (
    <SettingsSelect
      disabled={disabled}
      label={index === 0 ? "#2 方案 · 写作" : "#2 方案 · 审阅 " + index}
      value={id}
      options={options}
      onValueChange={change}
    />
  );
}
export function DefaultModelsEditor(props: EditorProps) {
  const { value, onChange, presets, inherited, disabled } = props;
  const planners = plannersOf(value);
  const plannerRows = planners.map((id, index) => ({
    id,
    index,
    key: JSON.stringify(planners.slice(0, index + 1)),
  }));
  const options = useMemo(() => {
    let label = "沿用 #1 模型";
    if (inherited)
      label = defaultPlannerLabel(inherited, (id) => presets.find((p) => p.id === id)?.name ?? id);
    if (planners.length) label = "不添加";
    return [{ value: INHERIT, label }, ...optionsFor(presets)];
  }, [inherited, presets, planners.length]);
  const addPlanner = useCallback(
    (id: string) => {
      if (id !== INHERIT) onChange(setPlanner(value, planners.length, id));
    },
    [value, onChange, planners.length],
  );
  const inheritPlanner = useCallback(() => {
    const next = { ...value };
    delete next.planners;
    delete next.planner;
    delete next.plan_reviewer;
    onChange(next);
  }, [value, onChange]);
  const roles = DEFAULT_MODEL_FIELDS.map(([role, label]) => (
    <RoleField key={role} {...props} role={role} label={label} />
  ));
  return (
    <View style={styles.stack}>
      <SettingsCard>{roles.slice(0, 2)}</SettingsCard>
      <SettingsSection title="#2 方案" info="第 1 个写作，其余按顺序审阅。">
        <SettingsCard>
          {plannerRows.map((row) => (
            <PlannerField key={row.key} {...props} id={row.id} index={row.index} />
          ))}
          <SettingsSelect
            disabled={disabled}
            label={planners.length ? "#2 方案 · 添加审阅模型" : "#2 方案"}
            value={INHERIT}
            options={options}
            onValueChange={addPlanner}
          />
        </SettingsCard>
        {planners.length ? (
          <Btn
            disabled={disabled}
            label={inherited ? "方案沿用全局" : "方案沿用 #1 模型"}
            onPress={inheritPlanner}
          />
        ) : null}
      </SettingsSection>
      <SettingsCard>{roles.slice(2)}</SettingsCard>
    </View>
  );
}
const styles = StyleSheet.create({ stack: { gap: 8 } });
