import { create } from "zustand";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { TaskConversationDetailsTarget } from "./details";
import { taskConversationKey, useTaskConversationStore } from "./store";
import { loadOlderTaskConversation } from "./timeline-owner";

type NavigationTarget =
  | { kind: "source"; messageId: string }
  | { kind: "member"; details: TaskConversationDetailsTarget };

export const useTaskConversationNavigationStore = create<{
  targets: Map<string, NavigationTarget>;
  open(key: string, target: NavigationTarget): void;
}>((set) => ({
  targets: new Map(),
  open: (key, target) => set((state) => ({ targets: new Map(state.targets).set(key, target) })),
}));

export function createTaskConversationNavigation(input: {
  serverId: string;
  pluginId: string;
  signal: AbortSignal;
  getClient(): Pick<DaemonClient, "queryTaskConversationSource" | "fetchTaskConversation"> | null;
  hasWorkspace(workspaceId: string): boolean;
  onOpen?(conversationId: string): void;
}) {
  function requireConversation(conversationId: string) {
    input.signal.throwIfAborted();
    const conversation = useTaskConversationStore
      .getState()
      .conversations.get(taskConversationKey(input.serverId, conversationId));
    if (!conversation || !input.hasWorkspace(conversation.workspaceId))
      throw new Error("任务会话不属于当前宿主的工作区。");
    if (conversation.ownerPluginId !== input.pluginId) throw new Error("任务会话属于另一个插件。");
    return conversation;
  }
  return {
    async openTaskConversationMember(target: { conversationId: string; memberId: string }) {
      const conversation = requireConversation(target.conversationId);
      const member = conversation.members.find((entry) => entry.memberId === target.memberId);
      if (!member) throw new Error("成员不属于此任务会话。");
      input.onOpen?.(target.conversationId);
      useTaskConversationNavigationStore
        .getState()
        .open(taskConversationKey(input.serverId, target.conversationId), {
          kind: "member",
          details: { memberId: member.memberId, backendAgentId: member.backendAgentId },
        });
    },
    async openTaskConversationSource(target: { conversationId: string; sourceKey: string }) {
      requireConversation(target.conversationId);
      const client = input.getClient();
      if (!client) throw new Error("宿主已断开连接。");
      const result = await client.queryTaskConversationSource(target);
      requireConversation(target.conversationId);
      if (result.error || !result.row) throw new Error(result.error ?? "未找到群聊源记录。");
      const row = result.row;
      if (row.sourceKey !== target.sourceKey) throw new Error("群聊来源与请求不一致。");
      const key = taskConversationKey(input.serverId, target.conversationId);
      let current = useTaskConversationStore.getState().timelines.get(key);
      while (!current?.rows.some((entry) => entry.id === row.id)) {
        if (current?.epoch !== row.epoch || !current.hasOlder)
          throw new Error("群聊源记录暂不可定位，请刷新会话后重试。");
        const previousStart = current.startSeq;
        if (!(await loadOlderTaskConversation(client, input.serverId, target.conversationId)))
          throw new Error("无法读取群聊源记录，请稍后重试。");
        requireConversation(target.conversationId);
        current = useTaskConversationStore.getState().timelines.get(key);
        if (current?.startSeq === previousStart) throw new Error("读取群聊源记录未取得进展。");
      }
      input.onOpen?.(target.conversationId);
      useTaskConversationNavigationStore
        .getState()
        .open(key, { kind: "source", messageId: row.id });
    },
  };
}
