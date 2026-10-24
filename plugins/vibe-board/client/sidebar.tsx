import { type PluginSidebarItemProps, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import React, { useCallback, useMemo } from "react";
import type { Preset, Project } from "../shared/vibe/contract";
import { ScrollView, Text } from "react-native";
import { HostProvider } from "./common/ctx";
import { useBoardApi, useRefresh } from "./common/api";
import { ManageModal } from "./presets/manager";
import { useProviderUsage } from "./presets/usage";
import { Btn } from "./common/ui";

const EMPTY_PROJECTS: Project[] = [];
const EMPTY_PRESETS: Preset[] = [];
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
    () => ({ theme: props.theme, compact: props.layout.compact }),
    [props.theme, props.layout.compact],
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
  const presets = useQuery({
    queryKey: ["vibe-board", "presets"],
    queryFn: () => api.presetsList({}),
  });
  const openManager = useCallback(() => setOpen(true), []);
  const closeManager = useCallback(() => setOpen(false), []);
  return (
    <ScrollView contentContainerStyle={SETTINGS_STYLE}>
      <Text>配置项目扩展、角色默认模型和有序模型预设。新任务请在原生工作区发送需求。</Text>
      <Btn label="管理项目与 Agent 预设" onPress={openManager} />
      <ManageModal
        open={open}
        onClose={closeManager}
        api={api}
        projects={projects.data?.projects ?? EMPTY_PROJECTS}
        presets={presets.data?.presets ?? EMPTY_PRESETS}
        usage={usage}
        refresh={refresh}
      />
    </ScrollView>
  );
}
