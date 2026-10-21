import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { SettingsSection } from "@getpaseo/plugin/client/ui";
import React from "react";
import { ScrollView, Text, View } from "react-native";
import { DEFAULT_TTL_SECONDS } from "../shared/settings/defaults";
import { compactionSettings } from "../shared/settings/compaction";
import { complexitySettings } from "../shared/settings/complexity";
import { contextSettings } from "../shared/settings/context";
import { BehaviourLink, FieldsCard, Group, Muted, type Field } from "./settings-kit";

export const COMPACTION_FIELDS: readonly Field[] = [
  { kind: "bool", key: "enabled", label: "到期前自动压缩 / 交接空闲会话" },
  { kind: "number", key: "checkIntervalSeconds", label: "检查空闲会话的间隔（秒，5-3600）", min: 5, max: 3600 },
  { kind: "map", key: "ttlSeconds", valueType: "number", label: "各 provider 的提示缓存 TTL（秒），如 claude=3600, codex=300" },
  {
    kind: "number",
    key: "marginSeconds",
    label: "到期前多少秒开始压缩（1-1800；留空按下面的规则推算）",
    min: 1,
    max: 1800,
    blank: "unset",
  },
  { kind: "list", key: "compactProviders", label: "支持压缩命令的 provider（其余的改为交接给新 agent），如 claude, codex" },
  { kind: "map", key: "compactCommands", valueType: "string", label: "各 provider 的压缩命令，缺省为 /compact，如 claude=/compact" },
];

export const COMPACTION_ADVANCED_FIELDS: readonly Field[] = [
  { kind: "int", key: "fallbackTtlSeconds", label: "未列出的 provider 的缓存 TTL（秒，1-86400）", min: 1, max: 86_400 },
  { kind: "number", key: "marginLongFromSeconds", label: "边距规则：TTL 不短于多少秒算“长”（1-86400）", min: 1, max: 86_400 },
  { kind: "number", key: "marginLongSeconds", label: "边距规则：长 TTL 提前多少秒（1-1800；不超过 TTL 的一半）", min: 1, max: 1800 },
  { kind: "number", key: "marginShortSeconds", label: "边距规则：短 TTL 提前多少秒（1-1800；不超过 TTL 的一半）", min: 1, max: 1800 },
  { kind: "number", key: "approvalWaitMinutes", label: "压缩回合等待你批准某项操作的最长时间（分钟，1-240）", min: 1, max: 240 },
];

export const COMPLEXITY_FIELDS: readonly Field[] = [
  { kind: "bool", key: "enabled", label: "按会话复杂度分级处理（短 / 多轮 / 长）" },
  { kind: "bool", key: "earlyCompactLong", label: "长会话在下一个空闲时刻就压缩，不等缓存快过期" },
  { kind: "int", key: "handoffAfterCompactions", label: "长会话压缩多少次后改为交接给新 agent（1-20）", min: 1, max: 20 },
  { kind: "int", key: "tightMemoryTokens", label: "多轮 / 长会话重新注入时内联的记忆 token 数（0-200000）", min: 0, max: 200_000 },
];

export const COMPLEXITY_ADVANCED_FIELDS: readonly Field[] = [
  { kind: "int", key: "shortMaxTurns", label: "分级阈值：不超过多少轮算“短”", min: 1, max: 1000 },
  { kind: "int", key: "longMinTurns", label: "分级阈值：至少多少轮才可能算“长”", min: 1, max: 100_000 },
  { kind: "number", key: "longCacheRead", label: "分级阈值：累计缓存读取 token 达到多少算“长”", min: 1, max: 1e12 },
  { kind: "number", key: "heavyTurnContext", label: "分级阈值：单轮上下文 token 达到多少算“重”", min: 1, max: 1e9 },
  { kind: "number", key: "heavyTurnShare", label: "分级阈值：重轮占比达到多少算“长”（0-1）", min: 0, max: 1 },
];

export const CONTEXT_FIELDS: readonly Field[] = [
  { kind: "int", key: "defaultMemoryTokens", label: "新 agent 注入的项目记忆内联上限（token，0-200000；放不下的改为文件指针）", min: 0, max: 200_000 },
];

function Loading({ theme, status, error }: { theme: PluginSurfaceProps["theme"]; status: string; error?: string }) {
  return (
    <View style={{ padding: 16 }}>
      <Text style={{ color: theme.colors.foregroundMuted }}>
        {status === "loading" ? "加载中..." : `无法加载设置：${error}`}
      </Text>
    </View>
  );
}

export function ContextSettingsScreen({ theme, navigation }: PluginSurfaceProps) {
  const compaction = useSettings(compactionSettings);
  const complexity = useSettings(complexitySettings);
  const context = useSettings(contextSettings);
  if (compaction.status !== "ready") return <Loading theme={theme} status={compaction.status} error={"error" in compaction ? compaction.error : undefined} />;
  if (complexity.status !== "ready") return <Loading theme={theme} status={complexity.status} error={"error" in complexity ? complexity.error : undefined} />;
  if (context.status !== "ready") return <Loading theme={theme} status={context.status} error={"error" in context ? context.error : undefined} />;

  // Show the TTLs in effect (built-in defaults merged); saving writes the full record.
  const compactionValues = { ...compaction.values, ttlSeconds: { ...DEFAULT_TTL_SECONDS, ...compaction.values.ttlSeconds } };
  const saveCompaction = (next: typeof compactionValues) => void compaction.save(next, compaction.revision);
  const saveComplexity = (next: typeof complexity.values) => void complexity.save(next, complexity.revision);
  const saveContext = (next: typeof context.values) => void context.save(next, context.revision);

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <SettingsSection title="上下文与压缩">
        <Group theme={theme} title="压缩与交接" initiallyOpen>
          <FieldsCard fields={COMPACTION_FIELDS} values={compactionValues} save={saveCompaction} />
        </Group>
        <Group theme={theme} title="会话复杂度">
          <FieldsCard fields={COMPLEXITY_FIELDS} values={complexity.values} save={saveComplexity} />
        </Group>
        <Group theme={theme} title="注入上下文">
          <FieldsCard fields={CONTEXT_FIELDS} values={context.values} save={saveContext} />
        </Group>
        <Group theme={theme} title="提示词">
          <BehaviourLink
            theme={theme}
            navigation={navigation}
            text="压缩前的笔记提示、压缩后的恢复提示、冷启动交接提示，以及注入上下文块的说明文字和探路兵建议都在「Agent 行为」页编辑，可按项目覆盖。"
          />
        </Group>
        <Group theme={theme} title="高级">
          <Muted theme={theme}>缓存 TTL 与压缩边距规则、复杂度分级阈值。默认值即原先写死的值，一般不需要改。</Muted>
          <FieldsCard fields={COMPACTION_ADVANCED_FIELDS} values={compactionValues} save={saveCompaction} />
          <FieldsCard fields={COMPLEXITY_ADVANCED_FIELDS} values={complexity.values} save={saveComplexity} />
        </Group>
      </SettingsSection>
    </ScrollView>
  );
}
