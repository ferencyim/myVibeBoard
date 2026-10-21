import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { SettingsSection } from "@getpaseo/plugin/client/ui";
import React from "react";
import { ScrollView, Text, View } from "react-native";
import {
  DEFAULT_SUMMARY_ACK,
  DEFAULT_SUMMARY_HEADER,
  DEFAULT_TRANSCRIPT_PROMPT,
  switchSettings,
} from "../shared/settings";
import { FieldsCard, Group, Muted, type Field } from "./settings-kit";

export const COMPACTION_FIELDS: readonly Field[] = [
  { kind: "int", key: "keepTurns", label: "压缩时原样保留最近多少轮（1-100）", min: 1, max: 100 },
  { kind: "int", key: "targetPercent", label: "压缩后最多占新模型上下文窗口的百分比（10-95）", min: 10, max: 95 },
];

export const ADVANCED_FIELDS: readonly Field[] = [
  { kind: "int", key: "defaultWindowTokens", label: "daemon 没报告上下文窗口时按多少 token 计（1000-10000000）", min: 1000, max: 10_000_000 },
  { kind: "int", key: "transcriptBlockCap", label: "压缩用的完整记录里，单个工具调用 / 结果最多保留的字符数", min: 500, max: 1_000_000 },
  { kind: "int", key: "listCap", label: "摘要里文件、提交、未完成任务清单的最大条数（5-500）", min: 5, max: 500 },
  { kind: "int", key: "transcriptPage", label: "导出记录时每次读取的时间线条数（50-5000）", min: 50, max: 5000 },
  { kind: "int", key: "transcriptMaxBlock", label: "导出记录里单个块最多保留的字符数", min: 500, max: 1_000_000 },
];

export const TEXT_FIELDS: readonly Field[] = [
  {
    kind: "textarea",
    key: "summaryHeader",
    label: "历史压缩摘要的开头说明。占位符：{{title}}（首行会成为新 agent 的标题，请保留在第一行）、{{transcriptPath}}。",
    defaultText: DEFAULT_SUMMARY_HEADER,
  },
  {
    kind: "textarea",
    key: "summaryAck",
    label: "摘要之后预置的助手回复（“Understood...”）",
    defaultText: DEFAULT_SUMMARY_ACK,
  },
  {
    kind: "textarea",
    key: "transcriptPrompt",
    label: "不能转换会话、改读完整记录时交给新 agent 的第一条消息。占位符：{{agentId}}、{{title}}、{{provider}}、{{path}}。",
    defaultText: DEFAULT_TRANSCRIPT_PROMPT,
  },
];

export function SwitchSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(switchSettings);
  if (settings.status !== "ready") {
    return (
      <View style={{ padding: 16 }}>
        <Text style={{ color: theme.colors.foregroundMuted }}>
          {settings.status === "loading" ? "加载中..." : `无法加载设置：${settings.error}`}
        </Text>
      </View>
    );
  }
  const { values, revision } = settings;
  const save = (next: typeof values) => void settings.save(next, revision);
  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <SettingsSection title="切换 provider">
        <Group theme={theme} title="历史压缩" initiallyOpen>
          <FieldsCard fields={COMPACTION_FIELDS} values={values} save={save} />
        </Group>
        <Group theme={theme} title="提示词">
          <Muted theme={theme}>
            此插件独立于 myVibeBoard 的数据库（可单独安装），所以这些文字放在这里编辑，而不在「Agent 行为」页。清空某项等于恢复默认。
          </Muted>
          <FieldsCard theme={theme} fields={TEXT_FIELDS} values={values} save={save} />
        </Group>
        <Group theme={theme} title="高级">
          <FieldsCard fields={ADVANCED_FIELDS} values={values} save={save} />
        </Group>
      </SettingsSection>
    </ScrollView>
  );
}
