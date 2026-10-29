import { SettingsSection } from "@getpaseo/plugin/client/ui";
import type {
  PluginSurfaceProps,
  PluginProjectSettingsSectionProps,
} from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import React, { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { StyleSheet, View } from "react-native";
import type { ModelDefaults, Preset } from "../../shared/vibe/contract";
import { useBoardApi, type BoardApi } from "../common/api";
import { HostProvider } from "../common/ctx";
import { errorMessage } from "../common/logic";
import { Btn, Muted } from "../common/ui";
import { DefaultModelsEditor } from "./defaults";
import { openDefaultsForm } from "./defaults-model";

export function TaskDefaultsScreen(props: PluginSurfaceProps) {
  const host = useMemo(
    () => ({ theme: props.theme, compact: props.layout.compact }),
    [props.theme, props.layout.compact],
  );
  return (
    <HostProvider value={host}>
      <SettingsSection title="任务默认模型">
        <DefaultsContent serverId={props.host.id} />
      </SettingsSection>
    </HostProvider>
  );
}
export function ProjectTaskDefaultsSection(props: PluginProjectSettingsSectionProps) {
  const host = useMemo(
    () => ({ theme: props.theme, compact: props.compact }),
    [props.theme, props.compact],
  );
  return (
    <HostProvider value={host}>
      <DefaultsContent
        key={props.serverId + props.projectId}
        serverId={props.serverId}
        projectId={props.projectId}
      />
    </HostProvider>
  );
}
function DefaultsContent({ serverId, projectId }: { serverId: string; projectId?: string }) {
  const api = useBoardApi();
  const defaults = useQuery({
    queryKey: ["vibe-board", "task-defaults", serverId, projectId ?? null],
    queryFn: () => (projectId ? api.projectDefaultsGet({ projectId }) : api.defaultsGet({})),
    retry: false,
  });
  const presets = useQuery({
    queryKey: ["vibe-board", "presets", serverId],
    queryFn: () => api.presetsList({}),
    retry: false,
  });
  const refetchDefaults = defaults.refetch;
  const refetchPresets = presets.refetch;
  const retry = useCallback(() => {
    void refetchDefaults();
    void refetchPresets();
  }, [refetchDefaults, refetchPresets]);
  const onSaved = useCallback(async () => {
    await refetchDefaults();
  }, [refetchDefaults]);
  if (defaults.isPending || presets.isPending) return <Muted>正在加载任务默认模型…</Muted>;
  if (defaults.error || presets.error)
    return (
      <View style={styles.stack}>
        <Muted>{errorMessage(defaults.error ?? presets.error)}</Muted>
        <Btn label="重试" onPress={retry} />
      </View>
    );
  if (!defaults.data || !presets.data) return null;
  const project = "project" in defaults.data ? (defaults.data.project as ModelDefaults) : undefined;
  return (
    <DefaultsForm
      initial={project ?? defaults.data.global}
      inherited={projectId ? defaults.data.global : undefined}
      presets={presets.data.presets}
      api={api}
      projectId={projectId}
      onSaved={onSaved}
    />
  );
}
function DefaultsForm({
  initial,
  inherited,
  presets,
  api,
  projectId,
  onSaved,
}: {
  initial: ModelDefaults;
  inherited?: ModelDefaults;
  presets: readonly Preset[];
  api: BoardApi;
  projectId?: string;
  onSaved: () => Promise<void>;
}) {
  const [model] = useState(() => openDefaultsForm(initial));
  useEffect(() => () => model.close(), [model]);
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const save = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const response = projectId
        ? await api.projectDefaultsSet({ projectId, defaults: state.value })
        : await api.defaultsSet({ global: state.value });
      model.saved("project" in response ? (response.project as ModelDefaults) : response.global);
      await onSaved();
      toast.show("已保存任务默认模型", { variant: "success" });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }, [saving, api, projectId, state.value, model, onSaved, toast]);
  return (
    <View style={styles.form}>
      <DefaultModelsEditor
        disabled={saving}
        value={state.value}
        onChange={model.change}
        presets={presets}
        inherited={inherited}
      />
      {error ? <Muted>{error}</Muted> : null}
      <View style={styles.actions}>
        <Btn
          label={saving ? "正在保存…" : "保存任务默认模型"}
          variant="primary"
          disabled={!state.dirty || saving}
          onPress={save}
        />
        <Btn label="放弃修改" disabled={!state.dirty || saving} onPress={model.reset} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 8 },
  form: { gap: 16 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
});
