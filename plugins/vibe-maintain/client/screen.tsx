import type { PluginTheme } from "@getpaseo/plugin";
import {
  useRpc,
  useSettings,
  type PluginScreenProps,
  type PluginSidebarItemProps,
  type PluginSurfaceProps,
} from "@getpaseo/plugin/client";
import {
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSwitch,
  SidebarRow,
} from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { maintainSettings, resumeRpc, runRpc, statusRpc } from "../shared/rpc";
import { BLOCKED_TEXT, fmtTime, parseStatus, type RuleRow } from "./format";

function Section({ theme, title, children }: { theme: PluginTheme; title: string; children: ReactNode }) {
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
      <Text style={{ color: theme.colors.foreground, fontWeight: "600", fontSize: 15 }}>{title}</Text>
      {children}
    </View>
  );
}

const Muted = ({ theme, children }: { theme: PluginTheme; children: ReactNode }) => (
  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{children}</Text>
);

function Button({
  theme,
  label,
  onPress,
  disabled,
}: {
  theme: PluginTheme;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={{
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 999,
        backgroundColor: theme.colors.surface2,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>{label}</Text>
    </Pressable>
  );
}

export function MaintainScreen({ theme }: PluginScreenProps) {
  const queryClient = useQueryClient();
  const statusCall = useRpc(statusRpc);
  const runCall = useRpc(runRpc);
  const resumeCall = useRpc(resumeRpc);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const status = useQuery({
    queryKey: ["vibe-maintain", "status"],
    queryFn: async () => parseStatus(await statusCall({})),
    refetchInterval: 5_000,
  });

  const act = async (id: string, run: () => Promise<string | null>) => {
    setBusy(id);
    setMessage(null);
    try {
      setMessage(await run());
      await queryClient.invalidateQueries({ queryKey: ["vibe-maintain"] });
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const runNow = (rule: RuleRow) =>
    act(`run:${rule.id}`, async () => {
      const r = await runCall({ ruleId: rule.id });
      return r.status === "fired" ? `${rule.name}: run started` : `${rule.name}: not run (${r.why ?? r.status})`;
    });
  const resume = (rule: RuleRow) =>
    act(`resume:${rule.id}`, async () => {
      await resumeCall({ ruleId: rule.id });
      return `${rule.name}: resumed`;
    });

  const s = status.data;
  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: 16, gap: 12 }}>
      {status.error ? (
        <Text style={{ color: theme.colors.statusDanger }}>Could not load maintenance: {String(status.error)}</Text>
      ) : null}
      {!s ? <Muted theme={theme}>Loading...</Muted> : null}
      {message ? <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>{message}</Text> : null}
      {s?.configErrors.map((c) => (
        <Text key={c.project} style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
          maintenance.yml problems: {c.errors.join("; ")}
        </Text>
      ))}
      {s && s.rules.length === 0 ? <Muted theme={theme}>No maintenance rules yet.</Muted> : null}
      {s?.rules.map((rule) => (
        <Section key={rule.id} theme={theme} title={rule.name}>
          <Muted theme={theme}>
            {rule.projectName} · {rule.trigger}
          </Muted>
          <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>
            {rule.output === "fix" ? "Fixes in a worktree" : "Suggests a draft card"}
            {rule.agent ? ` · agent ${rule.agent}` : ""} · priority {rule.priority}
          </Text>
          <Muted theme={theme}>
            Runs today {rule.runsToday} / {rule.dailyCap}
            {Object.entries(rule.counters)
              .map(([k, v]) => ` · ${k} ${v}`)
              .join("")}
          </Muted>
          <Muted theme={theme}>
            Last run:{" "}
            {rule.lastRun
              ? `${fmtTime(rule.lastRun.at)} · ${rule.lastRun.status} · ${rule.lastRun.cards} card(s)`
              : "never"}
          </Muted>
          {rule.blocked ? (
            <Text
              style={{
                color: rule.paused ? theme.colors.statusDanger : theme.colors.statusWarning,
                fontSize: 12,
              }}
            >
              {BLOCKED_TEXT[rule.blocked] ?? rule.blocked}
            </Text>
          ) : null}
          <View style={{ flexDirection: "row", gap: 8 }}>
            {rule.paused ? (
              <Button
                theme={theme}
                label={busy === `resume:${rule.id}` ? "Resuming..." : "Resume"}
                disabled={busy !== null}
                onPress={() => void resume(rule)}
              />
            ) : null}
            <Button
              theme={theme}
              label={busy === `run:${rule.id}` ? "Running..." : "Run now"}
              disabled={busy !== null || !rule.enabled}
              onPress={() => void runNow(rule)}
            />
          </View>
        </Section>
      ))}
    </ScrollView>
  );
}

export function MaintainSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Wrench"
      label="Maintenance"
      active={currentScreen?.screenId === "main"}
      onPress={() => openScreen({ screenId: "main" })}
    />
  );
}

export function MaintainSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(maintainSettings);
  if (settings.status !== "ready") {
    return (
      <View style={{ padding: 16 }}>
        <Text style={{ color: theme.colors.foregroundMuted }}>
          {settings.status === "loading" ? "Loading..." : `Could not load settings: ${settings.error}`}
        </Text>
      </View>
    );
  }
  const { values, revision } = settings;
  const save = (next: typeof values) => void settings.save(next, revision);
  const integer = (text: string, min: number, max: number) => {
    const n = Number(text);
    return text.trim() && Number.isInteger(n) && n >= min && n <= max ? n : null;
  };
  return (
    <SettingsSection title="Maintenance">
      <SettingsCard>
        <SettingsSwitch
          label="Enabled"
          value={values.enabled}
          onValueChange={(enabled: boolean) => save({ ...values, enabled })}
        />
        <SettingsInput
          label="Check triggers every (seconds)"
          hint="5 to 3600"
          initialValue={String(values.tickSeconds)}
          onChangeText={(text) => {
            const n = integer(text, 5, 3600);
            if (n !== null) save({ ...values, tickSeconds: n });
          }}
        />
        <SettingsInput
          label="Pause a rule after this many rejected cards"
          hint="1 to 20"
          initialValue={String(values.pauseAfterRejections)}
          onChangeText={(text) => {
            const n = integer(text, 1, 20);
            if (n !== null) save({ ...values, pauseAfterRejections: n });
          }}
        />
        <SettingsInput
          label="Default agent (provider/model) when a rule names none"
          initialValue={values.defaultAgent}
          onChangeText={(text) => save({ ...values, defaultAgent: text.trim() || "claude/sonnet" })}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
