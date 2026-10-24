import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { SettingsSection } from "@getpaseo/plugin/client/ui";
import React from "react";
import { ScrollView, Text, View } from "react-native";
import { verifySettings, SEVERITY_JUDGEMENTS } from "../shared/settings";
import { BehaviourLink, FieldsCard, Group, type Field } from "./settings-kit";

const JUDGEMENT_OPTIONS = SEVERITY_JUDGEMENTS.map((value) => ({
  value,
  label: { pass: "通过（忽略）", doubt: "存疑", fail: "失败（可自动退回）" }[value],
}));

export const BASIC_FIELDS: readonly Field[] = [
  {
    kind: "bool",
    key: "autoReturnOnFail",
    label: "验证未通过 / 复核发现严重问题时，自动退回任务修复并重新申请执行资源",
  },
  {
    kind: "int",
    key: "maxReviewReturns",
    label: "本轮复核 / 验证失败共用自动退回上限（0-20；0 为暂停等待用户，留空默认 3）",
    min: 0,
    max: 20,
    blank: "null",
  },
  {
    kind: "bool",
    key: "preferDifferentProvider",
    label: "验证 agent 优先选用与执行者不同的 provider（关闭则优先同一 provider）",
  },
];

export const SEVERITY_FIELDS: readonly Field[] = [
  { kind: "select", key: "severitySevere", label: "复核“严重”问题 →", options: JUDGEMENT_OPTIONS },
  { kind: "select", key: "severityMajor", label: "复核“一般”问题 →", options: JUDGEMENT_OPTIONS },
  { kind: "select", key: "severityMinor", label: "复核“轻微”问题 →", options: JUDGEMENT_OPTIONS },
];

export const ADVANCED_FIELDS: readonly Field[] = [
  {
    kind: "number",
    key: "roundTimeoutMinutes",
    label: "验证 / 复核单回合超时（分钟，1-240）",
    min: 1,
    max: 240,
  },
  {
    kind: "int",
    key: "excerptChars",
    label: "判定提示里内联的日志 / 报告摘录长度（字符，500-200000）",
    min: 500,
    max: 200_000,
  },
  {
    kind: "number",
    key: "readyTimeoutSeconds",
    label: "等待开发服务器就绪的默认时间（秒，5-3600；verify.json 里写了则以它为准）",
    min: 5,
    max: 3600,
  },
  {
    kind: "text",
    key: "worktreeRoot",
    label: "基线工作树目录（留空沿用环境变量 VIBE_WORKTREE_ROOT 或平台默认目录）",
  },
];

export function VerifySettingsScreen({ theme, navigation }: PluginSurfaceProps) {
  const settings = useSettings(verifySettings);
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
      <SettingsSection title="验证与复核">
        <Group theme={theme} title="基础" initiallyOpen>
          <FieldsCard fields={BASIC_FIELDS} values={values} save={save} />
        </Group>
        <Group theme={theme} title="复核严重度 → 验证结论">
          <FieldsCard fields={SEVERITY_FIELDS} values={values} save={save} />
        </Group>
        <Group theme={theme} title="提示词">
          <BehaviourLink
            theme={theme}
            navigation={navigation}
            text="验证 agent / 复核 agent 的系统提示、两轮验证提示、复核提示和退回执行 agent 的提示都在「Agent 行为」页编辑，可按项目覆盖。回复格式部分固定，不可编辑。"
          />
        </Group>
        <Group theme={theme} title="高级">
          <FieldsCard fields={ADVANCED_FIELDS} values={values} save={save} />
        </Group>
      </SettingsSection>
    </ScrollView>
  );
}
