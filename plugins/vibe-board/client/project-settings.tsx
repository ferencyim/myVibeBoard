import React, { useCallback, useMemo } from "react";
import { StyleSheet, Text } from "react-native";
import { useSettings, type PluginProjectSettingsSectionProps } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { boardSettings } from "../shared/settings";

export function ProjectAgentSettingsSection({ theme }: PluginProjectSettingsSectionProps) {
  const settings = useSettings(boardSettings);
  const styles = useMemo(
    () =>
      StyleSheet.create({
        muted: { color: theme.colors.foregroundMuted },
        error: { color: theme.colors.statusDanger },
      }),
    [theme],
  );
  const consolidate = useCallback(
    (projectConsolidateOnDone: boolean) => {
      if (settings.status !== "ready" || settings.saving) return;
      void settings.save({ ...settings.values, projectConsolidateOnDone }, settings.revision);
    },
    [settings],
  );
  const requirements = useCallback(
    (projectMaintainRequirements: boolean) => {
      if (settings.status !== "ready" || settings.saving) return;
      void settings.save({ ...settings.values, projectMaintainRequirements }, settings.revision);
    },
    [settings],
  );
  const sweep = useCallback(
    (projectSweepOnStart: boolean) => {
      if (settings.status !== "ready" || settings.saving) return;
      void settings.save({ ...settings.values, projectSweepOnStart }, settings.revision);
    },
    [settings],
  );
  if (settings.status === "loading")
    return <Text style={styles.muted}>正在加载项目 agent 策略…</Text>;
  if (settings.status !== "ready") return <Text style={styles.error}>{settings.error}</Text>;
  const { values } = settings;
  return (
    <SettingsCard>
      <SettingsSwitch
        label="任务完成后整理项目记忆"
        hint="本主机的所有项目共用这些策略；各项目 agent 负责整理自己的项目。"
        disabled={settings.saving}
        value={values.projectConsolidateOnDone}
        onValueChange={consolidate}
      />
      <SettingsSwitch
        label="同时维护需求文档"
        disabled={settings.saving}
        value={values.projectMaintainRequirements}
        onValueChange={requirements}
      />
      <SettingsSwitch
        label="启动时补扫未整理任务"
        disabled={settings.saving}
        value={values.projectSweepOnStart}
        onValueChange={sweep}
      />
      {settings.saving ? <Text style={styles.muted}>正在保存…</Text> : null}
      {settings.saveError ? <Text style={styles.error}>{settings.saveError}</Text> : null}
    </SettingsCard>
  );
}
