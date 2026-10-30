import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useState } from "react";
import { Text, TextInput, View } from "react-native";
import { formatRpcError } from "../shared/vibe/ui/rpc-error";
import {
  hubDirectiveConfirmRpc,
  hubDirectiveIssueRpc,
  hubDirectiveListRpc,
  hubDirectiveRevokeRpc,
  hubPauseCreateRpc,
  hubPauseRevokeRpc,
  hubQueueReorderRpc,
  hubResourceRemoveRpc,
  hubResourceUpsertRpc,
  hubSettingsGetRpc,
  hubSettingsSetRpc,
  hubStatusRpc,
} from "./hub-rpc";
import {
  EMPTY_HUB_STATUS,
  PAUSE_SCOPES,
  STATE_ZH,
  THRESHOLD_FIELDS,
  formatClock,
  formatMetric,
  formatRemaining,
  groupDirectives,
  metricExceeds,
  moveQueueItem,
  parseDirectives,
  parseHubStatus,
  parseNumberField,
  parseThresholds,
  queueOrderIds,
  queueSource,
  setQueuePriority,
  sortQueue,
  validateDirectiveForm,
  validatePauseForm,
  validateResourceForm,
  type Directive,
  type HubResource,
  type HubStatus,
  type QueueItem,
  type ThresholdField,
  type Thresholds,
} from "./hub-model";
import { Button, Field, Muted, Section } from "./hub-ui";

const KEY = ["vibe-scheduler", "hub"] as const;
const STATUS_KEY = [...KEY, "status"] as const;
const SETTINGS_KEY = [...KEY, "settings"] as const;
const DIRECTIVES_KEY = [...KEY, "directives"] as const;
const POLL_MS = 5_000;

/**
 * react-query keeps the last result per key, so reopening the page paints the cache at once and
 * refetches behind it. `refetchIntervalInBackground: false` pauses the 5 s poll while the page is hidden.
 */
function useHubData() {
  const queryClient = useQueryClient();
  const statusCall = useRpc(hubStatusRpc);
  const settingsCall = useRpc(hubSettingsGetRpc);
  const directivesCall = useRpc(hubDirectiveListRpc);
  const poll = { refetchInterval: POLL_MS, refetchIntervalInBackground: false, retry: 1 } as const;
  const status = useQuery({
    queryKey: STATUS_KEY,
    queryFn: async () => parseHubStatus(await statusCall({})),
    ...poll,
  });
  const settings = useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: async () => parseThresholds(await settingsCall({})),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    retry: 1,
  });
  const directives = useQuery({
    queryKey: DIRECTIVES_KEY,
    queryFn: async () => parseDirectives(await directivesCall({})),
    ...poll,
  });
  const [error, setError] = useState<string | null>(null);

  /** Optimistic write: patch the cache, call, roll back on failure, refetch either way. */
  async function mutate<T>(key: readonly string[], patch: (prev: T) => T, call: () => Promise<unknown>) {
    setError(null);
    await queryClient.cancelQueries({ queryKey: key });
    const prev = queryClient.getQueryData<T>(key);
    if (prev !== undefined) queryClient.setQueryData<T>(key, patch(prev));
    try {
      await call();
    } catch (e) {
      if (prev !== undefined) queryClient.setQueryData<T>(key, prev);
      setError(formatRpcError(e));
    } finally {
      void queryClient.invalidateQueries({ queryKey: KEY });
    }
  }
  return { status, settings, directives, error, setError, mutate };
}

type Hub = ReturnType<typeof useHubData>;

export function HubSections({ theme }: { theme: PluginTheme }) {
  const hub = useHubData();
  const status = hub.status.data ?? EMPTY_HUB_STATUS;
  const thresholds = hub.settings.data ?? {};
  const unavailable = hub.status.error && !hub.status.data;
  return (
    <>
      {unavailable ? (
        <Text style={{ color: theme.colors.statusWarning }}>
          中枢服务暂不可用：{formatRpcError(hub.status.error)}
        </Text>
      ) : null}
      {hub.error ? <Text style={{ color: theme.colors.statusDanger }}>{hub.error}</Text> : null}
      <MachineSection theme={theme} hub={hub} status={status} thresholds={thresholds} />
      <QueueSection theme={theme} hub={hub} status={status} />
      <ResourcesSection theme={theme} hub={hub} status={status} />
      <PauseSection theme={theme} hub={hub} status={status} />
      <DirectiveSection theme={theme} hub={hub} items={hub.directives.data ?? []} />
    </>
  );
}

// ---- 机器 -----------------------------------------------------------------------------------

function MachineSection({
  theme,
  hub,
  status,
  thresholds,
}: {
  theme: PluginTheme;
  hub: Hub;
  status: HubStatus;
  thresholds: Thresholds;
}) {
  const setCall = useRpc(hubSettingsSetRpc);
  const save = (field: ThresholdField, value: number) =>
    hub.mutate<Thresholds>(
      SETTINGS_KEY,
      (prev) => ({ ...prev, [field.key]: value }),
      () => setCall({ thresholds: { [field.key]: value } }),
    );
  return (
    <Section theme={theme} title="机器">
      <Muted theme={theme}>实时指标与放行阈值；修改阈值立即生效并写回 guard 配置。</Muted>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {THRESHOLD_FIELDS.map((field) => {
          const over = metricExceeds(field, status.machine, thresholds);
          return (
            <View
              key={field.key}
              style={{
                flexGrow: 1,
                flexBasis: 220,
                gap: 4,
                padding: 10,
                borderRadius: 8,
                backgroundColor: theme.colors.surface0,
                borderWidth: 1,
                borderColor: over ? theme.colors.statusWarning : theme.colors.border,
              }}
            >
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{field.label}</Text>
              {field.metric ? (
                <Text
                  style={{
                    color: over ? theme.colors.statusWarning : theme.colors.foreground,
                    fontSize: 18,
                    fontWeight: "600",
                  }}
                >
                  {formatMetric(field, status.machine[field.metric])}
                </Text>
              ) : null}
              <NumberEdit
                theme={theme}
                field={field}
                value={thresholds[field.key]}
                onCommit={(v) => void save(field, v)}
              />
            </View>
          );
        })}
      </View>
    </Section>
  );
}

/** Edits a number with a local draft; commits on blur/enter only when valid, else shows the range. */
function NumberEdit({
  theme,
  field,
  value,
  onCommit,
}: {
  theme: PluginTheme;
  field: ThresholdField;
  value: number | undefined;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value === undefined ? "" : String(value));
  const parsed = draft === null ? null : parseNumberField(draft, field);
  const invalid = draft !== null && draft.trim() !== "" && parsed === null;
  const commit = () => {
    if (parsed !== null && parsed !== value) onCommit(parsed);
    setDraft(null);
  };
  return (
    <View style={{ gap: 2 }}>
      <TextInput
        value={shown}
        onChangeText={setDraft}
        onBlur={commit}
        onSubmitEditing={commit}
        keyboardType="decimal-pad"
        accessibilityLabel={`${field.label}阈值`}
        style={{
          color: theme.colors.foreground,
          backgroundColor: theme.colors.surface1,
          borderColor: invalid ? theme.colors.statusDanger : theme.colors.border,
          borderWidth: 1,
          borderRadius: 6,
          paddingHorizontal: 8,
          paddingVertical: 4,
          fontSize: 13,
        }}
      />
      <Text style={{ color: invalid ? theme.colors.statusDanger : theme.colors.foregroundMuted, fontSize: 11 }}>
        {invalid ? `需在 ${field.min} 到 ${field.max} 之间${field.int ? "的整数" : ""}` : `阈值${field.unit ? `（${field.unit}）` : ""}`}
      </Text>
    </View>
  );
}

// ---- 队列 -----------------------------------------------------------------------------------

function QueueSection({ theme, hub, status }: { theme: PluginTheme; hub: Hub; status: HubStatus }) {
  const reorderCall = useRpc(hubQueueReorderRpc);
  const items = sortQueue(status.queue);
  const apply = (next: QueueItem[], priorities?: Record<string, number>) =>
    hub.mutate<HubStatus>(
      STATUS_KEY,
      (prev) => ({ ...prev, queue: next }),
      () => reorderCall({ order: queueOrderIds(next), ...(priorities ? { priorities } : {}) }),
    );
  return (
    <Section theme={theme} title="队列">
      <Muted theme={theme}>agent 任务与重任务同一队列。优先级数字越小越优先，0 为部署。</Muted>
      {items.length === 0 ? <Muted theme={theme}>没有任务运行或排队。</Muted> : null}
      {items.map((item) => (
        <QueueRow
          key={item.id}
          theme={theme}
          item={item}
          onMove={(delta) => void apply(moveQueueItem(items, item.id, delta))}
          onPriority={(delta) => {
            const priority = Math.min(9, Math.max(0, item.priority + delta));
            if (priority !== item.priority) {
              void apply(setQueuePriority(items, item.id, priority), { [item.id]: priority });
            }
          }}
        />
      ))}
    </Section>
  );
}

function QueueRow({
  theme,
  item,
  onMove,
  onPriority,
}: {
  theme: PluginTheme;
  item: QueueItem;
  onMove: (delta: -1 | 1) => void;
  onPriority: (delta: -1 | 1) => void;
}) {
  const running = item.state === "running";
  return (
    <View
      style={{
        gap: 4,
        padding: 10,
        borderRadius: 8,
        backgroundColor: theme.colors.surface0,
        borderWidth: 1,
        borderColor: theme.colors.border,
      }}
    >
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <Text
          style={{
            color: running ? theme.colors.accentForeground : theme.colors.foreground,
            backgroundColor: running ? theme.colors.accent : theme.colors.surface2,
            borderRadius: 999,
            paddingHorizontal: 8,
            paddingVertical: 2,
            fontSize: 11,
          }}
        >
          {STATE_ZH[item.state]}
        </Text>
        <Text style={{ color: theme.colors.foreground, flexShrink: 1, fontWeight: "600" }}>
          {queueSource(item)}
        </Text>
        <Muted theme={theme}>{item.kind === "agent" ? "agent 任务" : "重任务"}</Muted>
      </View>
      {item.command ? (
        <Text numberOfLines={2} style={{ color: theme.colors.foreground, fontSize: 13 }}>
          {item.command}
        </Text>
      ) : null}
      {item.waitReasons.map((reason) => (
        <Text key={reason} style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
          {reason}
        </Text>
      ))}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        <Button theme={theme} label="优先级 −" disabled={running} onPress={() => onPriority(1)} />
        <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>P{item.priority}</Text>
        <Button theme={theme} label="优先级 +" disabled={running} onPress={() => onPriority(-1)} />
        <Button theme={theme} label="上移" disabled={running} onPress={() => onMove(-1)} />
        <Button theme={theme} label="下移" disabled={running} onPress={() => onMove(1)} />
      </View>
    </View>
  );
}

// ---- 共用资源 -------------------------------------------------------------------------------

function ResourcesSection({ theme, hub, status }: { theme: PluginTheme; hub: Hub; status: HubStatus }) {
  const upsertCall = useRpc(hubResourceUpsertRpc);
  const removeCall = useRpc(hubResourceRemoveRpc);
  const [name, setName] = useState("");
  const [limit, setLimit] = useState("1");
  const [editing, setEditing] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const upsert = (resource: { name: string; limit: number }) =>
    hub.mutate<HubStatus>(
      STATUS_KEY,
      (prev) => ({
        ...prev,
        resources: prev.resources.some((r) => r.name === resource.name)
          ? prev.resources.map((r) => (r.name === resource.name ? { ...r, limit: resource.limit } : r))
          : [...prev.resources, { ...resource, holders: [] }],
      }),
      () => upsertCall(resource),
    );
  const submit = () => {
    const result = validateResourceForm(name, limit, status.resources.map((r) => r.name), editing);
    if (!result.ok) return setFormError(result.error);
    setFormError(null);
    void upsert(result.value);
    setName("");
    setLimit("1");
    setEditing(false);
  };
  const edit = (r: HubResource) => {
    setName(r.name);
    setLimit(String(r.limit));
    setEditing(true);
    setFormError(null);
  };
  return (
    <Section theme={theme} title="共用资源">
      <Muted theme={theme}>如测试 PostgreSQL 实例。并发上限 1 即排他。</Muted>
      {status.resources.length === 0 ? <Muted theme={theme}>还没有登记共用资源。</Muted> : null}
      {status.resources.map((r) => (
        <View key={r.name} style={{ gap: 4 }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <Text style={{ color: theme.colors.foreground, fontWeight: "600", flexShrink: 1 }}>{r.name}</Text>
            <Muted theme={theme}>
              占用 {r.holders.length} / {r.limit}
            </Muted>
            <Button theme={theme} label="修改上限" onPress={() => edit(r)} />
            <Button
              theme={theme}
              label="删除"
              onPress={() =>
                void hub.mutate<HubStatus>(
                  STATUS_KEY,
                  (prev) => ({ ...prev, resources: prev.resources.filter((x) => x.name !== r.name) }),
                  () => removeCall({ name: r.name }),
                )
              }
            />
          </View>
          {r.holders.length === 0 ? (
            <Muted theme={theme}>空闲</Muted>
          ) : (
            r.holders.map((h) => (
              <Muted key={h.jobId} theme={theme}>
                持有者：{h.owner || h.jobId}（{h.mode === "shared" ? "共享" : "独占"}）
              </Muted>
            ))
          )}
        </View>
      ))}
      <Muted theme={theme}>{editing ? "修改资源并发上限" : "新增资源"}</Muted>
      <Field theme={theme} value={name} onChangeText={setName} placeholder="名称，例如 pg:5435" />
      <Field theme={theme} value={limit} onChangeText={setLimit} placeholder="并发上限（1 到 64）" />
      {formError ? <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{formError}</Text> : null}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Button theme={theme} label={editing ? "保存" : "添加"} onPress={submit} />
        {editing ? (
          <Button
            theme={theme}
            label="取消"
            onPress={() => {
              setEditing(false);
              setName("");
              setLimit("1");
              setFormError(null);
            }}
          />
        ) : null}
      </View>
    </Section>
  );
}

// ---- 暂停与窗口 -----------------------------------------------------------------------------

function PauseSection({ theme, hub, status }: { theme: PluginTheme; hub: Hub; status: HubStatus }) {
  const createCall = useRpc(hubPauseCreateRpc);
  const revokeCall = useRpc(hubPauseRevokeRpc);
  const [scope, setScope] = useState<string>(PAUSE_SCOPES[0].value);
  const [custom, setCustom] = useState("");
  const [minutes, setMinutes] = useState("60");
  const [reason, setReason] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const now = new Date();
  const submit = () => {
    const result = validatePauseForm({ scope: custom.trim() || scope, minutes, reason }, new Date());
    if (!result.ok) return setFormError(result.error);
    setFormError(null);
    const value = result.value;
    void hub.mutate<HubStatus>(
      STATUS_KEY,
      (prev) => ({
        ...prev,
        pauses: [...prev.pauses, { id: `tmp-${Date.now()}`, ...value, issuedBy: "user" }],
      }),
      () => createCall(value),
    );
    setReason("");
    setCustom("");
  };
  return (
    <Section theme={theme} title="暂停与窗口">
      <Muted theme={theme}>命中范围的申请会排队，到期自动解除。</Muted>
      {status.pauses.length === 0 ? <Muted theme={theme}>当前没有暂停。</Muted> : null}
      {status.pauses.map((p) => (
        <View key={p.id} style={{ gap: 2 }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>{p.scope}</Text>
            <Muted theme={theme}>
              {formatRemaining(p.until, now)}
              {p.until ? `（到 ${formatClock(p.until)}）` : ""}
              {p.issuedBy === "bot" ? " · 总协调 bot 下发" : ""}
            </Muted>
            <Button
              theme={theme}
              label="撤销"
              onPress={() =>
                void hub.mutate<HubStatus>(
                  STATUS_KEY,
                  (prev) => ({ ...prev, pauses: prev.pauses.filter((x) => x.id !== p.id) }),
                  () => revokeCall({ id: p.id }),
                )
              }
            />
          </View>
          <Muted theme={theme}>原因：{p.reason}</Muted>
        </View>
      ))}
      <Muted theme={theme}>新建暂停</Muted>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {PAUSE_SCOPES.map((s) => (
          <Button
            key={s.value}
            theme={theme}
            label={s.label}
            active={!custom.trim() && s.value === scope}
            onPress={() => {
              setScope(s.value);
              setCustom("");
            }}
          />
        ))}
      </View>
      <Field theme={theme} value={custom} onChangeText={setCustom} placeholder="自定义范围（可选），例如 pg:5435" />
      <Field theme={theme} value={minutes} onChangeText={setMinutes} placeholder="时长（分钟）" />
      <Field theme={theme} value={reason} onChangeText={setReason} placeholder="原因" />
      {formError ? <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{formError}</Text> : null}
      <View style={{ flexDirection: "row" }}>
        <Button theme={theme} label="开始暂停" onPress={submit} />
      </View>
    </Section>
  );
}

// ---- 全局指令 -------------------------------------------------------------------------------

function DirectiveSection({ theme, hub, items }: { theme: PluginTheme; hub: Hub; items: Directive[] }) {
  const issueCall = useRpc(hubDirectiveIssueRpc);
  const confirmCall = useRpc(hubDirectiveConfirmRpc);
  const revokeCall = useRpc(hubDirectiveRevokeRpc);
  const [text, setText] = useState("");
  const [kind, setKind] = useState<"temporary" | "standing">("temporary");
  const [hours, setHours] = useState("8");
  const [formError, setFormError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const groups = groupDirectives(items);
  const setStatus = (id: string, status: Directive["status"]) => (prev: Directive[]) =>
    prev.map((d) => (d.id === id ? { ...d, status } : d));
  const submit = () => {
    const result = validateDirectiveForm({ text, kind, hours }, new Date());
    if (!result.ok) return setFormError(result.error);
    setFormError(null);
    const value = result.value;
    void hub.mutate<Directive[]>(
      DIRECTIVES_KEY,
      (prev) => [
        {
          id: `tmp-${Date.now()}`,
          text: value.text,
          scope: value.scope,
          kind: value.kind,
          expiresAt: value.expiresAt ?? null,
          issuedBy: "user",
          status: "active",
          createdAt: new Date().toISOString(),
        },
        ...prev,
      ],
      () => issueCall(value),
    );
    setText("");
  };
  const row = (d: Directive, actions: React.ReactNode) => (
    <View key={d.id} style={{ gap: 2 }}>
      <Text style={{ color: theme.colors.foreground }}>{d.text}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <Muted theme={theme}>
          {d.kind === "standing" ? "长期" : "临时"}
          {d.expiresAt ? ` · 到 ${formatClock(d.expiresAt)}` : ""}
          {d.issuedBy === "bot" ? " · 总协调 bot 下发" : " · 你下发"}
        </Muted>
        {actions}
      </View>
    </View>
  );
  const revoke = (d: Directive) => (
    <Button
      theme={theme}
      label="撤销"
      onPress={() =>
        void hub.mutate<Directive[]>(DIRECTIVES_KEY, setStatus(d.id, "revoked"), () =>
          revokeCall({ id: d.id }),
        )
      }
    />
  );
  return (
    <Section theme={theme} title="全局指令">
      <Muted theme={theme}>对所有项目的 agent 生效；myVibeBoard 外的会话通过全局指令文件同步。</Muted>
      <Muted theme={theme}>生效中</Muted>
      {groups.active.length === 0 ? <Muted theme={theme}>没有生效中的指令。</Muted> : null}
      {groups.active.map((d) => row(d, revoke(d)))}
      {groups.pending.length > 0 ? <Muted theme={theme}>待确认</Muted> : null}
      {groups.pending.map((d) =>
        row(
          d,
          <>
            <Button
              theme={theme}
              label="确认生效"
              active
              onPress={() =>
                void hub.mutate<Directive[]>(DIRECTIVES_KEY, setStatus(d.id, "active"), () =>
                  confirmCall({ id: d.id }),
                )
              }
            />
            {revoke(d)}
          </>,
        ),
      )}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Button
          theme={theme}
          label={showHistory ? "收起历史" : `历史（${groups.history.length}）`}
          onPress={() => setShowHistory((v) => !v)}
        />
      </View>
      {showHistory
        ? groups.history.map((d) =>
            row(d, <Muted theme={theme}>{d.status === "revoked" ? "已撤销" : "已过期"}</Muted>),
          )
        : null}
      <Muted theme={theme}>下发新指令</Muted>
      <Field theme={theme} value={text} onChangeText={setText} placeholder="指令内容，例如：今晚 23 点前不要跑全量测试" />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        <Button theme={theme} label="临时" active={kind === "temporary"} onPress={() => setKind("temporary")} />
        <Button theme={theme} label="长期" active={kind === "standing"} onPress={() => setKind("standing")} />
      </View>
      {kind === "temporary" ? (
        <Field theme={theme} value={hours} onChangeText={setHours} placeholder="有效期（小时）" />
      ) : null}
      {formError ? <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{formError}</Text> : null}
      <View style={{ flexDirection: "row" }}>
        <Button theme={theme} label="下发" onPress={submit} />
      </View>
    </Section>
  );
}
