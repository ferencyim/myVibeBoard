import { useRpc, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import React from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { taskPanelRpc } from "../shared/task-tabs";
import { taskPanelQueryKey, taskPanelRefreshInterval } from "./task-panel-query";

/** Read the same task snapshot as the flow panel, including cached data during refresh. */
export function TaskInfoPanel({ workspaceId, theme }: PluginWorkspacePanelProps) {
  const panel = useRpc(taskPanelRpc);
  const query = useQuery({
    queryKey: taskPanelQueryKey(workspaceId),
    queryFn: () => panel({ workspaceId }),
    refetchInterval: taskPanelRefreshInterval,
    staleTime: taskPanelRefreshInterval,
    retry: false,
  });
  const task = query.data?.task;
  const text = { color: theme.colors.foreground, fontSize: 13, lineHeight: 20 };
  return <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
    {query.isLoading ? <Text style={text}>正在加载任务资料…</Text> : null}
    {query.error ? <View style={{ gap: 8 }}><Text style={text}>任务资料加载失败：{String(query.error)}</Text><Pressable accessibilityRole="button" onPress={() => { void query.refetch(); }}><Text style={{ color: theme.colors.accent }}>重试</Text></Pressable></View> : null}
    {task ? <>
      <Text style={text}>状态：{query.data?.phaseLabel}</Text>
      <Text style={text}>任务摘要：{task.summary || "暂无"}</Text>
      {task.plan ? <><Text style={text}>目标：{task.plan.goal}</Text><Text style={text}>做法：{task.plan.approach}</Text><Text style={text}>涉及文件：{task.plan.files.join("、") || "暂无"}</Text></> : <Text style={text}>尚无任务方案</Text>}
    </> : !query.isLoading && !query.error ? <Text style={text}>暂无任务资料</Text> : null}
  </ScrollView>;
}
