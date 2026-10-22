import { useRpc, useSettings, type PluginSidebarItemProps, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsInput, SettingsSection, SettingsSelect, SettingsSwitch, SidebarRow } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import React from "react";
import { Pressable, Text, View } from "react-native";
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

/** Sidebar row of the Agent behaviour page (prompts and automation of all agents). */
export function BehaviourSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Bot"
      label="Agent 行为"
      active={currentScreen?.screenId === "behaviour"}
      onPress={() => openScreen({ screenId: "behaviour" })}
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
    <>
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
      <SettingsSection title="卡死检测与失败改派">
        <SettingsCard>
          <SettingsSwitch
            label="检测卡死的 agent"
            hint="运行中的会话长时间没有输出时，卡片标记「可能卡住」并推送提醒（等待审批不算）。"
            value={values.stallDetection}
            onValueChange={(next) => void settings.save({ ...values, stallDetection: next }, revision)}
          />
          <SettingsSelect
            label="无输出多久算卡住"
            hint="可在设置文件里用 stallProviderMinutes（如 claude=15,codex=8）按 provider 覆盖。"
            value={String(values.stallMinutes)}
            options={STALL_MINUTE_OPTIONS}
            onValueChange={(next) => void settings.save({ ...values, stallMinutes: Number(next) }, revision)}
          />
          <SettingsSelect
            label="卡住后自动中断并续跑"
            hint="卡住超过该时间后中断 agent，并发送一次「继续」指令；只做一次。"
            value={String(values.stallAutoInterruptMinutes)}
            options={AUTO_INTERRUPT_OPTIONS}
            onValueChange={(next) =>
              void settings.save({ ...values, stallAutoInterruptMinutes: Number(next) }, revision)
            }
          />
          <SettingsSwitch
            label="额度耗尽 / 登录失效时自动改派"
            hint="执行 agent 失败时，按预设的「失败时改派到」顺序换一个 agent 在同一 worktree 继续。"
            value={values.failoverEnabled}
            onValueChange={(next) => void settings.save({ ...values, failoverEnabled: next }, revision)}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="高级">
        <Group theme={theme} title="自动化参数">
        <SettingsCard>
          <SettingsInput
            label="派发说明里带的最近备注数（1-50）"
            initialValue={String(values.briefRecentEvents)}
            onChangeText={(text) => void settings.save({ ...values, briefRecentEvents: clampInt(text, 1, 50, values.briefRecentEvents) }, revision)}
          />
          <SettingsInput
            label="派发说明里带的执行对话最近条数（0-50）"
            initialValue={String(values.briefChatLimit)}
            onChangeText={(text) => void settings.save({ ...values, briefChatLimit: clampInt(text, 0, 50, values.briefChatLimit) }, revision)}
          />
          <SettingsInput
            label="卡死检测轮询间隔（秒，5-600；重启后生效）"
            initialValue={String(values.watchdogPollSeconds)}
            onChangeText={(text) => void settings.save({ ...values, watchdogPollSeconds: clampInt(text, 5, 600, values.watchdogPollSeconds) }, revision)}
          />
        </SettingsCard>
        </Group>
      </SettingsSection>
    </>
  );
}

/** A settings group that folds away; same look as the Group of the other vibe plugins' settings pages. */
function Group({
  theme,
  title,
  children,
}: {
  theme: PluginSurfaceProps["theme"];
  title: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <View style={{ gap: 8 }}>
      <Pressable onPress={() => setOpen(!open)} style={{ paddingVertical: 8 }}>
        <Text style={{ color: theme.colors.foreground, fontWeight: "600", fontSize: 15 }}>
          {open ? "▾ " : "▸ "}
          {title}
        </Text>
      </Pressable>
      {open ? children : null}
    </View>
  );
}

function clampInt(text: string, min: number, max: number, fallback: number): number {
  const n = Number(text);
  return Number.isFinite(n) ? Math.round(Math.min(max, Math.max(min, n))) : fallback;
}

const STALL_MINUTE_OPTIONS = ["1", "5", "10", "15", "20", "30", "60"].map((m) => ({ label: `${m} 分钟`, value: m }));
const AUTO_INTERRUPT_OPTIONS = [
  { label: "关闭", value: "0" },
  ...["5", "10", "20", "30"].map((m) => ({ label: `${m} 分钟后`, value: m })),
];
