import { useRpc } from "@getpaseo/plugin/client";
import { SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import React, { useState } from "react";
import { Text } from "react-native";
import { taskFlowSetRpc, taskPanelRpc } from "../shared/task-tabs";

const OPTIONS = [
  { value: "simple", label: "简单" },
  { value: "medium", label: "中等" },
  { value: "full", label: "完整" },
  { value: "custom", label: "自定义" },
] as const;

export function FlowSelector({ workspaceId, refresh, openPanel }: {
  workspaceId: string;
  refresh(): void;
  openPanel(): void;
}) {
  const panel = useRpc(taskPanelRpc);
  const setFlow = useRpc(taskFlowSetRpc);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const query = useQuery({ queryKey: ["vibe-board", "task-flow-selector", workspaceId],
    queryFn: () => panel({ workspaceId }), refetchInterval: 5000, retry: false });
  if (!query.data?.isTask || !query.data.task) return null;
  const change = async (level: typeof OPTIONS[number]["value"]) => {
    setPending(true);
    setError(null);
    try {
      if (level === "custom") openPanel();
      await setFlow({ workspaceId, level });
      await query.refetch();
      refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  };
  return <>
    <SettingsSelect inline label="任务流程" value={query.data.task.flowLevel} options={OPTIONS}
      disabled={pending} onValueChange={(level) => void change(level)} />
    {error ? <Text accessibilityRole="alert">{error}</Text> : null}
  </>;
}
