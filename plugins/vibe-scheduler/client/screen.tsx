import { REMOTE_TARGET_PATTERN } from "../shared/vibe/contract";
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
  SidebarRow,
} from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useState, type ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";
import { HubSections } from "./hub-screen";
import { Button, Field, Muted, Row, Section } from "./hub-ui";
import { formatRpcError } from "../shared/vibe/ui/rpc-error";
import {
  devicesRpc,
  remoteHostsRpc,
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

const KIND_ZH: Record<string, string> = {
  emulator: "模拟器",
  simulator: "仿真器",
  board: "开发板",
  debugger: "调试器",
  camera: "摄像头",
  other: "其它",
};
const LEVEL_ZH: Record<string, string> = {
  ok: "充足",
  tight: "紧张",
  exhausted: "用完",
  unknown: "未知",
};

const levelColor = (theme: PluginTheme, level: string) => {
  if (level === "exhausted") return theme.colors.statusDanger;
  if (level === "tight") return theme.colors.statusWarning;
  return theme.colors.foregroundMuted;
};

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
  const [showMore, setShowMore] = useState(false);

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
      setError(formatRpcError(e));
    }
  };

  const s = status.data;
  const limits = settings.status === "ready" ? settings.values : null;
  const leased = new Map(s?.pool.map((d) => [d.name, d.leased]));

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{
        padding: theme.spacing?.[4] ?? 16,
        gap: theme.spacing?.[3] ?? 12,
        width: "100%",
        maxWidth: 784,
        alignSelf: "center",
      }}
    >
      <View style={{ gap: theme.spacing?.[2] ?? 8 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: theme.fontSize?.xl ?? 18, fontWeight: "600" }}>
          中枢
        </Text>
        <Muted theme={theme}>全机任务队列、共用资源、暂停窗口和全局指令。</Muted>
      </View>
      <HubSections theme={theme} />
      <Section theme={theme} title="运行记录与维护规则">
        <Muted theme={theme}>在总协调 bot 右侧「自动维护」面板中设置和查看维护规则。</Muted>
      </Section>
      <View style={{ flexDirection: "row" }}>
        <Button
          theme={theme}
          label={showMore ? "收起并发、额度与设备池" : "展开并发、额度与设备池"}
          onPress={() => setShowMore((v) => !v)}
        />
      </View>
      {showMore && status.error ? (
        <Text style={{ color: theme.colors.statusDanger }}>
          无法加载调度器：{formatRpcError(status.error)}
        </Text>
      ) : null}
      {showMore && !s ? <Muted theme={theme}>加载中...</Muted> : null}
      {showMore && s ? (
        <>
          <Section theme={theme} title="任务状态">
            <Row theme={theme} left="运行中" right={String(s.running.total)} />
            <Row theme={theme} left="排队 / 阻塞" right={String(s.deferred.length)} />
            <Row theme={theme} left="已分配资源" right={String(s.pending.length)} />
          </Section>
          <ResourceStatus theme={theme} />
          <RemoteHosts theme={theme} />
          <Section theme={theme} title="并发">
            <Row
              theme={theme}
              left="运行中的 worker"
              right={
                limits ? `${s.running.total} / ${limits.globalLimit}` : String(s.running.total)
              }
            />
            {Object.entries(s.running.byProvider).map(([provider, n]) => (
              <Row
                key={provider}
                theme={theme}
                left={provider}
                right={
                  limits?.providerLimits[provider]
                    ? `${n} / ${limits.providerLimits[provider]}`
                    : String(n)
                }
              />
            ))}
            {s.resources ? (
              <Row
                theme={theme}
                left="CPU / 内存"
                right={`${fmtPct(s.resources.cpu)} / ${fmtPct(s.resources.mem)}`}
              />
            ) : null}
            {s.paused ? (
              <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
                {pauseReason(s, limits?.memoryThreshold ?? 0.85)}
              </Text>
            ) : (
              <Muted theme={theme}>正在正常放行任务。</Muted>
            )}
          </Section>

          <Section theme={theme} title="额度">
            {s.quota.length === 0 ? <Muted theme={theme}>还没有 provider 上报额度。</Muted> : null}
            {s.quota.map((q) => (
              <View key={q.provider}>
                <Row
                  theme={theme}
                  left={q.provider}
                  right={
                    q.remainingPct === null
                      ? (LEVEL_ZH[q.level] ?? q.level)
                      : `剩余 ${Math.round(q.remainingPct)}% · ${LEVEL_ZH[q.level] ?? q.level}`
                  }
                />
                {q.level === "tight" || q.level === "exhausted" ? (
                  <Text style={{ color: levelColor(theme, q.level), fontSize: 12 }}>
                    {q.level === "exhausted"
                      ? "不再给这个 provider 派新任务"
                      : "剩余额度紧张，请留意消耗"}
                    {q.resetsAt ? ` · ${q.resetsAt.slice(5, 16).replace("T", " ")} 恢复` : ""}
                  </Text>
                ) : null}
              </View>
            ))}
          </Section>

          <Section theme={theme} title="任务资源与排队">
            {s.pending.map((a) => (
              <Row
                key={a.id}
                theme={theme}
                left={`${a.workspaceId} · ${a.role}`}
                right={`${a.provider} · 端口 ${a.port}`}
              />
            ))}
            {s.deferred.map((d) => (
              <Row key={d.workspaceId} theme={theme} left={d.workspaceId} right={d.reason} />
            ))}
            {s.pending.length + s.deferred.length === 0 ? (
              <Muted theme={theme}>没有任务占用资源或排队。</Muted>
            ) : null}
          </Section>
        </>
      ) : null}

      {showMore ? <Section theme={theme} title="设备池">
        {error ? <Text style={{ color: theme.colors.statusDanger }}>{error}</Text> : null}
        {devices.data?.length === 0 ? <Muted theme={theme}>还没有登记设备。</Muted> : null}
        {devices.data?.map((d) => (
          <View
            key={d.id}
            style={{
              flexDirection: "row",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 8,
            }}
          >
            <View style={{ flexShrink: 1 }}>
              <Text style={{ color: theme.colors.foreground }}>
                {d.name} · {KIND_ZH[d.kind] ?? d.kind}
              </Text>
              <Muted theme={theme}>
                {leased.get(d.name) ? "使用中" : "空闲"}
                {d.detail ? ` · ${d.detail}` : ""}
              </Muted>
            </View>
            <Button
              theme={theme}
              label="移除"
              onPress={() => void act(() => removeCall({ id: d.id }))}
            />
          </View>
        ))}
        <Muted theme={theme}>登记设备</Muted>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {DEVICE_KINDS.map((k) => (
            <Button
              key={k}
              theme={theme}
              label={KIND_ZH[k] ?? k}
              active={k === kind}
              onPress={() => setKind(k)}
            />
          ))}
        </View>
        <Field
          theme={theme}
          value={name}
          onChangeText={setName}
          placeholder="名称（例如 pixel-emulator）"
        />
        <Field
          theme={theme}
          value={serial}
          onChangeText={setSerial}
          placeholder="adb 序列号（可选）"
        />
        <Field theme={theme} value={avd} onChangeText={setAvd} placeholder="AVD 名称（可选）" />
        <View style={{ flexDirection: "row" }}>
          <Button
            theme={theme}
            label="登记"
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
      </Section> : null}
    </ScrollView>
  );
}

export function SchedulerSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Cpu"
      label="中枢"
      active={currentScreen?.screenId === "main"}
      onPress={() => openScreen({ screenId: "main" })}
    />
  );
}

export function SchedulerSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(schedulerSettings);
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
  // Numbers: ignore text that is not a number inside [min, max] so a half-typed value never saves.
  const numeric =
    (key: keyof typeof values, min: number, max: number, int = true) =>
    (text: string) => {
      const n = Number(text);
      if (
        text.trim() &&
        Number.isFinite(n) &&
        n >= min &&
        n <= max &&
        (!int || Number.isInteger(n))
      ) {
        save({ ...values, [key]: n });
      }
    };
  const field = (
    label: string,
    key: keyof typeof values,
    min: number,
    max: number,
    int = true,
    hint?: string,
  ) => (
    <SettingsInput
      label={label}
      hint={hint}
      initialValue={String(values[key])}
      onChangeText={numeric(key, min, max, int)}
    />
  );
  return (
    <SettingsSection title="调度器">
      <ResourceStatus theme={theme} />
      <RemoteHosts theme={theme} />
      <SettingsCard>
        {field("同时运行的 worker 上限（所有 provider 合计）", "globalLimit", 1, 64)}
        <SettingsInput
          label="各 provider 的并发上限"
          hint="例如：claude=2, codex=1"
          initialValue={formatLimits(values.providerLimits)}
          onChangeText={(text) => save({ ...values, providerLimits: parseLimits(text) })}
        />
        {field(
          "内存占用超过多少比例时暂停放行",
          "memoryThreshold",
          0.5,
          0.99,
          false,
          "0.5 到 0.99",
        )}
        {field("剩余额度低于多少百分比算“紧张”", "quotaTightPct", 0, 100, false)}
        {field("剩余额度低于多少百分比算“用完”", "quotaExhaustedPct", 0, 100, false)}
        {field("开发服务器端口起点", "devPortBase", 1024, 65000)}
        {field("开发服务器端口范围大小", "devPortSpan", 10, 5000)}
        {field("放行检查间隔（秒）", "tickSeconds", 1, 600)}
        {field("资源采样间隔（秒）", "sampleSeconds", 5, 3600)}
        {field("远程主机采样间隔（秒）", "remoteSampleSeconds", 15, 3600)}
        {field("采样保留天数", "sampleRetentionDays", 1, 365)}
      </SettingsCard>
    </SettingsSection>
  );
}

function ResourceStatus({ theme }: { theme: PluginTheme }) {
  const statusCall = useRpc(statusRpc);
  const status = useQuery({
    queryKey: ["vibe-scheduler", "resource-status"],
    queryFn: async () => parseStatus(await statusCall({})),
    refetchInterval: 5000,
  });
  return (
    <Section theme={theme} title="主机资源">
      {status.data?.hosts.length ? status.data.hosts.map((host) => (
        <View key={host.name} style={{ gap: theme.spacing?.[2] ?? 8 }}>
          <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>{host.name}</Text>
          {host.error ? <Muted theme={theme}>{host.error}</Muted> : (
            <>
              {host.cpu !== null ? <Row theme={theme} left="CPU" right={fmtPct(host.cpu)} /> : null}
              {host.availableBytes !== null && host.totalBytes !== null ? (
                <Row theme={theme} left="可用内存" right={`${(host.availableBytes / 1024 ** 3).toFixed(1)} / ${(host.totalBytes / 1024 ** 3).toFixed(1)} GB`} />
              ) : null}
              {host.load1 !== null && host.cores !== null ? (
                <Row theme={theme} left="1 分钟负载 / 核心" right={`${host.load1.toFixed(1)} / ${host.cores}`} />
              ) : null}
            </>
          )}
        </View>
      )) : <Muted theme={theme}>资源：等待采样</Muted>}
      {status.data?.tightItems.map((reason) => (
        <Muted key={reason} theme={theme}>
          {reason}
        </Muted>
      ))}
      {status.error ? <Muted theme={theme}>{formatRpcError(status.error)}</Muted> : null}
    </Section>
  );
}
function RemoteHosts({ theme }: { theme: PluginTheme }) {
  const call = useRpc(remoteHostsRpc);
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["vibe-scheduler", "remote-hosts"], queryFn: () => call({}) });
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (hosts: Array<{ name: string; target: string }>) => {
    setBusy(true);
    setError(null);
    try {
      await call({ hosts });
      await queryClient.invalidateQueries({ queryKey: ["vibe-scheduler"] });
      setName("");
      setTarget("");
    } catch (e) {
      setError(formatRpcError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section theme={theme} title="远程主机">
      {query.data?.hosts.map((host) => (
        <View key={host.target} style={{ gap: 8 }}>
          <Row theme={theme} left={host.name} right={host.target} />
          <Button
            theme={theme}
            label="移除"
            disabled={busy}
            onPress={() => void save(query.data!.hosts.filter((h) => h.target !== host.target))}
          />
        </View>
      ))}
      {query.data?.hosts.length === 0 ? <Muted theme={theme}>尚未配置远程主机。</Muted> : null}
      <Field theme={theme} value={name} onChangeText={setName} placeholder="显示名" />
      <Field
        theme={theme}
        value={target}
        onChangeText={setTarget}
        placeholder="user@example-host"
      />
      <Button
        theme={theme}
        label="添加"
        disabled={busy || !query.data || !name.trim() || !REMOTE_TARGET_PATTERN.test(target.trim())}
        onPress={() =>
          void save([...(query.data?.hosts ?? []), { name: name.trim(), target: target.trim() }])
        }
      />
      {busy ? <Muted theme={theme}>保存中...</Muted> : null}
      {error || query.error ? (
        <Text style={{ color: theme.colors.statusDanger }}>
          {error ?? formatRpcError(query.error)}
        </Text>
      ) : null}
      <Muted theme={theme}>使用已有 SSH 密钥，无交互连接；默认每 60 秒采样。</Muted>
    </Section>
  );
}
