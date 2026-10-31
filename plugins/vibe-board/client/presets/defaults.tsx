import { ModelPickerField, SettingsCard, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { Modal } from "@getpaseo/plugin/client/react-native";
import React, { useCallback, useMemo, useState, type ComponentProps } from "react";
import { StyleSheet, Text, View } from "react-native";
import type {
  ModelDefaults,
  Preset,
  PresetEnvironmentKind,
  PresetPermissionMode,
} from "../../shared/vibe/contract";
import { errorMessage } from "../common/logic";
import { Btn, Muted, TextField } from "../common/ui";
import {
  DEFAULT_MODEL_FIELDS,
  DISABLED,
  INHERIT,
  defaultPlannerLabel,
  inheritedDefaultLabel,
  setModelDefault,
  type DefaultModelField,
} from "./defaults-model";
import { ENVIRONMENT_LABELS, plannersOf, setPlanner } from "./logic";
import { roleDraftOf, type RoleDraft } from "./role-setting";

import { ReviewTimeoutField } from "./review-timeout";
import { useHost } from "../common/ctx";

type PickerProviders = ComponentProps<typeof ModelPickerField>["providers"];

/** Stores one role's draft and returns the setting id the defaults point at (see role-setting.ts). */
export type SaveRole = (
  role: string,
  current: Preset | undefined,
  draft: RoleDraft,
) => Promise<string>;

interface EditorProps {
  value: ModelDefaults;
  onChange: (next: ModelDefaults) => void;
  settings: readonly Preset[];
  providers: PickerProviders;
  saveRole: SaveRole;
  inherited?: ModelDefaults;
  disabled?: boolean;
  showReviewTimeout?: boolean;
}

const ENVIRONMENT_OPTIONS = (Object.keys(ENVIRONMENT_LABELS) as PresetEnvironmentKind[]).map(
  (id) => ({ value: id, label: ENVIRONMENT_LABELS[id] }),
);
/** Providers whose agents have a Fast mode feature. */
const FAST_PROVIDERS = new Set(["claude", "codex"]);

function BackupRow({
  index,
  backup,
  providers,
  disabled,
  onChange,
  onRemove,
}: {
  index: number;
  backup: RoleDraft["backups"][number];
  providers: PickerProviders;
  disabled?: boolean;
  onChange: (index: number, provider: string, model: string) => void;
  onRemove: (index: number) => void;
}) {
  const change = useCallback(
    (provider: string, model: string) => onChange(index, provider, model),
    [onChange, index],
  );
  const remove = useCallback(() => onRemove(index), [onRemove, index]);
  return (
    <View style={styles.backup}>
      <Muted>{`备用模型 ${index + 1}`}</Muted>
      <ModelPickerField
        providers={providers}
        provider={backup.provider}
        model={backup.model}
        thinking={backup.thinking}
        disabled={disabled}
        onSelect={change}
      />
      <Btn disabled={disabled} small label="移除" onPress={remove} />
    </View>
  );
}

/** One role: model picker, prompt (sub page), fallback models, permission and environment. */
function RoleCard({
  label,
  settingId,
  settings,
  providers,
  disabled,
  onSave,
  stateText,
  extra,
}: {
  label: string;
  settingId: string | null | undefined;
  settings: readonly Preset[];
  providers: PickerProviders;
  disabled?: boolean;
  onSave: (current: Preset | undefined, draft: RoleDraft) => void;
  stateText?: string;
  extra?: React.ReactNode;
}) {
  const { theme } = useHost();
  const current = settings.find((setting) => setting.id === settingId);
  const draft = useMemo(() => roleDraftOf(current), [current]);
  const [promptOpen, setPromptOpen] = useState(false);
  const [promptText, setPromptText] = useState("");
  const apply = useCallback(
    (patch: Partial<RoleDraft>) => onSave(current, { ...draft, ...patch }),
    [onSave, current, draft],
  );
  const select = useCallback(
    (provider: string, model: string) => apply({ provider, model, thinking: "", fastMode: false }),
    [apply],
  );
  const selectThinking = useCallback((thinking: string) => apply({ thinking }), [apply]);
  const setFast = useCallback((fastMode: boolean) => apply({ fastMode }), [apply]);
  const addBackup = useCallback(
    (provider: string, model: string) =>
      apply({
        backups: [
          ...draft.backups,
          { provider, model, thinking: "", permissionMode: draft.permissionMode },
        ],
      }),
    [apply, draft],
  );
  const changeBackup = useCallback(
    (index: number, provider: string, model: string) =>
      apply({
        backups: draft.backups.map((backup, i) =>
          i === index ? { ...backup, provider, model, thinking: "" } : backup,
        ),
      }),
    [apply, draft],
  );
  const removeBackup = useCallback(
    (index: number) => apply({ backups: draft.backups.filter((_, i) => i !== index) }),
    [apply, draft],
  );
  const openPrompt = useCallback(() => {
    setPromptText(draft.instructions);
    setPromptOpen(true);
  }, [draft.instructions]);
  const closePrompt = useCallback((open: boolean) => {
    if (!open) setPromptOpen(false);
  }, []);
  const savePrompt = useCallback(() => {
    apply({ instructions: promptText });
    setPromptOpen(false);
  }, [apply, promptText]);
  const setPermission = useCallback(
    (value: string) => apply({ permissionMode: value as PresetPermissionMode }),
    [apply],
  );
  const setEnvironment = useCallback(
    (value: string) => apply({ environmentKind: value as PresetEnvironmentKind }),
    [apply],
  );
  const setRuntimeEnv = useCallback(
    (value: string) => apply({ runtimeEnv: value.trim() || null }),
    [apply],
  );
  return (
    <View style={styles.role}>
      <Text style={[styles.roleTitle, { color: theme.colors.foreground }]}>{label}</Text>
      <ModelPickerField
        providers={providers}
        provider={draft.provider}
        model={draft.model}
        thinking={draft.thinking}
        disabled={disabled}
        onSelect={select}
        onSelectThinking={selectThinking}
        fast={draft.fastMode}
        onFastChange={FAST_PROVIDERS.has(draft.provider) ? setFast : undefined}
        permission={draft.permissionMode}
        onPermissionChange={setPermission}
      />
      {stateText ? <Muted>{stateText}</Muted> : null}
      {current ? (
        <>
          <Btn
            disabled={disabled}
            small
            label={draft.instructions.trim() ? "角色提示词（已设置）" : "角色提示词"}
            onPress={openPrompt}
          />
          {draft.backups.map((backup, index) => (
            <BackupRow
              key={`${index}:${backup.provider}/${backup.model}`}
              index={index}
              backup={backup}
              providers={providers}
              disabled={disabled}
              onChange={changeBackup}
              onRemove={removeBackup}
            />
          ))}
          <View style={styles.backup}>
            <Muted>添加备用模型</Muted>
            <ModelPickerField
              providers={providers}
              provider=""
              model=""
              thinking=""
              disabled={disabled}
              onSelect={addBackup}
            />
          </View>
          <SettingsSelect
            disabled={disabled}
            label="运行目录"
            value={draft.environmentKind}
            options={ENVIRONMENT_OPTIONS}
            onValueChange={setEnvironment}
          />
          <TextField
            key={draft.runtimeEnv ?? ""}
            defaultValue={draft.runtimeEnv ?? ""}
            placeholder="运行环境（如 android-emulator，可空）"
            onEndEditing={(event) => setRuntimeEnv(event.nativeEvent.text)}
          />
        </>
      ) : null}
      {extra}
      <Modal title={`${label} · 角色提示词`} open={promptOpen} onOpenChange={closePrompt}>
        <Modal.Content>
          <View style={styles.prompt}>
            <TextField
              multiline
              value={promptText}
              onChangeText={setPromptText}
              placeholder="这个角色的固定提示词（可空）"
            />
            <Btn variant="primary" label="保存提示词" onPress={savePrompt} />
          </View>
        </Modal.Content>
      </Modal>
    </View>
  );
}

/** Runs a save in the background and shows its failure under the card. */
function useBackgroundSave() {
  const [error, setError] = useState<string | null>(null);
  const run = useCallback((save: () => Promise<void>) => {
    setError(null);
    save().catch((cause: unknown) => setError(errorMessage(cause)));
  }, []);
  return { error, run };
}

function RoleField({
  role,
  label,
  value,
  onChange,
  settings,
  providers,
  saveRole,
  inherited,
  disabled,
}: EditorProps & { role: DefaultModelField; label: string }) {
  const { error, run } = useBackgroundSave();
  const onSave = useCallback(
    (current: Preset | undefined, draft: RoleDraft) =>
      run(async () => onChange(setModelDefault(value, role, await saveRole(role, current, draft)))),
    [run, saveRole, role, onChange, value],
  );
  const inherit = useCallback(
    () => onChange(setModelDefault(value, role, INHERIT)),
    [onChange, value, role],
  );
  const disable = useCallback(
    () => onChange(setModelDefault(value, role, DISABLED)),
    [onChange, value, role],
  );
  const nameOf = (id: string) => {
    const setting = settings.find((item) => item.id === id);
    return setting ? `${setting.provider}/${setting.model}` : id;
  };
  let inheritLabel = role === "main" ? "守护进程默认模型" : "沿用 #1 模型";
  if (inherited) inheritLabel = inheritedDefaultLabel(role, inherited, nameOf);
  const state = value[role] === null ? "已关闭" : value[role] ? "" : inheritLabel;
  return (
    <RoleCard
      label={label}
      settingId={value[role] ?? undefined}
      settings={settings}
      providers={providers}
      disabled={disabled}
      onSave={onSave}
      stateText={error ?? state}
      extra={
        <View style={styles.actions}>
          {value[role] !== undefined ? (
            <Btn disabled={disabled} small label="沿用默认" onPress={inherit} />
          ) : null}
          {(role === "scout" || role === "reviewer") && value[role] !== null ? (
            <Btn disabled={disabled} small label="不启用" onPress={disable} />
          ) : null}
        </View>
      }
    />
  );
}

function PlannerField({
  value,
  onChange,
  settings,
  providers,
  saveRole,
  disabled,
  index,
  id,
}: EditorProps & { index: number; id: string | null }) {
  const { error, run } = useBackgroundSave();
  const onSave = useCallback(
    (current: Preset | undefined, draft: RoleDraft) =>
      run(async () =>
        onChange(setPlanner(value, index, await saveRole(`planners.${index}`, current, draft))),
      ),
    [run, saveRole, index, onChange, value],
  );
  const remove = useCallback(
    () => onChange(setPlanner(value, index, null)),
    [onChange, value, index],
  );
  let label = "#2 方案 · 添加审阅模型";
  if (id) label = index === 0 ? "#2 方案 · 写作" : `#2 方案 · 审阅 ${index}`;
  return (
    <RoleCard
      label={label}
      settingId={id}
      settings={settings}
      providers={providers}
      disabled={disabled}
      onSave={onSave}
      stateText={error ?? undefined}
      extra={id ? <Btn disabled={disabled} small label="移除" onPress={remove} /> : null}
    />
  );
}

export function DefaultModelsEditor(props: EditorProps) {
  const { value, onChange, settings, inherited, disabled } = props;
  const planners = plannersOf(value);
  const plannerRows = planners.map((id, index) => ({
    id,
    index,
    key: JSON.stringify(planners.slice(0, index + 1)),
  }));
  const nameOf = (id: string) => {
    const setting = settings.find((item) => item.id === id);
    return setting ? `${setting.provider}/${setting.model}` : id;
  };
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
          <PlannerField key={`new:${planners.length}`} {...props} id={null} index={planners.length} />
          {!planners.length ? (
            <Muted>{inherited ? defaultPlannerLabel(inherited, nameOf) : "沿用 #1 模型"}</Muted>
          ) : null}
        </SettingsCard>
        {props.showReviewTimeout ? <ReviewTimeoutField /> : null}
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
const styles = StyleSheet.create({
  stack: { gap: 8 },
  role: { gap: 8, padding: 12 },
  roleTitle: { fontSize: 14, fontWeight: "500" },
  backup: { gap: 4, paddingLeft: 8 },
  actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  prompt: { gap: 12, padding: 16 },
});
