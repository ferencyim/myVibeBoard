import { useRpc, useSettings, type PluginSidebarItemProps, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsSection, SettingsSwitch, SidebarRow } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import React from "react";
import { Text, View } from "react-native";
import { boardSettings } from "../shared/settings";
import { boardSummaryRpc } from "../shared/rpc";
import { useSessionsData } from "./common/api";
import { waitingCount } from "./sessions/logic";

/** Sidebar row with the number of cards that are not done yet. */
export function BoardSidebarItem({ theme, currentScreen, openScreen }: PluginSidebarItemProps) {
  const summary = useRpc(boardSummaryRpc);
  const query = useQuery({
    queryKey: ["vibe-board", "sidebar-summary"],
    queryFn: () => summary({}),
    refetchInterval: 5000,
  });
  const totals = query.data?.totals;
  const open = totals ? totals.draft + totals.todo + totals.in_progress + totals.verifying : 0;
  return (
    <SidebarRow
      icon="KanbanSquare"
      label="Vibe Board"
      active={currentScreen?.screenId === "board"}
      onPress={() => openScreen({ screenId: "board" })}
      trailing={
        open > 0 ? (
          <View
            style={{ paddingHorizontal: 6, paddingVertical: 1, borderRadius: 999, backgroundColor: theme.colors.surface2 }}
          >
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" }}>{open}</Text>
          </View>
        ) : undefined
      }
    />
  );
}

/** Sidebar row of the session overview; the badge counts sessions waiting for your answer. */
export function SessionsSidebarItem({ theme, currentScreen, openScreen }: PluginSidebarItemProps) {
  const waiting = waitingCount(useSessionsData().sessions);
  return (
    <SidebarRow
      icon="MessageSquare"
      label="会话汇总"
      active={currentScreen?.screenId === "sessions"}
      onPress={() => openScreen({ screenId: "sessions" })}
      trailing={
        waiting > 0 ? (
          <View style={{ paddingHorizontal: 6, paddingVertical: 1, borderRadius: 999, backgroundColor: theme.colors.statusDanger }}>
            <Text style={{ color: theme.colors.accentForeground, fontSize: 11, fontWeight: "600" }}>{waiting}</Text>
          </View>
        ) : undefined
      }
    />
  );
}

export function BoardSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(boardSettings);
  if (settings.status === "loading") {
    return <Text style={{ color: theme.colors.foregroundMuted, padding: 16 }}>加载设置…</Text>;
  }
  if (settings.status !== "ready") {
    return (
      <Text style={{ color: theme.colors.statusDanger, padding: 16 }}>无法加载设置：{settings.error}</Text>
    );
  }
  const { values, revision } = settings;
  return (
    <SettingsSection title="Agent 集成">
      <SettingsCard>
        <SettingsSwitch
          label="向 agent 注入 vibe-board CLI 与 MCP"
          hint="新建 agent 时自动加入 vibe-board 命令和 MCP 服务器（agent 不能移动卡片列）。"
          value={values.autoInjectCliAndMcp}
          onValueChange={(next) => void settings.save({ ...values, autoInjectCliAndMcp: next }, revision)}
        />
        <SettingsSwitch
          label="注入看板汇报指引"
          hint="在系统提示词里追加如何评论、附件、引用卡片的简短说明。"
          value={values.autoInjectInstructions}
          onValueChange={(next) => void settings.save({ ...values, autoInjectInstructions: next }, revision)}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
