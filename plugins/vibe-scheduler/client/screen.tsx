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
  SettingsSelect,
  SidebarRow,
} from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import {
  devicesRpc,
  registerDeviceRpc,
  removeDeviceRpc,
  schedulerSettings,
  statusRpc,
} from "../shared/rpc";
import {
  fmtPct,
  formatLimits,
  parseDevices,
  parseLimits,
  parseStatus,
  pauseReason,
} from "./format";

const DEVICE_KINDS = ["emulator", "simulator", "board", "debugger", "camera", "other"] as const;
type DeviceKind = (typeof DEVICE_KINDS)[number];

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

function Row({ theme, left, right }: { theme: PluginTheme; left: string; right: string }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
      <Text style={{ color: theme.colors.foreground, flexShrink: 1 }}>{left}</Text>
      <Text style={{ color: theme.colors.foregroundMuted, flexShrink: 1, textAlign: "right" }}>{right}</Text>
    </View>
  );
}

function Button({
  theme,
  label,
  onPress,
  active,
  disabled,
}: {
  theme: PluginTheme;
  label: string;
  onPress: () => void;
  active?: boolean;
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
        backgroundColor: active ? theme.colors.accent : theme.colors.surface2,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Text style={{ color: active ? theme.colors.accentForeground : theme.colors.foreground, fontSize: 12 }}>
        {label}
      </Text>
    </Pressable>
  );
}

function Field({
  theme,
  value,
  onChangeText,
  placeholder,
}: {
  theme: PluginTheme;
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
}) {
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={theme.colors.foregroundMuted}
      autoCapitalize="none"
      style={{
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface0,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 6,
        fontSize: 14,
      }}
    />
  );
}

const levelColor = (theme: PluginTheme, level: string) =>
  level === "exhausted"
    ? theme.colors.statusDanger
    : level === "tight"
      ? theme.colors.statusWarning
      : theme.colors.foregroundMuted;

export function SchedulerScreen({ theme }: PluginScreenProps) {
  const queryClient = useQueryClient();
  const statusCall = useRpc(statusRpc);
  const devicesCall = useRpc(devicesRpc);
  const registerCall = useRpc(registerDeviceRpc);
  const removeCall = useRpc(removeDeviceRpc);
  const settings = useSettings(schedulerSettings);
  const [kind, setKind] = useState<DeviceKind>("emulator");
  const [name, setName] = useState("");
  const [serial, setSerial] = useState("");
  const [avd, setAvd] = useState("");
  const [error, setError] = useState<string | null>(null);

  const status = useQuery({
    queryKey: ["vibe-scheduler", "status"],
    queryFn: async () => parseStatus(await statusCall({})),
    refetchInterval: 5_000,
  });
  const devices = useQuery({
    queryKey: ["vibe-scheduler", "devices"],
    queryFn: async () => parseDevices(await devicesCall({})),
    refetchInterval: 10_000,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["vibe-scheduler"] });
  const act = async (run: () => Promise<unknown>) => {
    setError(null);
    try {
      await run();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const s = status.data;
  const limits = settings.status === "ready" ? settings.values : null;
  const leased = new Map(s?.pool.map((d) => [d.name, d.leased]));

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: 16, gap: 12 }}>
      {status.error ? (
        <Text style={{ color: theme.colors.statusDanger }}>Could not load the scheduler: {String(status.error)}</Text>
      ) : null}
      {!s ? <Muted theme={theme}>Loading...</Muted> : null}
      {s ? (
        <>
          <Section theme={theme} title="Concurrency">
            <Row
              theme={theme}
              left="Running workers"
              right={limits ? `${s.running.total} / ${limits.globalLimit}` : String(s.running.total)}
            />
            {Object.entries(s.running.byProvider).map(([provider, n]) => (
              <Row
                key={provider}
                theme={theme}
                left={provider}
                right={limits?.providerLimits[provider] ? `${n} / ${limits.providerLimits[provider]}` : String(n)}
              />
            ))}
            {s.resources ? (
              <Row
                theme={theme}
                left="CPU / memory"
                right={`${fmtPct(s.resources.cpu)} / ${fmtPct(s.resources.mem)}`}
              />
            ) : null}
            {s.paused ? (
              <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
                {pauseReason(s, limits?.memoryThreshold ?? 0.85)}
              </Text>
            ) : (
              <Muted theme={theme}>Admission is running.</Muted>
            )}
          </Section>

          <Section theme={theme} title="Quota">
            {s.quota.length === 0 ? <Muted theme={theme}>No provider reports quota yet.</Muted> : null}
            {s.quota.map((q) => (
              <View key={q.provider}>
                <Row
                  theme={theme}
                  left={q.provider}
                  right={q.remainingPct === null ? q.level : `${Math.round(q.remainingPct)}% left · ${q.level}`}
                />
                {q.level === "tight" || q.level === "exhausted" ? (
                  <Text style={{ color: levelColor(theme, q.level), fontSize: 12 }}>
                    {q.level === "exhausted" ? "No new cards for this provider" : "Reserved for high-priority cards"}
                    {q.resetsAt ? ` · resets ${q.resetsAt.slice(5, 16).replace("T", " ")}` : ""}
                  </Text>
                ) : null}
              </View>
            ))}
          </Section>

          <Section theme={theme} title="Waiting cards">
            {s.pending.map((a) => (
              <Row key={a.cardKey} theme={theme} left={a.cardKey} right={`admitted on ${a.provider}, dispatching`} />
            ))}
            {s.deferred.map((d) => (
              <Row key={d.cardKey} theme={theme} left={d.cardKey} right={d.reason} />
            ))}
            {s.pending.length + s.deferred.length === 0 ? (
              <Muted theme={theme}>No card is waiting for a slot.</Muted>
            ) : null}
          </Section>
        </>
      ) : null}

      <Section theme={theme} title="Device pool">
        {error ? <Text style={{ color: theme.colors.statusDanger }}>{error}</Text> : null}
        {devices.data?.length === 0 ? <Muted theme={theme}>No devices registered.</Muted> : null}
        {devices.data?.map((d) => (
          <View key={d.id} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <View style={{ flexShrink: 1 }}>
              <Text style={{ color: theme.colors.foreground }}>
                {d.name} · {d.kind}
              </Text>
              <Muted theme={theme}>
                {leased.get(d.name) ? "in use" : "free"}
                {d.detail ? ` · ${d.detail}` : ""}
              </Muted>
            </View>
            <Button theme={theme} label="Remove" onPress={() => void act(() => removeCall({ id: d.id }))} />
          </View>
        ))}
        <Muted theme={theme}>Register a device</Muted>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {DEVICE_KINDS.map((k) => (
            <Button key={k} theme={theme} label={k} active={k === kind} onPress={() => setKind(k)} />
          ))}
        </View>
        <Field theme={theme} value={name} onChangeText={setName} placeholder="Name (e.g. pixel-emulator)" />
        <Field theme={theme} value={serial} onChangeText={setSerial} placeholder="adb serial (optional)" />
        <Field theme={theme} value={avd} onChangeText={setAvd} placeholder="AVD name (optional)" />
        <View style={{ flexDirection: "row" }}>
          <Button
            theme={theme}
            label="Register"
            disabled={!name.trim()}
            onPress={() =>
              void act(async () => {
                await registerCall({
                  kind,
                  name: name.trim(),
                  ...(serial.trim() ? { serial: serial.trim() } : {}),
                  ...(avd.trim() ? { avd: avd.trim() } : {}),
                });
                setName("");
                setSerial("");
                setAvd("");
              })
            }
          />
        </View>
      </Section>
    </ScrollView>
  );
}

export function SchedulerSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Cpu"
      label="Scheduler"
      active={currentScreen?.screenId === "main"}
      onPress={() => openScreen({ screenId: "main" })}
    />
  );
}

const PRIORITIES = ["urgent", "high", "medium", "low", "none"] as const;

export function SchedulerSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(schedulerSettings);
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
  // Numbers: ignore text that is not a number inside [min, max] so a half-typed value never saves.
  const numeric = (key: keyof typeof values, min: number, max: number, int = true) => (text: string) => {
    const n = Number(text);
    if (text.trim() && Number.isFinite(n) && n >= min && n <= max && (!int || Number.isInteger(n))) {
      save({ ...values, [key]: n });
    }
  };
  const field = (label: string, key: keyof typeof values, min: number, max: number, int = true, hint?: string) => (
    <SettingsInput
      label={label}
      hint={hint}
      initialValue={String(values[key])}
      onChangeText={numeric(key, min, max, int)}
    />
  );
  return (
    <SettingsSection title="Scheduler">
      <SettingsCard>
        {field("Max running workers (all providers)", "globalLimit", 1, 64)}
        <SettingsInput
          label="Per provider limits"
          hint="Example: claude=2, codex=1"
          initialValue={formatLimits(values.providerLimits)}
          onChangeText={(text) => save({ ...values, providerLimits: parseLimits(text) })}
        />
        {field("Pause above this memory fraction", "memoryThreshold", 0.5, 0.99, false, "0.5 to 0.99")}
        {field("Quota tight at remaining percent", "quotaTightPct", 0, 100, false)}
        {field("Quota exhausted at remaining percent", "quotaExhaustedPct", 0, 100, false)}
        <SettingsSelect
          label="Priority allowed while a provider is tight"
          value={values.tightMinPriority}
          options={PRIORITIES.map((p) => ({ label: p, value: p }))}
          onValueChange={(tightMinPriority) => save({ ...values, tightMinPriority })}
        />
        {field("Dev server port base", "devPortBase", 1024, 65000)}
        {field("Dev server port span", "devPortSpan", 10, 5000)}
        {field("Device lease (minutes)", "deviceLeaseMinutes", 1, 100000)}
        {field("Admission tick (seconds)", "tickSeconds", 1, 600)}
        {field("Resource sample interval (seconds)", "sampleSeconds", 5, 3600)}
        {field("Keep samples (days)", "sampleRetentionDays", 1, 365)}
      </SettingsCard>
    </SettingsSection>
  );
}
