import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc, useSettings, type PluginScreenProps } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsInput, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  overviewRpc,
  PERIODS,
  quotaRpc,
  reindexRpc,
  statsSettings,
  type Period,
  type StatsGroup,
} from "../shared/rpc";
import { fmtCostNote, fmtDuration, fmtPct, fmtRate, fmtTokens, shares } from "./format";

const PERIOD_LABELS: Record<Period, string> = {
  today: "今天",
  "7d": "7 天",
  "30d": "30 天",
  all: "全部",
};

type Dimension = "byProvider" | "byModel" | "byProject" | "byWorkspace" | "byRole" | "byDay";
const DIMENSIONS: ReadonlyArray<readonly [Dimension, string]> = [
  ["byProvider", "提供方"],
  ["byModel", "模型"],
  ["byProject", "项目"],
  ["byWorkspace", "工作区"],
  ["byRole", "角色"],
  ["byDay", "日期"],
];

function Section({
  theme,
  title,
  children,
}: {
  theme: PluginTheme;
  title: string;
  children: ReactNode;
}) {
  return (
    <View
      style={{
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 10,
        padding: 12,
        gap: 8,
      }}
    >
      <Text style={{ color: theme.colors.foreground, fontWeight: "600", fontSize: 15 }}>
        {title}
      </Text>
      {children}
    </View>
  );
}

function Muted({ theme, children }: { theme: PluginTheme; children: ReactNode }) {
  return <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{children}</Text>;
}

function Row({ theme, left, right }: { theme: PluginTheme; left: string; right: string }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
      <Text style={{ color: theme.colors.foreground, flexShrink: 1 }} numberOfLines={1}>
        {left}
      </Text>
      <Text style={{ color: theme.colors.foregroundMuted }}>{right}</Text>
    </View>
  );
}

/** Proportional bar: one segment per value, drawn with plain Views (no SVG on Android). */
function Bar({ theme, parts, colors }: { theme: PluginTheme; parts: number[]; colors: string[] }) {
  const widths = shares(parts);
  return (
    <View
      style={{
        flexDirection: "row",
        height: 10,
        borderRadius: 5,
        overflow: "hidden",
        backgroundColor: theme.colors.surface2,
      }}
    >
      {widths.map((w, i) => (
        <View
          key={i}
          style={{ width: `${w * 100}%`, backgroundColor: colors[i % colors.length] }}
        />
      ))}
    </View>
  );
}

function GroupList({ theme, groups }: { theme: PluginTheme; groups: StatsGroup[] }) {
  if (groups.length === 0) return <Muted theme={theme}>该时段暂无数据。</Muted>;
  const weight = (g: StatsGroup) => g.input + g.output + g.cacheRead + g.cacheWrite;
  const max = Math.max(...groups.map(weight), 1);
  const colors = [
    theme.colors.accent,
    theme.colors.statusSuccess,
    theme.colors.statusWarning,
    theme.colors.statusDanger,
  ];
  return (
    <View style={{ gap: 8 }}>
      {groups.slice(0, 8).map((g) => (
        <View key={g.key} style={{ gap: 3 }}>
          <Row
            theme={theme}
            left={g.label}
            right={`${fmtTokens(weight(g))} · ${fmtCostNote(g.cost, g.unpricedTokens)}`}
          />
          <View style={{ width: `${(weight(g) / max) * 100}%` }}>
            <Bar
              theme={theme}
              parts={[g.input, g.output, g.cacheRead, g.cacheWrite]}
              colors={colors}
            />
          </View>
        </View>
      ))}
    </View>
  );
}

export function StatsScreen({ theme }: PluginScreenProps) {
  const queryClient = useQueryClient();
  const overviewCall = useRpc(overviewRpc);
  const quotaCall = useRpc(quotaRpc);
  const reindexCall = useRpc(reindexRpc);
  const [period, setPeriod] = useState<Period>("30d");
  const [dimension, setDimension] = useState<Dimension>("byProvider");

  const overview = useQuery({
    queryKey: ["vibe-stats", "overview", period],
    queryFn: () => overviewCall({ period }),
    refetchInterval: 10_000,
  });
  const quota = useQuery({
    queryKey: ["vibe-stats", "quota"],
    queryFn: () => quotaCall({}),
    refetchInterval: 60_000,
  });

  const o = overview.data;
  const chip = (active: boolean) => ({
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: active ? theme.colors.accent : theme.colors.surface2,
  });
  const chipText = (active: boolean) => ({
    color: active ? theme.colors.accentForeground : theme.colors.foreground,
    fontSize: 12,
  });
  const refresh = () =>
    void reindexCall({ full: (o?.totals.unpricedTokens ?? 0) > 0 }).then(() =>
      queryClient.invalidateQueries({ queryKey: ["vibe-stats"] }),
    );

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding: 16, gap: 12 }}
    >
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        {PERIODS.map((p) => (
          <Pressable key={p} onPress={() => setPeriod(p)} style={chip(p === period)}>
            <Text style={chipText(p === period)}>{PERIOD_LABELS[p]}</Text>
          </Pressable>
        ))}
        <Pressable onPress={refresh} style={chip(false)}>
          <Text style={chipText(false)}>刷新</Text>
        </Pressable>
      </View>

      {overview.error ? (
        <Text style={{ color: theme.colors.statusDanger }}>
          统计读取失败： {String(overview.error)}
        </Text>
      ) : null}
      {!o ? <Muted theme={theme}>加载中……</Muted> : null}

      {o ? (
        <>
          <Section theme={theme} title="用量">
            <Row
              theme={theme}
              left="估算费用"
              right={fmtCostNote(o.totals.cost, o.totals.unpricedTokens)}
            />
            {o.totals.unpricedTokens > 0 ? (
              <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
                {fmtTokens(o.totals.unpricedTokens)} 个 token 尚无价格（
                {o.byModel
                  .filter((g) => g.unpricedTokens > 0)
                  .map((g) => g.label)
                  .join(", ")}
                ）。可在本页设置 LiteLLM 价格文件。
              </Text>
            ) : null}
            <Row theme={theme} left="输入" right={fmtTokens(o.totals.input)} />
            <Row theme={theme} left="输出" right={fmtTokens(o.totals.output)} />
            <Row
              theme={theme}
              left="缓存读取 / 写入"
              right={`${fmtTokens(o.totals.cacheRead)} / ${fmtTokens(o.totals.cacheWrite)}`}
            />
            <Muted theme={theme}>
              {o.index.lastScanAt
                ? `${o.index.files} 个日志文件，上次扫描 ${o.index.lastScanAt.slice(11, 19)} UTC`
                : "正在索引用量日志……"}
            </Muted>
          </Section>

          <Section theme={theme} title="Token 分布">
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {DIMENSIONS.map(([key, label]) => (
                <Pressable
                  key={key}
                  onPress={() => setDimension(key)}
                  style={chip(dimension === key)}
                >
                  <Text style={chipText(dimension === key)}>{label}</Text>
                </Pressable>
              ))}
            </View>
            <GroupList theme={theme} groups={o[dimension]} />
            <Muted theme={theme}>色条：输入、输出、缓存读取、缓存写入。</Muted>
          </Section>

          <Section theme={theme} title="输出速度">
            <Row theme={theme} left="中位数" right={fmtRate(o.speed.overall.median)} />
            <Row theme={theme} left="P90" right={fmtRate(o.speed.overall.p90)} />
            {o.speed.byProvider.map((s) => (
              <Row
                key={s.provider}
                theme={theme}
                left={s.provider}
                right={`${fmtRate(s.median)} / ${fmtRate(s.p90)} (${s.samples})`}
              />
            ))}
          </Section>

          <Section theme={theme} title="额度窗口">
            {quota.data?.error ? <Muted theme={theme}>{quota.data.error}</Muted> : null}
            {quota.data?.providers.map((p) => (
              <View key={p.providerId} style={{ gap: 4 }}>
                <Text style={{ color: theme.colors.foreground }}>
                  {p.displayName}
                  {p.planLabel ? ` · ${p.planLabel}` : ""}
                </Text>
                {p.status !== "available" ? <Muted theme={theme}>{p.status}</Muted> : null}
                {p.windows.map((w) => {
                  const used = Math.min(100, w.usedPct ?? 0);
                  return (
                    <View key={w.id} style={{ gap: 2 }}>
                      <Row
                        theme={theme}
                        left={w.label}
                        right={
                          w.usedPct === null
                            ? "-"
                            : `${Math.round(w.usedPct)}%${
                                w.runsOutAt
                                  ? ` · 预计耗尽 ${w.runsOutAt.slice(5, 16).replace("T", " ")}`
                                  : ""
                              }`
                        }
                      />
                      <Bar
                        theme={theme}
                        parts={[used, 100 - used]}
                        colors={[
                          used >= 90 ? theme.colors.statusDanger : theme.colors.accent,
                          theme.colors.surface2,
                        ]}
                      />
                    </View>
                  );
                })}
              </View>
            ))}
            {quota.data && quota.data.providers.length === 0 && !quota.data.error ? (
              <Muted theme={theme}>暂无提供方额度数据。</Muted>
            ) : null}
          </Section>

          <Section theme={theme} title="任务用量">
            <Muted theme={theme}>
              {o.compactions.count} 次压缩，平均上下文 {fmtTokens(o.compactions.avgBefore)} 降至{" "}
              {fmtTokens(o.compactions.avgAfter)}
            </Muted>
            {o.tasks.length === 0 ? <Muted theme={theme}>暂无关联工作区的用量。</Muted> : null}
            {o.tasks.map((t) => (
              <View key={t.workspaceId} style={{ gap: 2 }}>
                <Row
                  theme={theme}
                  left={t.workspaceId}
                  right={`${fmtTokens(t.tokens)} · ${fmtCostNote(t.cost, t.unpricedTokens)}`}
                />
                <Muted theme={theme}>
                  会话时长 {fmtDuration(t.durationMs)} · 等待回复 {fmtDuration(t.waitingMs)}
                  {t.compactions.length
                    ? ` · 压缩 ${t.compactions
                        .map((c) => `${fmtTokens(c.before)}>${fmtTokens(c.after)}`)
                        .join(", ")}`
                    : ""}
                </Muted>
              </View>
            ))}
          </Section>

          <Section theme={theme} title="资源">
            <Row theme={theme} left="运行中会话" right={String(o.resources.runningSessions)} />
            <Row theme={theme} left="等待回复" right={String(o.resources.waitingSessions)} />
            {o.resources.latest ? (
              <>
                <Row theme={theme} left="CPU" right={fmtPct(o.resources.latest.cpu)} />
                <Row theme={theme} left="内存" right={fmtPct(o.resources.latest.mem)} />
                <Row
                  theme={theme}
                  left="设备池"
                  right={`${o.resources.latest.devicesBusy} / ${o.resources.latest.devicesTotal} 占用`}
                />
              </>
            ) : (
              <Muted theme={theme}>暂无调度资源采样。</Muted>
            )}
          </Section>
        </>
      ) : null}
      <StatsSettingsScreen theme={theme} />
    </ScrollView>
  );
}

const split = (text: string) =>
  text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

function StatsSettingsScreen({ theme }: { theme: PluginTheme }) {
  const settings = useSettings(statsSettings);
  if (settings.status !== "ready") {
    return (
      <View style={{ padding: 16 }}>
        <Text style={{ color: theme.colors.foregroundMuted }}>
          {settings.status === "loading" ? "加载中……" : `设置读取失败： ${settings.error}`}
        </Text>
      </View>
    );
  }
  const { values, revision } = settings;
  const save = (next: typeof values) => void settings.save(next, revision);
  return (
    <SettingsSection title="用量日志目录（逗号分隔；空白使用默认）">
      <SettingsCard>
        {(["claude", "codex", "kimi", "deepseek"] as const).map((p) => (
          <SettingsInput
            key={p}
            label={p}
            hint={p === "kimi" || p === "deepseek" ? "默认路径尚未在本机验证。" : undefined}
            initialValue={values.logDirs[p].join(", ")}
            onChangeText={(text) =>
              save({ ...values, logDirs: { ...values.logDirs, [p]: split(text) } })
            }
          />
        ))}
        <SettingsInput
          label="价格文件（LiteLLM JSON）"
          initialValue={values.pricingFile}
          onChangeText={(text) => save({ ...values, pricingFile: text.trim() })}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
