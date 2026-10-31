/* eslint-disable react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-new-object-as-prop, react-perf/jsx-no-new-array-as-prop -- Small plugin screen; handlers depend on the current bot. */
import type { PluginTheme } from "@getpaseo/plugin";
import { useAgent, useRpc, type PluginScreenProps, type PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { Modal, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { botsListRpc, botsArchiveRpc, projectDefaultBotSetRpc, memoriesAddRpc, memoriesUpdateRpc, memoriesRemoveRpc } from "../shared/rpc";
import type { BotMemory } from "../shared/vibe/contract/bots";
import { ModelSection } from "./model-section";
import { BotRoutines } from "./routines";
import {
  AVATAR_HUES, INSTRUCTIONS_DEBOUNCE_MS, INSTRUCTIONS_MAX, NAME_MAX, PERMISSION_LABELS, TITLE_MAX,
  applyPatchToList, backupSummary, canAddBackupModel, findBotForAgent, notificationsSummary, validateTextDraft, widensPermission,
  type PermissionMode,
} from "./profile-mapping";
import { AvatarButton, AvatarPopover, Caption, ControlRow, ErrorLine, Field, Group, KitProvider, NavRow, OutlineButton, SettingsBody, SubPageHeader, SwitchRow, TextArea, ValueRow, useKit } from "./settings-kit";
import { BOT_LIST_KEY, useBotSaver, useTextDraft, type BotView } from "./use-bot-saver";
import { useBotConversation } from "./use-bot-conversation";

type Nav = PluginScreenProps["navigation"];
type Page = "root" | "permissions" | "notifications" | "backups" | "advanced" | "memories" | "routines";
type Saver = ReturnType<typeof useBotSaver>;
interface LoaderProps { theme: PluginTheme; navigation?: Nav; tab?: PluginAgentPanelProps["tab"]; pick(bots: readonly BotView[]): BotView | undefined; missing: string }

/** Cached list first: an already-loaded bot list renders at once and refreshes in the background. */
function useBotList() {
  const list = useRpc(botsListRpc);
  return useQuery({ queryKey: BOT_LIST_KEY, queryFn: () => list({}), staleTime: 10_000, refetchInterval: 15000 });
}

function ProfileLoader({ theme, navigation, tab, pick, missing }: LoaderProps) {
  const query = useBotList();
  const bot = pick(query.data?.bots ?? []);
  const retry = useCallback(() => { void query.refetch(); }, [query]);
  if (bot) return <Profile key={bot.id} theme={theme} navigation={navigation} tab={tab} bot={bot} />;
  return <KitProvider theme={theme}><SettingsBody>
    {query.isLoading ? <Skeleton /> : <>
      <Caption>{query.error ? `加载失败：${String(query.error)}` : missing}</Caption>
      <View><OutlineButton label="重试" onPress={retry} /></View>
    </>}
  </SettingsBody></KitProvider>;
}

export function BotProfilePanel(props: PluginAgentPanelProps) {
  const agentId = props.params.agentId;
  const botId = useAgent(agentId, (agent) => agent.labels["vibe.bot"]);
  const pick = useCallback((bots: readonly BotView[]) => findBotForAgent(bots, agentId, botId ?? undefined), [agentId, botId]);
  return <ProfileLoader theme={props.theme} navigation={props.navigation} tab={props.tab} pick={pick} missing="此会话没有关联的 bot。" />;
}

export function BotProfileScreen(props: PluginScreenProps) {
  const botId = props.params.botId;
  const pick = useCallback((bots: readonly BotView[]) => bots.find((item) => item.id === botId), [botId]);
  return <ProfileLoader theme={props.theme} navigation={props.navigation} pick={pick} missing="找不到此 bot，可能已被归档。" />;
}

function Skeleton() {
  const { theme } = useKit();
  const block = (width: number | `${number}%`, height: number) => ({ width, height, borderRadius: 8, backgroundColor: theme.colors.surface1 });
  return <View accessibilityLabel="正在加载" style={{ gap: 16, alignItems: "center" }}>
    <View style={{ ...block(62, 62), borderRadius: 31 }} />
    <View style={block("100%", 38)} /><View style={block("100%", 38)} /><View style={block("100%", 120)} /><View style={block("100%", 120)} />
  </View>;
}

interface ProfileProps { theme: PluginTheme; navigation?: Nav; tab?: PluginAgentPanelProps["tab"]; bot: BotView }

function Profile({ theme, navigation, tab, bot }: ProfileProps) {
  const saver = useBotSaver(bot.id);
  const [page, setPage] = useState<Page>("root");
  const [memoryDirty, setMemoryDirty] = useState(false);
  useEffect(() => { tab?.setModified(saver.pending > 0 || memoryDirty); }, [tab, saver.pending, memoryDirty]);
  const back = useCallback(() => setPage("root"), []);
  let content: ReactNode;
  if (page === "memories") content = <MemoryPage bot={bot} onBack={back} onDirtyChange={setMemoryDirty} />;
  else if (page === "routines") content = <><SubPageHeader title="例程" onBack={back} /><SettingsBody><BotRoutines theme={theme} navigation={navigation} botId={bot.id} /></SettingsBody></>;
  else if (page === "permissions") content = <PermissionsPage bot={bot} saver={saver} onBack={back} />;
  else if (page === "notifications") content = <NotificationsPage bot={bot} saver={saver} onBack={back} />;
  else if (page === "backups") content = <BackupsPage bot={bot} saver={saver} onBack={back} />;
  else if (page === "advanced") content = <AdvancedPage bot={bot} navigation={navigation} onBack={back} />;
  else content = <RootPage bot={bot} saver={saver} onNavigate={setPage} />;
  return <KitProvider theme={theme}>{content}</KitProvider>;
}

function RootPage({ bot, saver, onNavigate }: { bot: BotView; saver: Saver; onNavigate(page: Page): void }) {
  const { save } = saver;
  const [avatarOpen, setAvatarOpen] = useState(false);
  const toggleAvatar = useCallback(() => setAvatarOpen((open) => !open), []);
  const pickHue = useCallback((hue: number) => { void save({ avatarHue: hue }); }, [save]);
  const saveName = useCallback((value: string) => { void save({ name: value.trim() }); }, [save]);
  const saveTitle = useCallback((value: string) => { void save({ title: value }); }, [save]);
  const saveInstructions = useCallback((value: string) => { void save({ instructions: value }); }, [save]);
  const acceptName = useCallback((value: string) => !!value.trim() && value.length <= NAME_MAX, []);
  const acceptTitle = useCallback((value: string) => value.length <= TITLE_MAX, []);
  const acceptInstructions = useCallback((value: string) => value.length <= INSTRUCTIONS_MAX, []);
  const nameDraft = useTextDraft(bot.name, saveName, { accept: acceptName });
  const titleDraft = useTextDraft(bot.title, saveTitle, { accept: acceptTitle });
  const instructionsDraft = useTextDraft(bot.instructions, saveInstructions, { debounceMs: INSTRUCTIONS_DEBOUNCE_MS, accept: acceptInstructions });
  const errors = validateTextDraft({ name: nameDraft.draft, title: titleDraft.draft, instructions: instructionsDraft.draft });
  // An emptied name falls back to the saved one when the field loses focus.
  const blurName = useCallback(() => { if (!nameDraft.draft.trim()) nameDraft.reset(); else nameDraft.flush(); }, [nameDraft]);
  const go = useMemo(() => ({
    backups: () => onNavigate("backups"), memories: () => onNavigate("memories"), routines: () => onNavigate("routines"),
    permissions: () => onNavigate("permissions"), notifications: () => onNavigate("notifications"), advanced: () => onNavigate("advanced"),
  }), [onNavigate]);
  return <SettingsBody>
    <AvatarButton name={bot.name} hue={bot.avatarHue} onPress={toggleAvatar} />
    {avatarOpen ? <AvatarPopover hue={bot.avatarHue} hues={AVATAR_HUES} onPick={pickHue} /> : null}
    <Field label="名字" value={nameDraft.draft} onChangeText={nameDraft.change} onBlur={blurName} maxLength={NAME_MAX} error={errors.name} />
    <Field label="头衔" value={titleDraft.draft} onChangeText={titleDraft.change} onBlur={titleDraft.flush} placeholder="这个 bot 负责什么" maxLength={TITLE_MAX} error={errors.title} />
    <TextArea label="角色说明" value={instructionsDraft.draft} onChangeText={instructionsDraft.change} onBlur={instructionsDraft.flush} placeholder="这个 bot 的职责、风格和约定" error={errors.instructions} />
    <ModelSection bot={bot} save={save} />
    <Group><NavRow icon="ArrowLeftRight" label="备用模型" value={backupSummary(bot.backupModels.length)} onPress={go.backups} /></Group>
    <Group>
      <NavRow icon="Brain" label="记忆" value={`${bot.memories.length} 条`} onPress={go.memories} />
      <NavRow icon="Clock" label="例程" onPress={go.routines} />
    </Group>
    <Group title="规则">
      <NavRow icon="Shield" label="权限" value={PERMISSION_LABELS[bot.permissionMode]} onPress={go.permissions} />
      <NavRow icon="Bell" label="通知" value={notificationsSummary(bot.notifications)} onPress={go.notifications} />
      <NavRow icon="SlidersHorizontal" label="高级" onPress={go.advanced} />
    </Group>
    <ErrorLine error={saver.error} />
  </SettingsBody>;
}

function permissionCaption(mode: PermissionMode) {
  if (mode === "accept-edits") return "接受编辑：工作区内的编辑自动接受，其余操作先询问你。";
  if (mode === "auto") return "自动：大部分操作自动进行，高风险操作仍会询问你。";
  return "完全访问：不经询问直接行动，仅在它向你提问时才停下。";
}

const modalContent = { padding: 16, gap: 16 } as const;

function PermissionsPage({ bot, saver, onBack }: { bot: BotView; saver: Saver; onBack(): void }) {
  const { save } = saver;
  const [confirming, setConfirming] = useState<PermissionMode | null>(null);
  const options = useMemo(() => (Object.keys(PERMISSION_LABELS) as PermissionMode[]).map((value) => ({ label: PERMISSION_LABELS[value], value })), []);
  const change = useCallback((next: PermissionMode) => {
    if (next === bot.permissionMode) return;
    if (widensPermission(bot.permissionMode, next)) setConfirming(next);
    else void save({ permissionMode: next });
  }, [bot.permissionMode, save]);
  const confirm = useCallback(() => { if (confirming) void save({ permissionMode: confirming }); setConfirming(null); }, [confirming, save]);
  const cancel = useCallback(() => setConfirming(null), []);
  const closeModal = useCallback((open: boolean) => { if (!open) setConfirming(null); }, []);
  return <>
    <SubPageHeader title="权限" onBack={onBack} />
    <SettingsBody>
      <Group><ControlRow label="访问级别"><SettingsSelect<PermissionMode> inline label="访问级别" value={bot.permissionMode} options={options} onValueChange={change} /></ControlRow></Group>
      <Caption>{permissionCaption(bot.permissionMode)}</Caption>
      <ErrorLine error={saver.error} />
    </SettingsBody>
    {confirming ? <Modal title="放宽权限？" open onOpenChange={closeModal}><Modal.Content contentContainerStyle={modalContent}>
      <Caption>{`将此 bot 的访问级别改为「${PERMISSION_LABELS[confirming]}」后，它可以在更少确认的情况下读写文件、运行命令。一次误解或恶意内容就可能触及你的文件。`}</Caption>
      <OutlineButton label={`改为${PERMISSION_LABELS[confirming]}`} onPress={confirm} />
      <OutlineButton label="取消" onPress={cancel} />
    </Modal.Content></Modal> : null}
  </>;
}

function NotificationsPage({ bot, saver, onBack }: { bot: BotView; saver: Saver; onBack(): void }) {
  const { save } = saver;
  const n = bot.notifications;
  const setEnabled = useCallback((enabled: boolean) => { void save({ notifications: { ...n, enabled } }); }, [save, n]);
  const setCompleted = useCallback((completed: boolean) => { void save({ notifications: { ...n, completed } }); }, [save, n]);
  const setFailed = useCallback((failed: boolean) => { void save({ notifications: { ...n, failed } }); }, [save, n]);
  return <>
    <SubPageHeader title="通知" onBack={onBack} />
    <SettingsBody>
      <Group>
        <SwitchRow icon="Bell" label="通知" value={n.enabled} onValueChange={setEnabled} />
        <SwitchRow label="完成时通知" value={n.completed} disabled={!n.enabled} onValueChange={setCompleted} />
        <SwitchRow label="失败时通知" value={n.failed} disabled={!n.enabled} onValueChange={setFailed} />
      </Group>
      <ErrorLine error={saver.error} />
    </SettingsBody>
  </>;
}

function BackupsPage({ bot, saver, onBack }: { bot: BotView; saver: Saver; onBack(): void }) {
  const { save } = saver;
  const provider = bot.provider ?? "";
  const model = bot.model ?? "";
  const canAdd = canAddBackupModel(bot.backupModels, provider, model, bot.thinking);
  const add = useCallback(() => { void save({ backupModels: [...bot.backupModels, { provider, model, thinking: bot.thinking }] }); }, [save, bot.backupModels, provider, model, bot.thinking]);
  const removeAt = useCallback((index: number) => { void save({ backupModels: bot.backupModels.filter((_, i) => i !== index) }); }, [save, bot.backupModels]);
  return <>
    <SubPageHeader title="备用模型" onBack={onBack} />
    <SettingsBody>
      <Caption>主模型不可用或额度用尽时，按下面的顺序依次改用备用模型。</Caption>
      <Group title="顺序">
        {bot.backupModels.map((backup, index) => <BackupRow key={`${backup.provider}:${backup.model}:${backup.thinking}`} index={index} label={`${backup.provider} / ${backup.model}${backup.thinking ? ` · ${backup.thinking}` : ""}`} onRemove={removeAt} />)}
        {bot.backupModels.length === 0 ? <ValueRow label="未设置顺序" value="使用主模型" /> : null}
      </Group>
      <View><OutlineButton label="将当前模型加入备用" disabled={!canAdd} onPress={add} /></View>
      <ErrorLine error={saver.error} />
    </SettingsBody>
  </>;
}

function BackupRow({ index, label, onRemove }: { index: number; label: string; onRemove(index: number): void }) {
  const remove = useCallback(() => onRemove(index), [onRemove, index]);
  return <ControlRow label={label}><OutlineButton label="移除" onPress={remove} /></ControlRow>;
}

function AdvancedPage({ bot, navigation, onBack }: { bot: BotView; navigation?: Nav; onBack(): void }) {
  const client = useQueryClient();
  const setDefault = useRpc(projectDefaultBotSetRpc);
  const archive = useRpc(botsArchiveRpc);
  const openAgent = useCallback((id: string) => navigation?.openAgent({ agentId: id }), [navigation]);
  const conversation = useBotConversation(bot.id, openAgent);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const projectId = bot.projectId;
  const makeDefault = useCallback(() => {
    if (!projectId) return;
    const before = client.getQueryData<{ bots: BotView[] }>(BOT_LIST_KEY);
    client.setQueryData<{ bots: BotView[] }>(BOT_LIST_KEY, (list) => list && { bots: applyPatchToList(list.bots, bot.id, { isDefault: true }) });
    setError("");
    void setDefault({ projectId, botId: bot.id }).catch((reason: unknown) => {
      if (before) client.setQueryData(BOT_LIST_KEY, before);
      setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => { void client.invalidateQueries({ queryKey: ["vibe-bots"] }); });
  }, [client, setDefault, projectId, bot.id]);
  const doArchive = useCallback(() => {
    setBusy(true); setError("");
    void archive({ id: bot.id }).then(() => { setConfirmArchive(false); void client.invalidateQueries({ queryKey: ["vibe-bots"] }); })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setBusy(false));
  }, [archive, bot.id, client, navigation]);
  const askArchive = useCallback(() => setConfirmArchive(true), []);
  const cancelArchive = useCallback(() => setConfirmArchive(false), []);
  const closeModal = useCallback((open: boolean) => { if (!open) setConfirmArchive(false); }, []);
  return <>
    <SubPageHeader title="高级" onBack={onBack} />
    <SettingsBody>
      <Group>
        <ControlRow label="主对话"><OutlineButton label={conversation.label} disabled={conversation.disabled || !navigation} onPress={conversation.open} /></ControlRow>
        {projectId ? <SwitchRow label="默认项目 bot" hint="环境故障通知与完成后的整理交给默认 bot。" value={bot.isDefault} disabled={bot.isDefault} onValueChange={makeDefault} /> : null}
      </Group>
      <ErrorLine error={conversation.error} />
      <Group title="危险操作">
        <ControlRow label="归档 bot" hint="归档后不再出现在列表里。"><OutlineButton danger label="归档" onPress={askArchive} /></ControlRow>
      </Group>
      <ErrorLine error={error} />
    </SettingsBody>
    {confirmArchive ? <Modal title={`归档「${bot.name}」？`} open onOpenChange={closeModal}><Modal.Content contentContainerStyle={modalContent}>
      <Caption>归档后这个 bot 会从列表中消失，它的对话和记忆不会被删除。</Caption>
      <OutlineButton danger label={busy ? "正在归档…" : "确认归档"} disabled={busy} onPress={doArchive} />
      <OutlineButton label="取消" disabled={busy} onPress={cancelArchive} />
    </Modal.Content></Modal> : null}
  </>;
}

function MemoryPage({ bot, onBack, onDirtyChange }: { bot: BotView; onBack(): void; onDirtyChange(dirty: boolean): void }) {
  const add = useRpc(memoriesAddRpc);
  const update = useRpc(memoriesUpdateRpc);
  const remove = useRpc(memoriesRemoveRpc);
  const client = useQueryClient();
  const [editing, setEditing] = useState<BotMemory | "new" | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { onDirtyChange(editing !== null && text !== (editing === "new" ? "" : editing.text)); }, [editing, text, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  const run = useCallback(async (action: () => Promise<unknown>) => {
    setBusy(true); setError("");
    try { await action(); await client.invalidateQueries({ queryKey: ["vibe-bots"] }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }, [client]);
  const save = useCallback(() => {
    if (!editing) return;
    void run(async () => {
      if (editing === "new") await add({ botId: bot.id, text });
      else await update({ botId: bot.id, id: editing.id, text });
      setEditing(null);
    });
  }, [editing, run, add, update, bot.id, text]);
  const closeEditor = useCallback(() => setEditing(null), []);
  const startNew = useCallback(() => { setText(""); setEditing("new"); }, []);
  const edit = useCallback((memory: BotMemory) => { setText(memory.text); setEditing(memory); }, []);
  const togglePin = useCallback((memory: BotMemory) => { void run(() => update({ botId: bot.id, id: memory.id, pinned: !memory.pinned })); }, [run, update, bot.id]);
  const removeMemory = useCallback((memory: BotMemory) => { void run(() => remove({ botId: bot.id, id: memory.id })); }, [run, remove, bot.id]);
  if (editing) return <>
    <SubPageHeader title={editing === "new" ? "添加记忆" : "编辑记忆"} onBack={closeEditor} />
    <SettingsBody>
      <TextArea label="记忆内容（个人偏好与经验）" value={text} onChangeText={setText} height={240} />
      <View style={{ flexDirection: "row", gap: 8 }}><OutlineButton label={busy ? "正在保存…" : "保存"} disabled={busy || !text.trim()} onPress={save} /><OutlineButton label="取消" disabled={busy} onPress={closeEditor} /></View>
      <ErrorLine error={error} />
    </SettingsBody>
  </>;
  return <>
    <SubPageHeader title="记忆" onBack={onBack} />
    <SettingsBody>
      <Caption>个人记忆只存偏好与经验。项目记忆仍以 AGENTS.md / CLAUDE.md 为准。</Caption>
      {bot.memories.length ? <Group>{bot.memories.map((memory) => <MemoryRow key={memory.id} memory={memory} busy={busy} onEdit={edit} onPin={togglePin} onRemove={removeMemory} />)}</Group> : <Caption>还没有长期记忆。</Caption>}
      <View><OutlineButton label="添加记忆" disabled={busy} onPress={startNew} /></View>
      <ErrorLine error={error} />
    </SettingsBody>
  </>;
}

interface MemoryRowProps { memory: BotMemory; busy: boolean; onEdit(memory: BotMemory): void; onPin(memory: BotMemory): void; onRemove(memory: BotMemory): void }
function MemoryRow({ memory, busy, onEdit, onPin, onRemove }: MemoryRowProps) {
  const { styles } = useKit();
  const edit = useCallback(() => onEdit(memory), [onEdit, memory]);
  const pin = useCallback(() => onPin(memory), [onPin, memory]);
  const removeIt = useCallback(() => onRemove(memory), [onRemove, memory]);
  return <View style={{ padding: 12, gap: 8 }}>
    <Text style={styles.rowLabel} numberOfLines={3}>{memory.pinned ? "★ " : ""}{memory.text}</Text>
    <Text style={styles.rowHint}>{memory.source === "bot" ? "bot 记录" : "你添加的"} · {memory.updatedAt}</Text>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <OutlineButton label="编辑" disabled={busy} onPress={edit} />
      <OutlineButton label={memory.pinned ? "取消置顶" : "置顶"} disabled={busy} onPress={pin} />
      <OutlineButton danger label="删除" disabled={busy} onPress={removeIt} />
    </View>
  </View>;
}
