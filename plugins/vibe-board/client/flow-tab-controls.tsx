import { useAgent, useRpc, type PluginConversationHeaderAccessoryProps, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import React, { useState } from "react";
import { View } from "react-native";
import { taskPanelRpc, taskTabCommandRpc } from "../shared/task-tabs";
import type { TaskTabRole } from "../shared/vibe/contract";
import { HostProvider } from "./common/ctx";
import { errorMessage } from "./common/logic";
import { HeaderButton, InjectedPromptsButton, RolePromptButton } from "./role-prompt-button";

let counter = 0;
type Props = PluginSurfaceProps & { workspaceId: string; tabId?: string; agentId?: string; labels?: Record<string, string> };
export function FlowTabControls(props: Props) {
  const panel = useRpc(taskPanelRpc);
  const command = useRpc(taskTabCommandRpc);
  const [pending, setPending] = useState(false);
  const toast = useToast();
  const query = useQuery({ queryKey: ["vibe-board", "task-controls", props.workspaceId],
    queryFn: () => panel({ workspaceId: props.workspaceId }), refetchInterval: 5000, retry: false });
  const task = query.data?.task;
  const tab = query.data?.tabs.find((item) => props.tabId ? item.role === props.tabId : item.agentId === props.agentId);
  if (!task || !tab) return <OtherAgentPrompts {...props} />;
  const running = ["queued", "executing", "reviewing", "verifying"].includes(task.phase);
  const run = async () => {
    setPending(true);
    try {
      await command({ workspaceId: props.workspaceId, agentId: task.anchorAgentId,
        action: running ? "stop" : "execute", requestId: `flow-control-${Date.now()}-${++counter}` });
      await query.refetch();
    } catch (cause) { toast.error(errorMessage(cause)); }
    finally { setPending(false); }
  };
  return <HostProvider value={{ theme: props.theme, compact: props.layout.compact }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <RolePromptButton role={tab.role as TaskTabRole} label={tab.roleLabel} />
      <HeaderButton label={running ? "暂停" : task.phase === "paused" ? "重新执行" : "执行"} disabled={pending} onPress={() => void run()} />
    </View>
  </HostProvider>;
}

/** Agents outside a task still show the prompts injected into them (project bot, master). */
function OtherAgentPrompts(props: PluginSurfaceProps & { labels?: Record<string, string> }) {
  // A project bot lists its injected prompts in its 资料 panel, not in the header.
  if (!props.labels || props.labels["vibe.role"] === "project") return null;
  return <HostProvider value={{ theme: props.theme, compact: props.layout.compact }}>
    <InjectedPromptsButton target={{ labels: props.labels }} label="当前 agent" />
  </HostProvider>;
}

export function FlowConversationControls(props: PluginConversationHeaderAccessoryProps) {
  const workspaceId = useAgent(props.agentId, (agent) => agent.workspaceId);
  const labels = useAgent(props.agentId, (agent) => agent.labels) ?? undefined;
  if (workspaceId) return <FlowTabControls {...props} workspaceId={workspaceId} agentId={props.agentId} labels={labels} />;
  return <OtherAgentPrompts {...props} labels={labels} />;
}
