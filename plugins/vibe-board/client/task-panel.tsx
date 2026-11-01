import { useRpc, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { ModelPickerField } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import React, { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  taskPanelRpc,
  taskFlowRoleSetRpc,
  taskFlowModelSetRpc,
  taskPlanStartRpc,
  taskTabCommandRpc,
  type ProjectPlanData,
  type TaskBoardItemData,
  type TaskTabCommand,
  type TaskTabViewData,
} from "../shared/task-tabs";
import { botModelsListRpc } from "../shared/project-bots";
import { withAlpha } from "./common/colors";
import { HostProvider, useHost } from "./common/ctx";
import { Btn, Dot, Muted } from "./common/ui";
import { taskPanelQueryKey, taskPanelRefreshInterval } from "./task-panel-query";
import { RolePromptButton } from "./role-prompt-button";

let requestCounter = 0;
const nextRequestId = () => `task-panel-${Date.now()}-${++requestCounter}`;

export function TaskFlowPanel(props: PluginWorkspacePanelProps) {
  const host = useMemo(
    () => ({ theme: props.theme, compact: props.layout.compact }),
    [props.theme, props.layout.compact],
  );
  const openAgent = props.navigation?.openAgent;
  return (
    <HostProvider value={host}>
      <TaskFlowPanelBody workspaceId={props.workspaceId} openAgent={openAgent} />
    </HostProvider>
  );
}

function TaskFlowPanelBody({
  workspaceId,
  openAgent,
}: {
  workspaceId: string;
  openAgent?: (input: { readonly agentId: string }) => void;
}) {
  const { theme } = useHost();
  const panel = useRpc(taskPanelRpc);
  const command = useRpc(taskTabCommandRpc);
  const setRole = useRpc(taskFlowRoleSetRpc);
  const setModel = useRpc(taskFlowModelSetRpc);
  const listModels = useRpc(botModelsListRpc);
  const models = useQuery({ queryKey: ["vibe-board", "flow-models"], queryFn: () => listModels({}) });
  const startPlan = useRpc(taskPlanStartRpc);
  const query = useQuery({
    queryKey: taskPanelQueryKey(workspaceId),
    queryFn: () => panel({ workspaceId }),
    refetchInterval: taskPanelRefreshInterval,
    staleTime: taskPanelRefreshInterval,
    retry: false,
  });
  const [pending, setPending] = useState<TaskTabCommand["action"] | "refresh" | "flow" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedSteps, setExpandedSteps] = useState<Record<string, boolean>>({});
  const toggleStep = useCallback((kind: string) => {
    setExpandedSteps((current) => ({ ...current, [kind]: !current[kind] }));
  }, []);
  const task = query.data?.task ?? null;
  const run = useCallback(
    async (action: TaskTabCommand["action"] | "refresh") => {
      setError(null);
      setMessage(null);
      setPending(action);
      try {
        if (action !== "refresh" && task) {
          const result = await command({
            workspaceId,
            agentId: task.anchorAgentId,
            action,
            requestId: nextRequestId(),
          });
          setMessage(result.message);
        }
        await query.refetch();
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        setPending(null);
      }
    },
    [command, query, task, workspaceId],
  );
  const toggleRole = useCallback(async (role: "planner" | "scout" | "worker" | "reviewer" | "verifier", enabled: boolean) => {
    setError(null);
    setPending("flow");
    try {
      await setRole({ workspaceId, role, enabled });
      await query.refetch();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setPending(null);
    }
  }, [query, setRole, workspaceId]);
  const changeModel = useCallback(async (role: "main" | "planner" | "scout" | "worker" | "reviewer" | "verifier", provider: string, model: string, thinkingOptionId?: string) => {
    setError(null);
    setPending("flow");
    try {
      await setModel({ workspaceId, role, provider: `${provider}/${model}`, thinkingOptionId });
      await query.refetch();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setPending(null);
    }
  }, [query, setModel, workspaceId]);
  const beginPlan = useCallback(async () => {
    setError(null);
    setMessage(null);
    setPending("flow");
    try {
      setMessage((await startPlan({ workspaceId })).message);
      await query.refetch();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setPending(null);
    }
  }, [query, startPlan, workspaceId]);
  if (query.isLoading)
    return (
      <View style={{ padding: 16 }}>
        <Muted>正在读取任务…</Muted>
      </View>
    );
  if (!query.data)
    return (
      <View style={{ padding: 16, gap: 8 }}>
        <Muted>无法读取任务。</Muted>
        {query.error ? <Muted>{String(query.error)}</Muted> : null}
        <Btn label="重试" small onPress={() => void run("refresh")} testID="task-flow-retry" />
      </View>
    );
  const data = query.data;
  if (!data.isTask || !task)
    return (
      <ScrollView contentContainerStyle={{ padding: 16, gap: 10 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 16, fontWeight: "600" }}>
          任务流程
        </Text>
        <Muted>
          这不是任务 workspace。只有在新建 workspace 界面发送首条消息创建的任务才显示流程
          tab 与面板。
        </Muted>
      </ScrollView>
    );
  const disabled = pending !== null;
  const heading = { color: theme.colors.foreground };
  const hint = { color: theme.colors.foregroundMuted };
  return (
    <ScrollView
      testID="task-flow-panel"
      contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 14 }}
    >
      <View style={{ gap: 6 }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <Text style={[heading, { fontSize: 18, fontWeight: "600" }]}>任务流程</Text>
          <View
            style={{
              paddingHorizontal: 10,
              paddingVertical: 4,
              borderRadius: 999,
              backgroundColor: data.blockingReason
                ? withAlpha(theme.colors.statusWarning, 0.2)
                : theme.colors.surface2,
            }}
          >
            <Text style={[heading, { fontSize: 12, fontWeight: "600" }]}>{data.phaseLabel}</Text>
          </View>
        </View>
        {task.summary ? <Muted size={13}>{task.summary}</Muted> : null}
      </View>

      {data.blockingReason ? (
        <Text style={{ color: theme.colors.statusWarning, fontSize: 13 }}>{data.blockingReason}</Text>
      ) : null}
      {message ? <Muted size={13}>{message}</Muted> : null}
      {error ? <Text style={{ fontSize: 13, color: theme.colors.statusDanger }}>{error}</Text> : null}

      <Text testID="task-flow-section-progress" style={[hint, { fontSize: 12, fontWeight: "600" }]}>流程</Text>
      {data.tabs.filter((tab) => tab.role !== "session" && tab.role !== "plan_reviewer").map((tab) => (
        <TabRow
          key={tab.role}
          tab={tab}
          openAgent={openAgent}
          current={currentRole(task.phase, data.nextStep, data.tabs) === tab.role}
          phaseLabel={data.phaseLabel}
          disabled={disabled}
          nextStep={data.nextStep}
          onStartPlan={() => void beginPlan()}
          onExecute={() => void run("execute")}
          onAccept={() => void run("accept")}
          onStop={() => void run("stop")}
          phase={task.phase}
          onToggleRole={(role, enabled) => void toggleRole(role, enabled)}
          providers={models.data?.providers ?? []}
          modelsLoading={models.isLoading}
          onChangeModel={(role, provider, model, thinking) => void changeModel(role, provider, model, thinking)}
        />
      ))}
      {data.nextStep === "evaluating" ? <Muted>项目 bot 正在评估流程档位…</Muted> : null}

      <Text testID="task-flow-section-subtasks" style={[hint, { fontSize: 12, fontWeight: "600" }]}>
        {`子任务 · 完成 ${data.board?.filter((item) => item.status === "done").length ?? 0}/${data.board?.length ?? 0}`}
      </Text>
      {data.board?.length ? data.board.map((item) => (
        <BoardRow key={item.id} item={item} />
      )) : <Muted>还没有子任务。</Muted>}

      <Text testID="task-flow-section-plans" style={[hint, { fontSize: 12, fontWeight: "600" }]}>其他方案</Text>
      {data.otherPlans?.length ? (
        data.otherPlans.map((plan) => <ProjectPlanRow key={plan.workspaceId} plan={plan} />)
      ) : (
        <Muted>同项目没有其它任务的方案。</Muted>
      )}

      <Text testID="task-flow-section-evidence" style={[hint, { fontSize: 12, fontWeight: "600" }]}>证据与各步结论</Text>
      {data.steps.length === 0 ? <Muted>还没有可查看的结论。</Muted> : null}
      {data.steps.map((step) => (
        <View key={step.kind} style={{ gap: 6 }}>
          <StepRow
            step={step}
            expanded={!!expandedSteps[step.kind]}
            onToggle={() => toggleStep(step.kind)}
          />
          {step.kind === "plan_review" ? (
            <View style={{ flexDirection: "row" }}>
              <Btn
                label="重新审阅"
                small
                disabled={disabled}
                onPress={() => void run("rereview")}
                testID="task-flow-rereview"
              />
            </View>
          ) : null}
        </View>
      ))}

    </ScrollView>
  );
}

function ProjectPlanRow({ plan }: { plan: ProjectPlanData }) {
  const { theme } = useHost();
  const meta = [
    plan.updatedAt ? `更新于 ${plan.updatedAt.slice(0, 16).replace("T", " ")}` : "",
    plan.files.length ? plan.files.slice(0, 6).join("、") + (plan.files.length > 6 ? " 等" : "") : "未声明文件",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <View
      testID={`task-flow-plan-${plan.workspaceId}`}
      style={{
        borderWidth: 1,
        borderColor: plan.overlap ? theme.colors.statusWarning : theme.colors.border,
        borderRadius: 8,
        padding: 10,
        gap: 4,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text
          numberOfLines={2}
          style={{ flexShrink: 1, color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}
        >
          {plan.goal ?? plan.name ?? plan.workspaceId}
        </Text>
        <Text style={{ marginLeft: "auto", color: theme.colors.foregroundMuted, fontSize: 12 }}>
          {plan.statusLabel}
        </Text>
      </View>
      {plan.name && plan.goal ? (
        <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
          {plan.name}
        </Text>
      ) : null}
      <Text numberOfLines={2} style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
        {meta}
      </Text>
      {plan.unknownFiles?.length ? (
        <Text numberOfLines={2} style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
          {`范围未知（不在该任务 worktree 内）：${plan.unknownFiles.join("、")}`}
        </Text>
      ) : null}
      {plan.overlap ? (
        <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
          {`与本任务文件重叠：${plan.overlap[0]} ↔ ${plan.overlap[1]}`}
        </Text>
      ) : null}
    </View>
  );
}

function currentRole(phase: string, nextStep: string | null | undefined, tabs: TaskTabViewData[]): string {
  if (phase === "planning") return nextStep === "start_plan" ? "planner" : "main";
  if (phase === "awaiting_confirmation") return "planner";
  if (phase === "reviewing") return "reviewer";
  if (phase === "verifying") return "verifier";
  if (phase === "awaiting_acceptance" || phase === "completed") {
    return ["verifier", "reviewer", "worker"].find((role) => tabs.some((tab) => tab.role === role && tab.status !== "未启用")) ?? "worker";
  }
  return "worker";
}

function TabRow({ tab, openAgent, current, phaseLabel, disabled, nextStep, onStartPlan, onExecute, onAccept, onStop, phase, onToggleRole, providers, modelsLoading, onChangeModel }: {
  tab: TaskTabViewData;
  openAgent?: (input: { readonly agentId: string }) => void;
  current: boolean;
  phaseLabel: string;
  disabled: boolean;
  nextStep?: string | null;
  onStartPlan: () => void;
  onExecute: () => void;
  onAccept: () => void;
  onStop: () => void;
  phase: string;
  providers: React.ComponentProps<typeof ModelPickerField>["providers"];
  modelsLoading: boolean;
  onChangeModel: (role: "main" | "planner" | "scout" | "worker" | "reviewer" | "verifier", provider: string, model: string, thinking?: string) => void;
  onToggleRole: (role: "planner" | "scout" | "worker" | "reviewer" | "verifier", enabled: boolean) => void;
}) {
  const { theme } = useHost();
  const role = tab.role === "plan_reviewer" || tab.role === "session" ? null : tab.role;
  const model = tab.modelId ?? tab.model;
  const enabled = tab.status !== "未启用";
  return (
    <View testID={`task-flow-tab-${tab.number}`} style={{
      gap: 8, borderWidth: 1, borderColor: current ? theme.colors.accent : theme.colors.border,
      backgroundColor: theme.colors.surface1, borderRadius: 8, padding: 10,
    }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        {tab.role === "main" || tab.role === "worker" || !role ? (
          <Dot color={current ? theme.colors.accent : theme.colors.foregroundMuted} size={8} />
        ) : (
          <Pressable accessibilityRole="checkbox" accessibilityLabel={`启用 ${tab.roleLabel}`} accessibilityState={{ checked: enabled, disabled }} disabled={disabled}
            onPress={() => onToggleRole(role, !enabled)}
            style={{ width: 20, height: 20, borderWidth: 1, borderColor: enabled ? theme.colors.accent : theme.colors.border, borderRadius: 4, alignItems: "center", justifyContent: "center", backgroundColor: enabled ? theme.colors.accent : "transparent" }}>
            {enabled ? <Text style={{ color: theme.colors.accentForeground, fontSize: 13 }}>✓</Text> : null}
          </Pressable>
        )}
        <Text style={{ flex: 1, color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>{`#${tab.number} ${tab.roleLabel}`}</Text>
        <Text style={{ color: current ? theme.colors.accent : theme.colors.foregroundMuted, fontSize: 12 }}>
          {current ? `当前 · ${phaseLabel}` : enabled ? tab.status : "未启用"}
        </Text>
      </View>
      {role ? <View style={{ alignSelf: "stretch", minWidth: 0, flexShrink: 0 }}><ModelPickerField providers={providers} provider={tab.provider} model={model} thinking={tab.thinking ?? ""}
        loading={modelsLoading} disabled={disabled} sessionProvider={tab.agentId ? tab.provider : undefined}
        onSelect={(provider, nextModel) => onChangeModel(role, provider, nextModel)}
        onSelectThinking={(thinking) => onChangeModel(role, tab.provider, model, thinking)} /></View> : null}
      {tab.reviewModels?.map((reviewer, index) => (
        <Text key={index} style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
          {`审阅：${[reviewer.provider, reviewer.model, reviewer.thinking].filter(Boolean).join(" · ")}`}
        </Text>
      ))}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {tab.agentId && openAgent ? <Btn label="打开" small onPress={() => openAgent({ agentId: tab.agentId })} /> : null}
        <RolePromptButton role={tab.role} label={tab.roleLabel} />
        {tab.role === "planner" && nextStep === "start_plan" ? <Btn label="生成方案" variant="primary" small disabled={disabled} onPress={onStartPlan} testID="task-flow-start-plan" /> : null}
        {tab.role === "worker" && nextStep === "execute" ? <Btn label="执行" variant="primary" small disabled={disabled} onPress={onExecute} testID="task-flow-execute" /> : null}
        {current && phase === "awaiting_acceptance" ? <Btn label="通过" variant="primary" small disabled={disabled} onPress={onAccept} testID="task-flow-accept" /> : null}
        {current && ["queued", "executing", "reviewing", "verifying"].includes(phase) ? <Btn label="暂停" small disabled={disabled} onPress={onStop} testID="task-flow-stop" /> : null}
      </View>
    </View>
  );
}

function BoardRow({ item }: { item: TaskBoardItemData }) {
  const { theme } = useHost();
  const color =
    item.status === "done"
      ? theme.colors.statusSuccess
      : item.status === "in_progress"
        ? theme.colors.statusWarning
        : item.status === "blocked"
          ? theme.colors.statusDanger
          : theme.colors.foregroundMuted;
  const meta = [
    item.claimedTab ? `#${item.claimedTab}` : "",
    item.readOnly ? "只读" : item.files.length ? item.files.join("、") : "未声明范围",
    item.dependsOn.length ? `依赖 ${item.dependsOn.join("、")}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <View
      testID={`task-flow-board-${item.id}`}
      style={{
        borderWidth: 1,
        borderColor: item.outOfScope.length ? theme.colors.statusWarning : theme.colors.border,
        borderRadius: 8,
        padding: 10,
        gap: 4,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Dot color={color} size={8} />
        <Text
          style={{ flexShrink: 1, color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}
        >
          {`${item.id} ${item.goal}`}
        </Text>
        <Text style={{ marginLeft: "auto", color, fontSize: 12 }}>{item.statusLabel}</Text>
      </View>
      <Text numberOfLines={2} style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
        {meta}
      </Text>
      {item.outOfScope.length ? (
        <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
          {`可能超出子任务范围：${item.outOfScope.join("、")}`}
        </Text>
      ) : null}
      {item.summary ? (
        <Text numberOfLines={3} style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
          {item.summary}
        </Text>
      ) : null}
    </View>
  );
}

function StepRow({
  step,
  expanded,
  onToggle,
}: {
  step: {
    kind: string;
    title: string;
    summary: string;
    detail: string | null;
    createdAt: string | null;
  };
  expanded: boolean;
  onToggle: () => void;
}) {
  const { theme } = useHost();
  return (
    <Pressable
      accessibilityRole="button"
      testID={`task-flow-step-${step.kind}`}
      onPress={onToggle}
      style={{
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        padding: 10,
        gap: 6,
      }}
    >
      <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>
        {step.title}
      </Text>
      <Text
        numberOfLines={expanded ? undefined : 2}
        style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}
      >
        {step.summary}
      </Text>
      {expanded && step.detail ? (
        <Text
          selectable
          style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}
        >
          {step.detail}
        </Text>
      ) : null}
      {step.detail ? (
        <Text style={{ color: theme.colors.accent, fontSize: 12 }}>
          {expanded ? "收起" : "展开详情"}
        </Text>
      ) : null}
    </Pressable>
  );
}
