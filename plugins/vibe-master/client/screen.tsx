import type { PluginTheme } from "@getpaseo/plugin";
import {
  useRpc,
  useSettings,
  type PluginScreenProps,
  type PluginSidebarItemProps,
  type PluginSurfaceProps,
} from "@getpaseo/plugin/client";
import { SettingsCard, SettingsInput, SettingsSection, SettingsSelect, SettingsSwitch, SidebarRow } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { masterSettings, permissionRpc, statusRpc, switchRpc } from "../shared/rpc";
import { switchChoices, targetLabel, type SwitchChoice } from "./format";

/** Modes a provider may offer; one the provider lacks falls back to auto. */
const PERMISSION_CHOICES = [
  { label: "Auto (recommended)", value: "auto" },
  { label: "Ask for everything (Claude: default)", value: "default" },
  { label: "Accept file edits (Claude)", value: "acceptEdits" },
  { label: "Auto-review (Codex)", value: "auto-review" },
  { label: "Full access (Codex)", value: "full-access" },
  { label: "Bypass (Claude)", value: "bypassPermissions" },
] as const;

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

function levelColor(theme: PluginTheme, level: SwitchChoice["level"]): string {
  if (level === "exhausted") return theme.colors.statusDanger;
  if (level === "tight") return theme.colors.statusWarning;
  return theme.colors.foregroundMuted;
}

export function MasterScreen({ theme }: PluginScreenProps) {
  const queryClient = useQueryClient();
  const statusCall = useRpc(statusRpc);
  const switchCall = useRpc(switchRpc);
  const permissionCall = useRpc(permissionRpc);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const status = useQuery({
    queryKey: ["vibe-master", "status"],
    queryFn: () => statusCall({ includeProviders: true }),
    refetchInterval: 5_000,
  });
  const s = status.data;

  const choose = async (choice: SwitchChoice) => {
    setBusy(choice.key);
    setError(null);
    try {
      await switchCall({ ...choice.request, reason: "switched from the master screen" });
      await queryClient.invalidateQueries({ queryKey: ["vibe-master"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const choosePermission = async (mode: string) => {
    setBusy(`permission:${mode}`);
    setError(null);
    try {
      await permissionCall({ mode });
      await queryClient.invalidateQueries({ queryKey: ["vibe-master"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: 16, gap: 12 }}>
      {status.error ? (
        <Text style={{ color: theme.colors.statusDanger }}>Could not load the master: {String(status.error)}</Text>
      ) : null}
      {!s ? <Muted theme={theme}>Loading...</Muted> : null}
      {s ? (
        <>
          <Section theme={theme} title="Master agent">
            <Text style={{ color: theme.colors.foreground }}>{targetLabel(s.target)}</Text>
            <Muted theme={theme}>
              {s.targetSource === "switched" ? "Switched by you" : "Default from settings"}
              {s.session ? ` - session ${s.session.state}` : " - no session yet"}
              {s.paseoReady ? "" : " - waiting for the daemon"}
            </Muted>
            {!s.enabled ? <Muted theme={theme}>The master is disabled in settings.</Muted> : null}
            {s.lastAlert ? (
              <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
                {s.lastAlert.message} ({s.lastAlert.at.slice(11, 16)} UTC)
              </Text>
            ) : null}
          </Section>

          <Section theme={theme} title="Queue">
            <Muted theme={theme}>
              {s.queue.running
                ? `Working on ${s.queue.running.kind}${s.queue.running.cardKey ? ` for ${s.queue.running.cardKey}` : ""}`
                : "Idle"}
              {s.queue.blocked ? ` - ${s.queue.blocked} job(s) wait for a daemon handle or quota` : ""}
            </Muted>
            {s.queue.pending.map((j, i) => (
              <Text key={i} style={{ color: theme.colors.foreground, fontSize: 13 }}>
                {j.kind} {j.cardKey ?? ""}
                {j.dueInSeconds > 0 ? ` in ${j.dueInSeconds}s` : " queued"}
              </Text>
            ))}
          </Section>

          {s.permission ? (
            <Section theme={theme} title="Permission mode">
              <Text style={{ color: theme.colors.foreground }}>
                {s.permission.auto ? "Auto" : s.permission.label}
                {s.permission.modeId && s.permission.auto ? ` (${s.permission.label})` : ""}
                {!s.permission.modeId ? " (provider default)" : ""}
              </Text>
              <Muted theme={theme}>
                {s.permission.source === "switched" ? "Switched by you" : "Default from settings"}. Applies to the master
                and the planning sessions; a running one restarts in the new mode with the same cards.
              </Muted>
              {[
                { id: "auto", label: "Auto (the provider's automatic approval mode)" },
                ...s.permission.options.map((o) => ({ id: o.id, label: o.label })),
                ...(s.permission.source === "switched" ? [{ id: "settings", label: "Follow the settings default" }] : []),
              ].map((option) => {
                const active = option.id !== "settings" && (option.id === "auto" ? s.permission!.auto : option.id === s.permission!.modeId && !s.permission!.auto);
                return (
                  <Pressable
                    key={option.id}
                    disabled={busy !== null || active}
                    onPress={() => void choosePermission(option.id)}
                    style={{
                      borderRadius: 8,
                      borderWidth: 1,
                      borderColor: active ? theme.colors.accent : theme.colors.border,
                      backgroundColor: theme.colors.surface2,
                      padding: 10,
                      opacity: busy !== null && busy !== `permission:${option.id}` ? 0.5 : 1,
                    }}
                  >
                    <Text style={{ color: theme.colors.foreground }}>
                      {active ? "Current: " : ""}
                      {option.label}
                      {busy === `permission:${option.id}` ? " ..." : ""}
                    </Text>
                  </Pressable>
                );
              })}
            </Section>
          ) : null}

          <Section theme={theme} title="Switch subscription">
            <Muted theme={theme}>
              Cards, assessments and memory live on the board, so a switch continues with the same cards.
            </Muted>
            {error ? <Text style={{ color: theme.colors.statusDanger }}>{error}</Text> : null}
            {switchChoices(s.providers, s.target).map((choice) => (
              <Pressable
                key={choice.key}
                disabled={busy !== null || choice.active}
                onPress={() => void choose(choice)}
                style={{
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: choice.active ? theme.colors.accent : theme.colors.border,
                  backgroundColor: theme.colors.surface2,
                  padding: 10,
                  opacity: busy !== null && busy !== choice.key ? 0.5 : 1,
                }}
              >
                <Text style={{ color: theme.colors.foreground }}>
                  {choice.active ? "Current: " : ""}
                  {choice.label}
                  {busy === choice.key ? " ..." : ""}
                </Text>
                <Text style={{ color: levelColor(theme, choice.level), fontSize: 12 }}>{choice.detail}</Text>
              </Pressable>
            ))}
            {s.providers.length === 0 ? <Muted theme={theme}>No providers reported yet.</Muted> : null}
          </Section>

          {s.switchHistory.length ? (
            <Section theme={theme} title="Switch history">
              {s.switchHistory.slice(-5).map((h, i) => (
                <Muted key={i} theme={theme}>
                  {h.at.slice(0, 16).replace("T", " ")}: {h.from} to {h.to}
                  {h.reason ? ` (${h.reason})` : ""}
                </Muted>
              ))}
            </Section>
          ) : null}
        </>
      ) : null}
    </ScrollView>
  );
}

export function MasterSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Bot"
      label="Master"
      active={currentScreen?.screenId === "main"}
      onPress={() => openScreen({ screenId: "main" })}
    />
  );
}

export function MasterSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(masterSettings);
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
  const num = (text: string, fallback: number) => {
    const n = Number(text);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return (
    <SettingsSection title="Master agent defaults (a manual switch overrides provider and model)">
      <SettingsCard>
        <SettingsSwitch
          label="Enabled"
          value={values.enabled}
          onValueChange={(enabled: boolean) => save({ ...values, enabled })}
        />
        <SettingsInput label="Provider" initialValue={values.provider} onChangeText={(provider) => save({ ...values, provider: provider.trim() || "claude" })} />
        <SettingsInput
          label="Model id (empty = Opus for Claude, else the default)"
          initialValue={values.model}
          onChangeText={(model) => save({ ...values, model: model.trim() })}
        />
        <SettingsInput
          label="Thinking option (empty = default, max = highest)"
          initialValue={values.thinking}
          onChangeText={(thinking) => save({ ...values, thinking: thinking.trim() })}
        />
        <SettingsSelect
          label="Permission mode of the master and planners (auto = the provider's automatic mode)"
          value={values.permissionMode}
          options={PERMISSION_CHOICES}
          onValueChange={(permissionMode: string) => save({ ...values, permissionMode })}
        />
        <SettingsInput
          label="Quiet period before assessing a draft (seconds)"
          initialValue={String(values.debounceSeconds)}
          onChangeText={(text) => save({ ...values, debounceSeconds: Math.round(Math.min(600, num(text, 30))) })}
        />
        <SettingsInput
          label="Remind when quota is below (percent)"
          initialValue={String(values.quotaLowPct)}
          onChangeText={(text) => save({ ...values, quotaLowPct: Math.min(90, num(text, 20)) })}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
