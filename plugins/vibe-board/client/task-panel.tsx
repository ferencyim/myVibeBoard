import { useRpc, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import React, { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  taskPanelRpc,
  taskTabCommandRpc,
  type ProjectPlanData,
  type TaskBoardItemData,
  type TaskTabCommand,
  type TaskTabViewData,
} from "../shared/task-tabs";
import { withAlpha } from "./common/colors";
import { HostProvider, useHost } from "./common/ctx";
import { Btn, Dot, Muted } from "./common/ui";

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
  const query = useQuery({
    queryKey: ["vibe-board", "task-panel", workspaceId],
    queryFn: () => panel({ workspaceId }),
    refetchInterval: 3_000,
    retry: false,
  });
  const [pending, setPending] = useState<TaskTabCommand["action"] | "refresh" | null>(null);
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
        <View
          style={{
            borderWidth: 1,
            borderRadius: 10,
            borderColor: theme.colors.statusWarning,
            backgroundColor: withAlpha(theme.colors.statusWarning, 0.12),
            padding: 10,
            gap: 4,
          }}
        >
          <Text style={{ color: theme.colors.statusWarning, fontSize: 12, fontWeight: "600" }}>
            阻塞原因
          </Text>
          <Text style={[heading, { fontSize: 13 }]}>{data.blockingReason}</Text>
        </View>
      ) : null}

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Btn
          label="执行"
          variant="primary"
          small
          disabled={disabled}
          onPress={() => void run("execute")}
          testID="task-flow-execute"
        />
        <Btn
          label="通过"
          small
          disabled={disabled}
          onPress={() => void run("accept")}
          testID="task-flow-accept"
        />
        <Btn
          label="停止任务"
          small
          disabled={disabled}
          onPress={() => void run("stop")}
          testID="task-flow-stop"
        />
        <Btn
          label="状态"
          variant="ghost"
          small
          disabled={disabled}
          onPress={() => void run("status")}
          testID="task-flow-status"
        />
        <Btn
          label="刷新"
          variant="ghost"
          small
          disabled={pending === "refresh"}
          onPress={() => void run("refresh")}
          testID="task-flow-refresh"
        />
      </View>

      {message ? <Muted size={13}>{message}</Muted> : null}
      {error ? (
        <Text style={{ fontSize: 13, color: theme.colors.statusDanger }}>{error}</Text>
      ) : null}

      <Text style={[hint, { fontSize: 12, fontWeight: "600" }]}>流程 tab</Text>
      {data.tabs.map((tab) => (
        <TabRow key={tab.agentId || tab.role} tab={tab} openAgent={openAgent} />
      ))}
      {!openAgent ? (
        <Muted>当前宿主不支持从面板切换 tab；请使用顶部 tab 打开。</Muted>
      ) : null}

      {data.board?.length ? (
        <>
          <Text style={[hint, { fontSize: 12, fontWeight: "600" }]}>
            {`任务看板 · 完成 ${data.board.filter((item) => item.status === "done").length}/${data.board.length}`}
          </Text>
          {data.board.map((item) => (
            <BoardRow key={item.id} item={item} />
          ))}
        </>
      ) : null}

      <Text style={[hint, { fontSize: 12, fontWeight: "600" }]}>各步结论</Text>
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

      <Text style={[hint, { fontSize: 12, fontWeight: "600" }]}>同项目其它方案</Text>
      {data.otherPlans?.length ? (
        data.otherPlans.map((plan) => <ProjectPlanRow key={plan.workspaceId} plan={plan} />)
      ) : (
        <Muted>同项目没有其它任务的方案。</Muted>
      )}
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

function TabRow({
  tab,
  openAgent,
}: {
  tab: TaskTabViewData;
  openAgent?: (input: { readonly agentId: string }) => void;
}) {
  const { theme } = useHost();
  const open = useCallback(() => openAgent?.({ agentId: tab.agentId }), [openAgent, tab.agentId]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`#${tab.number} ${tab.roleLabel} ${tab.model} ${tab.status}`}
      testID={`task-flow-tab-${tab.number}`}
      disabled={!openAgent || !tab.agentId}
      onPress={open}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 9,
      }}
    >
      <Dot
        color={tab.busy ? theme.colors.statusWarning : theme.colors.statusSuccess}
        size={8}
      />
      <Text style={{ flexShrink: 1, color: theme.colors.foreground, fontSize: 13 }}>
        {tab.title ??
          `#${tab.number} ${tab.roleLabel}${tab.model ? ` · ${tab.model}` : ""}`}
      </Text>
      <Text
        style={{
          marginLeft: "auto",
          color: theme.colors.foregroundMuted,
          fontSize: 12,
        }}
      >
        {tab.status}
      </Text>
    </Pressable>
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
