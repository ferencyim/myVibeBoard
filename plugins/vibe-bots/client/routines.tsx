/* eslint-disable react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-new-object-as-prop, react-perf/jsx-no-new-array-as-prop -- Small plugin screen; handlers and theme styles depend on each row. */
/* eslint-disable complexity -- Form state covers all routine fields. */
import { usePaseo, useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useCallback, useState, type PropsWithChildren } from "react";
import { Text, View } from "react-native";
import { z } from "zod";
import { botsListRpc } from "../shared/rpc";
import { routinesListRpc, routinesCreateRpc, routinesUpdateRpc, routinesPauseRpc, routinesResumeRpc, routinesDeleteRpc, routinesRunNowRpc } from "../shared/routines-rpc";
import { nextRoutineTime } from "../shared/vibe/contract/routine-schedule";
import { Button, Feedback, Field, Page } from "./ui";

type Routine = z.infer<typeof routinesListRpc.output>["routines"][number];
type Schedule = Routine["schedule"];
const systemSchema = z.object({ routines: z.array(z.object({ id: z.string(), title: z.string(), projectId: z.string(), projectName: z.string(), schedule: z.object({ kind: z.literal("cron"), expression: z.string() }).nullable(), scheduleText: z.string(), timezone: z.string(), nextRunAt: z.string().nullable(), paused: z.boolean(), lastRunAt: z.string().nullable(), lastStatus: z.string().nullable(), lastError: z.string().nullable(), editKey: z.string() })) });
type SystemRoutine = z.infer<typeof systemSchema>["routines"][number];
const dateText = (value: string | null) => value ? new Date(value).toLocaleString() : "—";
const scheduleText = (schedule: Schedule) => schedule.kind === "cron" ? `Cron ${schedule.expression}` : `每 ${schedule.minutes} 分钟`;

export function RoutinesScreen(props: PluginScreenProps) { return <RoutineContent {...props} />; }
/** Embeddable body for the bot profile slot. Render within the plugin RPC context. */
export function BotRoutines(props: Pick<PluginScreenProps, "theme" | "navigation"> & { botId: string }) { return <RoutineContent {...props} botId={props.botId} />; }

function RoutineBody({ theme, embedded, children }: PropsWithChildren<{ theme: PluginScreenProps["theme"]; embedded: boolean }>) { return embedded ? <View style={{ gap: 16 }}>{children}</View> : <Page theme={theme}>{children}</Page>; }

function RoutineContent({ theme, navigation, botId }: Pick<PluginScreenProps, "theme" | "navigation"> & { botId?: string }) {
  const list = useRpc(routinesListRpc), botsList = useRpc(botsListRpc);
  const create = useRpc(routinesCreateRpc), update = useRpc(routinesUpdateRpc);
  const pause = useRpc(routinesPauseRpc), resume = useRpc(routinesResumeRpc), remove = useRpc(routinesDeleteRpc), runNow = useRpc(routinesRunNowRpc);
  const paseo = usePaseo(), queryClient = useQueryClient();
  const routines = useQuery({ queryKey: ["vibe-bots", "routines", botId], queryFn: () => list(botId ? { botId } : {}), refetchInterval: 15000 });
  const bots = useQuery({ queryKey: ["vibe-bots", "list"], queryFn: () => botsList({}) });
  const systems = useQuery({ queryKey: ["vibe-maintain", "system-routines"], queryFn: async () => systemSchema.parse(await paseo.plugins.invoke("vibe-maintain", "maintain.system_routines", {})), enabled: !botId, retry: false, refetchInterval: 15000 });
  const [editing, setEditing] = useState<Routine | "new" | null>(null);
  const [view, setView] = useState<"list" | "week">("list");
  const [week, setWeek] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const run = useCallback(async (action: () => Promise<unknown>) => {
    setBusy(true); setError("");
    try { await action(); await queryClient.invalidateQueries({ queryKey: ["vibe-bots", "routines"] }); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }, [queryClient]);
  if (editing) return <RoutineForm embedded={!!botId} theme={theme} routine={editing === "new" ? null : editing} botId={botId} bots={bots.data?.bots ?? []} busy={busy} error={error} onCancel={() => setEditing(null)} onSave={(input) => { void run(async () => { if (editing === "new") await create(input); else { const { botId: _botId, ...patch } = input; await update({ id: editing.id, patch }); } setEditing(null); }); }} />;
  const items = [...(routines.data?.routines ?? [])].sort((a, b) => a.botId.localeCompare(b.botId));
  const systemItems = systems.data?.routines ?? [];
  const text = { color: theme.colors.foreground }, muted = { color: theme.colors.foregroundMuted };
  return <RoutineBody theme={theme} embedded={!!botId}>
    {botId ? null : <Text style={{ ...text, fontSize: 18 }}>例程</Text>}
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}><Button theme={theme} label={view === "list" ? "● 列表" : "列表"} onPress={() => setView("list")} /><Button theme={theme} label={view === "week" ? "● 周历" : "周历"} onPress={() => setView("week")} /><Button theme={theme} label="新建例程" onPress={() => setEditing("new")} /></View>
    <Feedback theme={theme} error={error || routines.error || bots.error || systems.error} message={routines.isLoading ? "正在加载例程…" : undefined} />
    {view === "week" ? <WeekView theme={theme} routines={items} systems={systemItems} week={week} setWeek={setWeek} onEdit={setEditing} onSystem={(item) => navigation?.openPluginScreen?.({ pluginId: "vibe-maintain", screenId: "main", params: { rule: item.editKey } })} /> : <>
      {items.map((item, index) => <Fragment key={item.id}>{(index === 0 || items[index - 1].botId !== item.botId) ? <Text style={{ ...text, fontSize: 16 }}>{bots.data?.bots.find((bot) => bot.id === item.botId)?.name ?? item.botId}</Text> : null}<View style={{ gap: 8, paddingVertical: 12, borderBottomWidth: 1, borderColor: theme.colors.border }}>
        <Text style={text}>{item.title}</Text>
        <Text style={muted}>{item.paused ? "已暂停" : "运行中"} · {scheduleText(item.schedule)} · {item.timezone}</Text>
        <Text style={muted}>下次：{dateText(item.nextRunAt)} · 最近：{item.lastStatus ?? "尚未运行"}{item.lastError ? ` · ${item.lastError}` : ""}</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}><Button theme={theme} label={item.paused ? "恢复" : "暂停"} disabled={busy} onPress={() => { void run(() => item.paused ? resume({ id: item.id }) : pause({ id: item.id })); }} /><Button theme={theme} label="立即运行" disabled={busy} onPress={() => { void run(() => runNow({ id: item.id })); }} /><Button theme={theme} label="编辑" disabled={busy} onPress={() => setEditing(item)} /><Button theme={theme} label="删除" disabled={busy} onPress={() => setConfirmDelete(item.id)} /></View>
        {confirmDelete === item.id ? <View style={{ flexDirection: "row", gap: 8 }}><Text style={text}>确认删除此例程？</Text><Button theme={theme} label="确认删除" disabled={busy} onPress={() => { void run(async () => { await remove({ id: item.id }); setConfirmDelete(null); }); }} /><Button theme={theme} label="取消" onPress={() => setConfirmDelete(null)} /></View> : null}
      </View></Fragment>)}
      {systemItems.length ? <Text style={{ ...text, fontSize: 16 }}>系统例程</Text> : null}
      {systemItems.map((item) => <View key={item.id} style={{ gap: 8, paddingVertical: 12, borderBottomWidth: 1, borderColor: theme.colors.border }}><Text style={text}>{item.projectName} · {item.title}</Text><Text style={muted}>{item.paused ? "已暂停" : "运行中"} · {item.scheduleText} · 下次：{dateText(item.nextRunAt)} · 最近：{item.lastStatus ?? "尚未运行"}</Text><Button theme={theme} label="打开维护规则" disabled={!navigation?.openPluginScreen} onPress={() => navigation?.openPluginScreen?.({ pluginId: "vibe-maintain", screenId: "main", params: { rule: item.editKey } })} /></View>)}
      {!items.length && !systemItems.length && !routines.isLoading ? <Text style={muted}>还没有例程。</Text> : null}
    </>}
  </RoutineBody>;
}

function WeekView({ theme, routines, systems, week, setWeek, onEdit, onSystem }: { theme: PluginScreenProps["theme"]; routines: Routine[]; systems: SystemRoutine[]; week: number; setWeek(value: number): void; onEdit(value: Routine): void; onSystem(value: SystemRoutine): void }) {
  const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - (start.getDay() + 6) % 7 + week * 7);
  const end = new Date(start); end.setDate(end.getDate() + 7);
  let truncated = false;
  const occurrences = [...routines.filter((r) => !r.paused).map((r) => ({ id: r.id, title: r.title, schedule: r.schedule, timezone: r.timezone, anchor: r.nextRunAt ?? r.createdAt, action: () => onEdit(r) })), ...systems.filter((r) => !r.paused && r.schedule).map((r) => ({ id: r.id, title: `系统 · ${r.title}`, schedule: r.schedule!, timezone: r.timezone, anchor: r.nextRunAt, action: () => onSystem(r) }))].flatMap((item) => {
    const result: { id: string; title: string; at: Date; action(): void }[] = [];
    try { let cursor = new Date(start.getTime() - 1); if (item.schedule.kind === "interval" && item.anchor) { const anchor = new Date(item.anchor).getTime(); const period = item.schedule.minutes * 60000; cursor = new Date(anchor + Math.ceil((start.getTime() - anchor) / period) * period - period); } for (let i = 0; i < 1000; i++) { const at = nextRoutineTime(item.schedule, item.timezone, cursor); if (at >= end || at <= cursor) break; result.push({ ...item, at }); cursor = at; if (i === 999) truncated = true; } } catch { /* Invalid schedules are surfaced by the editor. */ }
    return result;
  });
  return <>{truncated ? <Text style={{ color: theme.colors.foregroundMuted }}>高频例程的周历最多显示前 1000 次，请查看列表中的下次运行时间。</Text> : null}<View style={{ flexDirection: "row", gap: 8 }}><Button theme={theme} label="上一周" onPress={() => setWeek(week - 1)} /><Button theme={theme} label="本周" onPress={() => setWeek(0)} /><Button theme={theme} label="下一周" onPress={() => setWeek(week + 1)} /></View>{Array.from({ length: 7 }, (_, i) => { const day = new Date(start); day.setDate(day.getDate() + i); const next = new Date(day); next.setDate(next.getDate() + 1); return <View key={day.toISOString()} style={{ gap: 6, paddingVertical: 8, borderBottomWidth: 1, borderColor: theme.colors.border }}><Text style={{ color: theme.colors.foreground }}>{day.toLocaleDateString()}</Text>{occurrences.filter((item) => item.at >= day && item.at < next).sort((a, b) => a.at.getTime() - b.at.getTime()).map((item) => <Button key={`${item.id}-${item.at.toISOString()}`} theme={theme} label={`${item.at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${item.title}`} onPress={item.action} />)}</View>; })}</>;
}

type FormInput = z.input<typeof routinesCreateRpc.input>;
function RoutineForm({ theme, embedded, routine, botId, bots, busy, error, onCancel, onSave }: { embedded: boolean; theme: PluginScreenProps["theme"]; routine: Routine | null; botId?: string; bots: { id: string; name: string }[]; busy: boolean; error: string; onCancel(): void; onSave(input: FormInput): void }) {
  const [selectedBot, setBot] = useState(routine?.botId ?? botId ?? bots[0]?.id ?? "");
  const [title, setTitle] = useState(routine?.title ?? "");
  const [kind, setKind] = useState<"cron" | "interval">(routine?.schedule.kind ?? "cron");
  const [cron, setCron] = useState(routine?.schedule.kind === "cron" ? routine.schedule.expression : "0 9 * * *");
  const [minutes, setMinutes] = useState(routine?.schedule.kind === "interval" ? String(routine.schedule.minutes) : "60");
  const [timezone, setTimezone] = useState(routine?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [prompt, setPrompt] = useState(routine?.prompt ?? "");
  const [target, setTarget] = useState<"main" | "new_thread">(routine?.target ?? "main");
  const [quiet, setQuiet] = useState(routine?.quiet ?? false);
  const [missedPolicy, setMissedPolicy] = useState<"skip" | "run_once">(routine?.missedPolicy ?? "skip");
  const [promptPage, setPromptPage] = useState(false);
  if (promptPage) return <RoutineBody theme={theme} embedded={embedded}><Button theme={theme} label="返回例程" onPress={() => setPromptPage(false)} /><Field theme={theme} label="提示词" value={prompt} onChangeText={setPrompt} multiline /><Button theme={theme} label="完成" onPress={() => setPromptPage(false)} /></RoutineBody>;
  return <RoutineBody theme={theme} embedded={embedded}>
    <Text style={{ color: theme.colors.foreground, fontSize: 18 }}>{routine ? "编辑例程" : "新建例程"}</Text>
    <SettingsSelect label="bot" value={selectedBot} options={bots.map((bot) => ({ label: bot.name, value: bot.id }))} onValueChange={setBot} disabled={!!routine || !!botId} />
    <Field theme={theme} label="名称" value={title} onChangeText={setTitle} />
    <SettingsSelect<"cron" | "interval"> label="调度方式" value={kind} options={[{ label: "Cron", value: "cron" }, { label: "间隔", value: "interval" }]} onValueChange={setKind} />
    {kind === "cron" ? <Field theme={theme} label="Cron 表达式" value={cron} onChangeText={setCron} /> : <Field theme={theme} label="间隔（分钟）" value={minutes} onChangeText={setMinutes} />}
    <Field theme={theme} label="时区（IANA）" value={timezone} onChangeText={setTimezone} />
    <Button theme={theme} label={prompt ? "编辑提示词" : "填写提示词"} onPress={() => setPromptPage(true)} />
    <SettingsSelect<"main" | "new_thread"> label="发送到" value={target} options={[{ label: "主对话", value: "main" }, { label: "新旁线程", value: "new_thread" }]} onValueChange={setTarget} />
    <SettingsSwitch label="静默（仅失败时通知）" value={quiet} onValueChange={setQuiet} />
    <SettingsSelect<"skip" | "run_once"> label="错过运行" value={missedPolicy} options={[{ label: "跳过", value: "skip" }, { label: "补运行一次", value: "run_once" }]} onValueChange={setMissedPolicy} />
    <Button theme={theme} label={busy ? "正在保存…" : "保存"} disabled={busy || !selectedBot || !title.trim() || !prompt.trim() || !timezone.trim() || (kind === "interval" && (!Number.isInteger(Number(minutes)) || Number(minutes) < 1))} onPress={() => onSave({ botId: selectedBot, title, schedule: kind === "cron" ? { kind, expression: cron } : { kind, minutes: Number(minutes) }, timezone, prompt, target, quiet, missedPolicy })} />
    <Button theme={theme} label="取消" disabled={busy} onPress={onCancel} /><Feedback theme={theme} error={error} />
  </RoutineBody>;
}
