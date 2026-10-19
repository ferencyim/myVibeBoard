import type { PluginTheme } from "@getpaseo/plugin";
import {
  useRpc,
  useSettings,
  type PluginScreenProps,
  type PluginSidebarItemProps,
  type PluginSurfaceProps,
} from "@getpaseo/plugin/client";
import { SettingsCard, SettingsInput, SettingsSection, SidebarRow } from "@getpaseo/plugin/client/ui";
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
  today: "Today",
  "7d": "7 days",
  "30d": "30 days",
  all: "All",
};

type Dimension = "byProvider" | "byModel" | "byProject" | "byDay";
const DIMENSIONS: ReadonlyArray<readonly [Dimension, string]> = [
  ["byProvider", "Agent"],
  ["byModel", "Model"],
  ["byProject", "Project"],
  ["byDay", "Day"],
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
  if (groups.length === 0) return <Muted theme={theme}>No data in this period.</Muted>;
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
          <Text style={chipText(false)}>Refresh</Text>
        </Pressable>
      </View>

      {overview.error ? (
        <Text style={{ color: theme.colors.statusDanger }}>
          Could not load stats: {String(overview.error)}
        </Text>
      ) : null}
      {!o ? <Muted theme={theme}>Loading...</Muted> : null}

      {o ? (
        <>
          <Section theme={theme} title="Usage">
            <Row
              theme={theme}
              left="Estimated cost"
              right={fmtCostNote(o.totals.cost, o.totals.unpricedTokens)}
            />
            {o.totals.unpricedTokens > 0 ? (
              <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
                {fmtTokens(o.totals.unpricedTokens)} tokens are not priced (
                {o.byModel
                  .filter((g) => g.unpricedTokens > 0)
                  .map((g) => g.label)
                  .join(", ")}
                ). Provide a LiteLLM-format price file in the Stats settings to include them.
              </Text>
            ) : null}
            <Row theme={theme} left="Input" right={fmtTokens(o.totals.input)} />
            <Row theme={theme} left="Output" right={fmtTokens(o.totals.output)} />
            <Row
              theme={theme}
              left="Cache read / write"
              right={`${fmtTokens(o.totals.cacheRead)} / ${fmtTokens(o.totals.cacheWrite)}`}
            />
            <Muted theme={theme}>
              {o.index.lastScanAt
                ? `${o.index.files} log files, scanned ${o.index.lastScanAt.slice(11, 19)} UTC`
                : "Indexing logs..."}
            </Muted>
          </Section>

          <Section theme={theme} title="Token distribution">
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {DIMENSIONS.map(([key, label]) => (
                <Pressable key={key} onPress={() => setDimension(key)} style={chip(dimension === key)}>
                  <Text style={chipText(dimension === key)}>{label}</Text>
                </Pressable>
              ))}
            </View>
            <GroupList theme={theme} groups={o[dimension]} />
            <Muted theme={theme}>Bars: input, output, cache read, cache write.</Muted>
          </Section>

          <Section theme={theme} title="Output speed">
            <Row theme={theme} left="Median" right={fmtRate(o.speed.overall.median)} />
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

          <Section theme={theme} title="Quota windows">
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
                                w.runsOutAt ? ` · out ${w.runsOutAt.slice(5, 16).replace("T", " ")}` : ""
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
              <Muted theme={theme}>No provider reports quota.</Muted>
            ) : null}
          </Section>

          <Section theme={theme} title="Task efficiency">
            <Muted theme={theme}>
              {o.compactions.count} compactions, average context {fmtTokens(o.compactions.avgBefore)}{" "}
              to {fmtTokens(o.compactions.avgAfter)}
            </Muted>
            {o.tasks.length === 0 ? (
              <Muted theme={theme}>No usage linked to cards yet.</Muted>
            ) : null}
            {o.tasks.map((t) => (
              <View key={t.cardId} style={{ gap: 2 }}>
                <Row
                  theme={theme}
                  left={`${t.key} ${t.title}`}
                  right={`${fmtTokens(t.tokens)} · ${fmtCostNote(t.cost, t.unpricedTokens)}`}
                />
                <Muted theme={theme}>
                  active {fmtDuration(t.durationMs)} · waiting for you {fmtDuration(t.waitingMs)}
                  {t.compactions.length
                    ? ` · compacted ${t.compactions
                        .map((c) => `${fmtTokens(c.before)}>${fmtTokens(c.after)}`)
                        .join(", ")}`
                    : ""}
                </Muted>
              </View>
            ))}
          </Section>

          <Section theme={theme} title="Resources">
            <Row theme={theme} left="Running sessions" right={String(o.resources.runningSessions)} />
            <Row theme={theme} left="Waiting for you" right={String(o.resources.waitingSessions)} />
            {o.resources.latest ? (
              <>
                <Row theme={theme} left="CPU" right={fmtPct(o.resources.latest.cpu)} />
                <Row theme={theme} left="Memory" right={fmtPct(o.resources.latest.mem)} />
                <Row
                  theme={theme}
                  left="Device pool"
                  right={`${o.resources.latest.devicesBusy} / ${o.resources.latest.devicesTotal} busy`}
                />
              </>
            ) : (
              <Muted theme={theme}>No resource samples yet (the scheduler writes them).</Muted>
            )}
          </Section>
        </>
      ) : null}
    </ScrollView>
  );
}

export function StatsSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="ChartBar"
      label="Stats"
      active={currentScreen?.screenId === "main"}
      onPress={() => openScreen({ screenId: "main" })}
    />
  );
}

const split = (text: string) =>
  text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export function StatsSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(statsSettings);
  if (settings.status !== "ready") {
    return (
      <View style={{ padding: 16 }}>
        <Text style={{ color: theme.colors.foregroundMuted }}>
          {settings.status === "loading"
            ? "Loading..."
            : `Could not load settings: ${settings.error}`}
        </Text>
      </View>
    );
  }
  const { values, revision } = settings;
  const save = (next: typeof values) => void settings.save(next, revision);
  return (
    <SettingsSection title="Usage log locations (comma separated; empty = default)">
      <SettingsCard>
        {(["claude", "codex", "kimi", "deepseek"] as const).map((p) => (
          <SettingsInput
            key={p}
            label={p}
            hint={
              p === "kimi" || p === "deepseek"
                ? "Default path is unverified on this machine."
                : undefined
            }
            initialValue={values.logDirs[p].join(", ")}
            onChangeText={(text) => save({ ...values, logDirs: { ...values.logDirs, [p]: split(text) } })}
          />
        ))}
        <SettingsInput
          label="Price file (LiteLLM JSON)"
          initialValue={values.pricingFile}
          onChangeText={(text) => save({ ...values, pricingFile: text.trim() })}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
