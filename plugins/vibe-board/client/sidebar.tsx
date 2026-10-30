import {
  useSettings,
  type PluginSidebarItemProps,
  type PluginSurfaceProps,
} from "@getpaseo/plugin/client";
import { SettingsCard, SettingsInput, SidebarRow } from "@getpaseo/plugin/client/ui";
import { boardSettings } from "../shared/settings";
import { useQuery } from "@tanstack/react-query";
import React, { useCallback, useMemo } from "react";
import type { Project } from "../shared/vibe/contract";
import { ScrollView, Text } from "react-native";
import { HostProvider } from "./common/ctx";
import { useBoardApi, useRefresh } from "./common/api";
import { ManageModal } from "./presets/manager";
import { useProviderUsage } from "./presets/usage";
import { Btn } from "./common/ui";

const EMPTY_PROJECTS: Project[] = [];
const SETTINGS_STYLE = { padding: 16, gap: 12 };
export function BehaviourSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  const openBehaviour = useCallback(() => openScreen({ screenId: "behaviour" }), [openScreen]);
  return (
    <SidebarRow
      icon="Bot"
      label="Agent 行为"
      active={currentScreen?.screenId === "behaviour"}
      onPress={openBehaviour}
    />
  );
}
export function BoardSettingsScreen(props: PluginSurfaceProps) {
  const host = useMemo(
    () => ({
      theme: props.theme,
      compact: props.layout.compact,
      openTaskDefaults: props.navigation?.openPluginSettings
        ? () =>
            props.navigation?.openPluginSettings?.({
              pluginId: "vibe-board",
              screenId: "task-default-models",
            })
        : undefined,
    }),
    [props.theme, props.layout.compact, props.navigation],
  );
  return (
    <HostProvider value={host}>
      <SettingsContent />
    </HostProvider>
  );
}
function SettingsContent() {
  const api = useBoardApi();
  const refresh = useRefresh();
  const usage = useProviderUsage();
  const [open, setOpen] = React.useState(false);
  const projects = useQuery({
    queryKey: ["vibe-board", "projects"],
    queryFn: () => api.projectsList({}),
  });
  const openManager = useCallback(() => setOpen(true), []);
  const closeManager = useCallback(() => setOpen(false), []);
  return (
    <ScrollView contentContainerStyle={SETTINGS_STYLE}>
      <Text>配置项目扩展与任务角色。新任务请在原生工作区发送需求。</Text>
      <Btn label="管理项目" onPress={openManager} />
      <ReviewTimeoutField />
      <ManageModal
        open={open}
        onClose={closeManager}
        api={api}
        projects={projects.data?.projects ?? EMPTY_PROJECTS}
        usage={usage}
        refresh={refresh}
      />
    </ScrollView>
  );
}

/** Owner setting: how long one plan reviewer may run before it counts as failed. */
function ReviewTimeoutField() {
  const settings = useSettings(boardSettings);
  if (settings.status !== "ready") return null;
  const { values, revision } = settings;
  return (
    <SettingsCard>
      <SettingsInput
        label="方案审阅者单人超时（分钟，1-240；超时按失败处理并换候选模型）"
        initialValue={String(values.planReviewTimeoutMinutes)}
        onChangeText={(text) => {
          const minutes = Number(text.trim());
          if (!Number.isFinite(minutes) || minutes < 1 || minutes > 240) return;
          void settings.save({ ...values, planReviewTimeoutMinutes: minutes }, revision);
        }}
      />
    </SettingsCard>
  );
}
