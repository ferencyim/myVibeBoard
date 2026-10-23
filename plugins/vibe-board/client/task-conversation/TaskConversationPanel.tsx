import { type PluginConversationPanelProps, usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, Text, TextInput, View, type TextStyle } from "react-native";
import {
  taskConversationCommandRpc,
  taskConversationPanelRpc,
  taskConversationSelectRoleRpc,
} from "../../shared/task-conversation";
import {
  MODEL_ROLES,
  OPTIONAL_TASK_ROLES,
  TASK_PHASE_LABELS,
  type TaskAction,
  type TaskArtifact,
  type ModelRole,
  type TaskRoleSelection,
} from "../../shared/vibe/contract";
import { HostProvider } from "../common/ctx";
import { Btn } from "../common/ui";
import {
  actionAvailable,
  resolveArtifactChatSourceKey,
  ARTIFACT_LABELS,
  cacheRemainingSeconds,
  formatCountdown,
  newCommandRequestId,
  loadArtifactContent,
  recipientMember,
  recipientOptions,
  roleConfigurationAllowed,
  selectTaskRecipient,
  ROLE_LABELS,
  suggestedRole,
  TASK_ACTIONS,
} from "./logic";

function failure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function TaskConversationPanel(props: PluginConversationPanelProps) {
  const host = useMemo(
    () => ({ theme: props.theme, compact: props.layout.compact }),
    [props.theme, props.layout.compact],
  );
  return (
    <HostProvider value={host}>
      <PanelContent {...props} />
    </HostProvider>
  );
}

function usePanel(props: PluginConversationPanelProps) {
  const { theme, layout, workspaceId, conversationId, navigation } = props;
  const paseo = usePaseo();
  const panelRpc = useRpc(taskConversationPanelRpc);
  const commandRpc = useRpc(taskConversationCommandRpc);
  const selectRoleRpc = useRpc(taskConversationSelectRoleRpc);
  const queryClient = useQueryClient();
  const queryKey = ["task-conversation-panel", workspaceId, conversationId];
  const query = useQuery({
    queryKey,
    queryFn: () => panelRpc({ workspaceId, conversationId }),
    refetchInterval: 3000,
  });
  const snapshot = query.data;
  const phase = snapshot?.task?.phase;
  const [selectedId, setSelectedId] = useState<string>();
  const [roleFocus, setRoleFocus] = useState<ModelRole>();
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now);
  const currentOption = snapshot?.recipients.find((option) => {
    const selected = props.recipient;
    if (selected?.memberId) return selected.memberId === option.recipient.memberId;
    return (
      selected &&
      !option.recipient.memberId &&
      selected.role === option.recipient.role &&
      selected.presetId === option.recipient.presetId &&
      selected.config.provider === option.recipient.config.provider &&
      selected.config.model === option.recipient.config.model
    );
  });
  const activeId = props.recipient
    ? currentOption?.id
    : (selectedId ?? snapshot?.suggestedRecipientId);
  const activeRole =
    snapshot?.recipients.find((option) => option.id === activeId)?.role ?? suggestedRole(phase);
  const focusedRole = roleFocus ?? activeRole;
  const member = snapshot ? recipientMember(snapshot, activeId) : undefined;
  const ttl =
    snapshot && member
      ? (snapshot.cache.ttlSecondsByProvider[member.provider] ?? snapshot.cache.fallbackTtlSeconds)
      : 0;
  const remaining = cacheRemainingSeconds(member?.lastRequestAt ?? null, ttl, now);
  const hasCache = remaining !== null && remaining > 0;

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const command = useMutation({
    mutationFn: (action: TaskAction) =>
      commandRpc({
        workspaceId,
        conversationId,
        action,
        requestId: newCommandRequestId(),
        ...(["execute", "review_plan"].includes(action) && snapshot?.latestPlanSource
          ? { source: snapshot.latestPlanSource }
          : {}),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      }),
    onSuccess: (result) => {
      setNotice(result.message);
      setError("");
      void queryClient.invalidateQueries({ queryKey });
    },
    onError: (err) => {
      setNotice("");
      setError(failure(err));
    },
    retry: false,
  });
  const compact = useMutation({
    mutationFn: async () => {
      if (!member) throw new Error("当前接手者尚未建立成员，不能压缩");
      const result = await paseo.taskConversations
        .ref(conversationId)
        .compact({ memberId: member.memberId });
      if (result.error) throw new Error(result.error);
    },
    onSuccess: () => {
      setNotice("已完成当前接手者的压缩");
      setError("");
      void queryClient.invalidateQueries({ queryKey });
    },
    onError: (err) => setError(failure(err)),
    retry: false,
  });
  const saveRole = (role: ModelRole, selection: TaskRoleSelection) =>
    selectRoleRpc({ workspaceId, conversationId, role, selection });
  const selection = useMutation({
    mutationFn: async (id: string) => {
      if (!snapshot) throw new Error("任务尚未加载，请稍后重试");
      await selectTaskRecipient({
        snapshot,
        id,
        saveRole,
        select: (nextId) => {
          navigation?.setTaskConversationRecipients?.({
            workspaceId,
            conversationId,
            recipients: recipientOptions(snapshot),
            selectedRecipientId: nextId,
          });
          setSelectedId(nextId);
        },
      });
    },
    onSuccess: () => {
      setError("");
      void queryClient.invalidateQueries({ queryKey });
    },
    onError: (err) => setError(failure(err)),
    retry: false,
  });
  const rolePreference = useMutation({
    mutationFn: (mode: "inherit" | "disabled") => saveRole(focusedRole, { mode }),
    onSuccess: () => {
      setError("");
      setNotice("已保存任务角色选择，尚未授权执行");
      void queryClient.invalidateQueries({ queryKey });
    },
    onError: (err) => setError(failure(err)),
    retry: false,
  });
  const styles = useMemo(() => {
    const text = { color: theme.colors.foreground, fontSize: 13 };
    return {
      text,
      muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
      heading: { ...text, fontSize: 17, fontWeight: "600" } as TextStyle,
      label: { ...text, fontWeight: "600" } as TextStyle,
      danger: { ...text, color: theme.colors.statusDanger },
      input: {
        ...text,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 6,
        padding: 8,
      },
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: { padding: layout.compact ? 12 : 16, gap: 12 },
      group: {
        padding: layout.compact ? 12 : 16,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        gap: 10,
        backgroundColor: theme.colors.surface1,
      },
    };
  }, [theme, layout.compact]);
  const runNavigation = (operation: Promise<void> | undefined) => {
    if (operation) void operation.catch((err: unknown) => setError(failure(err)));
  };

  return {
    props,
    snapshot,
    phase,
    query,
    command,
    compact,
    reason,
    setReason,
    notice,
    error,
    remaining,
    hasCache,
    member,
    activeId,
    activeRole,
    selectRecipient: selection.mutate,
    selectionPending: selection.isPending || rolePreference.isPending,
    rolePreference,
    focusedRole,
    setRoleFocus,
    runNavigation,
    styles,
  };
}
type PanelState = ReturnType<typeof usePanel>;
const ROW = { flexDirection: "row", flexWrap: "wrap", gap: 6 } as const;
const GAP = { gap: 6 };
function PanelContent(props: PluginConversationPanelProps) {
  const state = usePanel(props);
  return (
    <ScrollView style={state.styles.screen} contentContainerStyle={state.styles.content}>
      <StatusSection state={state} />
      <Subtasks state={state} />
      <Artifacts state={state} />
    </ScrollView>
  );
}
function gitSummary(git: unknown): string | undefined {
  if (git && typeof git === "object" && "message" in git && typeof git.message === "string")
    return git.message;
}
function StatusSection({ state }: { state: PanelState }) {
  const { snapshot, phase, query, command, reason, setReason, notice, error, styles } = state;
  const summary = gitSummary(snapshot?.task?.control?.git) ?? snapshot?.task?.summary;
  return (
    <View style={styles.group}>
      <Text style={styles.heading}>阶段与阻塞</Text>
      <Text style={styles.text}>
        当前阶段：{phase ? TASK_PHASE_LABELS[phase] : "正在初始化任务"}
      </Text>
      {summary ? (
        <Text selectable style={styles.text}>
          {summary}
        </Text>
      ) : null}
      {query.isPending ? <Text style={styles.muted}>正在读取任务…</Text> : null}
      {query.error ? <Text style={styles.danger}>任务读取失败：{failure(query.error)}</Text> : null}
      {snapshot?.blockers.map((blocker) => (
        <Text key={blocker} style={styles.danger}>
          {blocker}
        </Text>
      ))}
      {snapshot && snapshot.blockers.length === 0 ? (
        <Text style={styles.muted}>当前没有阻塞原因</Text>
      ) : null}
      <View style={ROW}>
        {TASK_ACTIONS.map(({ action, label }) => (
          <ChoiceButton
            key={action}
            value={action}
            onSelect={command.mutate}
            label={label}
            small
            variant={actionVariant(action)}
            disabled={
              command.isPending ||
              state.selectionPending ||
              !actionAvailable(action, phase) ||
              (action === "execute" && !snapshot?.latestPlanSource)
            }
          />
        ))}
      </View>
      <TextInput
        accessibilityLabel="停止、驳回或修改方案的原因"
        value={reason}
        onChangeText={setReason}
        placeholder="原因 / 修改要求"
        placeholderTextColor={styles.muted.color}
        multiline
        style={styles.input}
      />
      <ChoiceButton
        value={"reject" as TaskAction}
        onSelect={command.mutate}
        label="驳回并修复"
        small
        disabled={command.isPending || !reason.trim() || !actionAvailable("reject", phase)}
      />
      <Text style={styles.muted}>
        只有“执行”授权开工；普通“认可 / 确认 / 可以”不会授权。所有任务都必须验证。
      </Text>
      <Recipients state={state} />
      {notice ? (
        <Text accessibilityRole="alert" style={styles.text}>
          {notice}
        </Text>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={styles.danger}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}
function Recipients({ state }: { state: PanelState }) {
  const { snapshot, focusedRole, activeId, remaining, member, compact, selectRecipient, styles } =
    state;
  const compactMutation = compact.mutate;
  const compactNow = useCallback(() => compactMutation(), [compactMutation]);
  return (
    <>
      <Text style={styles.label}>谁来接</Text>
      {remaining !== null && remaining > 0 ? (
        <Text style={styles.muted}>缓存仍有效，现在换会多耗 token。</Text>
      ) : null}
      <View style={ROW}>
        {MODEL_ROLES.map((role) => (
          <ChoiceButton
            key={role}
            value={role}
            onSelect={state.setRoleFocus}
            label={ROLE_LABELS[role]}
            small
            variant={focusedRole === role ? "primary" : "default"}
          />
        ))}
      </View>
      <ScrollView horizontal contentContainerStyle={GAP}>
        {snapshot?.recipients
          .filter((option) => option.role === focusedRole)
          .map((option) => (
            <ChoiceButton
              key={option.id}
              value={option.id}
              onSelect={selectRecipient}
              label={option.label}
              small
              disabled={state.selectionPending}
              variant={activeId === option.id ? "primary" : "default"}
            />
          ))}
      </ScrollView>
      <RolePreferences state={state} />
      <Text style={styles.muted}>
        提示缓存到期（估算）：{formatCountdown(remaining)}
        {member ? ` · ${member.provider} / ${member.model ?? "默认模型"}` : ""}
      </Text>
      <Text style={styles.muted}>
        按成员最后请求时间 + provider 缓存时长估算。到期前自动压缩：
        {snapshot?.cache.autoCompact ? "开启" : "关闭"}（沿用上下文设置）。
      </Text>
      <Btn
        label={compact.isPending ? "正在压缩…" : "压缩"}
        small
        disabled={!member || compact.isPending || remaining === null || remaining === 0}
        onPress={compactNow}
      />
    </>
  );
}

function RolePreferences({ state }: { state: PanelState }) {
  const { snapshot, focusedRole, rolePreference, styles, selectionPending } = state;
  const choice = snapshot?.task?.roleSelections?.[focusedRole];
  const editable = roleConfigurationAllowed(snapshot?.task?.phase);
  return (
    <View style={GAP}>
      <Text style={styles.muted}>
        {ROLE_LABELS[focusedRole]}任务配置：{roleSelectionText(choice)}
      </Text>
      <Text style={styles.muted}>
        {editable
          ? "选预设会保存本任务的角色选择；选择接手者不授权执行。"
          : "本轮默认角色已冻结；换接手者只影响后续发言。"}
      </Text>
      <View style={ROW}>
        <ChoiceButton
          value={"inherit" as const}
          onSelect={rolePreference.mutate}
          label="沿用项目 / 全局默认"
          small
          disabled={!editable || selectionPending}
        />
        {OPTIONAL_TASK_ROLES.includes(focusedRole) ? (
          <ChoiceButton
            value={"disabled" as const}
            onSelect={rolePreference.mutate}
            label="不启用此角色"
            small
            disabled={!editable || selectionPending}
          />
        ) : null}
      </View>
    </View>
  );
}

function roleSelectionText(choice: TaskRoleSelection | undefined) {
  if (choice?.mode === "disabled") return "不启用";
  if (choice?.mode === "preset") return "已指定任务预设";
  return "沿用项目 / 全局默认";
}

function Subtasks({ state }: { state: PanelState }) {
  const { snapshot, runNavigation, styles } = state;
  const { navigation, conversationId } = state.props;
  const openMember = useCallback(
    (memberId: string | undefined) => {
      if (memberId)
        runNavigation(navigation?.openTaskConversationMember?.({ conversationId, memberId }));
    },
    [navigation, conversationId, runNavigation],
  );
  return (
    <View style={styles.group}>
      <Text style={styles.heading}>子任务</Text>
      {snapshot?.subtasks.length ? (
        snapshot.subtasks.map((subtask) => (
          <View key={subtask.id} style={GAP}>
            <Text style={styles.text}>
              {subtask.id} · {subtask.title}
            </Text>
            <Text style={styles.muted}>
              状态：{SUBTASK_LABELS[subtask.status] ?? subtask.status} · {ROLE_LABELS[subtask.role]}{" "}
              · {subtask.model ?? "尚未运行"}
            </Text>
            <Text style={styles.muted}>依赖：{subtask.dependsOn.join("、") || "无"}</Text>
            {subtask.summary ? (
              <Text selectable style={styles.text}>
                {subtask.summary}
              </Text>
            ) : null}
            <ChoiceButton
              value={subtask.memberId}
              onSelect={openMember}
              label="展开子会话"
              small
              disabled={!subtask.memberId || !navigation?.openTaskConversationMember}
            />
          </View>
        ))
      ) : (
        <Text style={styles.muted}>未产生子任务</Text>
      )}
    </View>
  );
}
function Artifacts({ state }: { state: PanelState }) {
  const { snapshot, runNavigation, styles } = state;
  const { navigation, conversationId } = state.props;
  const openSource = useCallback(
    (sourceKey: string) => {
      runNavigation(navigation?.openTaskConversationSource?.({ conversationId, sourceKey }));
    },
    [navigation, conversationId, runNavigation],
  );
  return (
    <View style={styles.group}>
      <Text style={styles.heading}>步骤沉淀</Text>
      {Object.entries(ARTIFACT_LABELS).map(([kind, label]) => (
        <View key={kind} style={GAP}>
          <Text style={styles.label}>{label}</Text>
          {snapshot?.artifacts.some((artifact) => artifact.kind === kind) ? (
            snapshot.artifacts
              .filter((artifact) => artifact.kind === kind)
              .map((artifact) => (
                <Artifact
                  key={`${kind}:${artifact.sourceKey}`}
                  artifact={artifact}
                  text={styles.text}
                  muted={styles.muted}
                  sourceAvailable={!!navigation?.openTaskConversationSource}
                  onSource={openSource}
                />
              ))
          ) : (
            <Text style={styles.muted}>未产生</Text>
          )}
        </View>
      ))}
    </View>
  );
}

const SUBTASK_LABELS: Record<string, string> = {
  pending: "待执行",
  running: "执行中",
  waiting: "等待",
  completed: "完成",
  paused: "暂停",
  failed: "失败",
};

function Artifact({
  artifact,
  text,
  muted,
  sourceAvailable,
  onSource,
}: {
  artifact: TaskArtifact;
  text: { color: string; fontSize: number };
  muted: { color: string; fontSize: number };
  sourceAvailable: boolean;
  onSource: (sourceKey: string) => void;
}) {
  const paseo = usePaseo();
  const [expanded, setExpanded] = useState(false);
  const content = useQuery({
    queryKey: [
      "task-artifact-content",
      artifact.source.conversationId,
      artifact.kind,
      artifact.sourceKey,
    ],
    queryFn: () => loadArtifactContent(paseo, artifact),
    enabled: expanded,
    staleTime: Infinity,
  });
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  const source = useMutation({
    mutationFn: async () => onSource(await resolveArtifactChatSourceKey(paseo, artifact)),
    retry: false,
  });
  const jumpMutation = source.mutate;
  const jump = useCallback(() => jumpMutation(), [jumpMutation]);
  return (
    <View style={GAP}>
      <Text selectable style={text}>
        {artifact.summary}
      </Text>
      <Text style={muted}>
        {artifact.createdAt}
        {artifact.confirmedAt ? " · 已确认轮次" : " · 规划记录"}
      </Text>
      <View style={ROW}>
        <Btn small label={expanded ? "收起内容" : "查看完整内容"} onPress={toggle} />
        <Btn
          small
          label={source.isPending ? "正在定位…" : "跳到群聊源位置"}
          disabled={!sourceAvailable || source.isPending}
          onPress={jump}
        />
      </View>
      {source.error ? (
        <Text accessibilityRole="alert" style={text}>
          跳转失败：{failure(source.error)}
        </Text>
      ) : null}
      {expanded ? (
        <Text selectable style={text}>
          {artifactBody(content)}
        </Text>
      ) : null}
    </View>
  );
}

function artifactBody(content: { isPending: boolean; error: unknown; data?: string }) {
  if (content.isPending) return "正在读取完整内容…";
  if (content.error) return `读取完整内容失败：${failure(content.error)}`;
  return content.data;
}

function actionVariant(action: TaskAction): "primary" | "danger" | "default" {
  if (action === "execute" || action === "accept") return "primary";
  return action === "stop" ? "danger" : "default";
}

function ChoiceButton<T>({
  value,
  onSelect,
  ...props
}: {
  value: T;
  onSelect: (value: T) => void;
} & Omit<Parameters<typeof Btn>[0], "onPress">) {
  const onPress = useCallback(() => onSelect(value), [onSelect, value]);
  return <Btn {...props} onPress={onPress} />;
}
