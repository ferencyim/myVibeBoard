export const TASK_CONVERSATION_ID_LABEL = "paseo.task-conversation-id";
export const TASK_CONVERSATION_MEMBER_ID_LABEL = "paseo.task-conversation-member-id";

/** These labels are written before agent publication and protected by the host's member guards. */
export function taskConversationIdentity(labels: Record<string, unknown> | null | undefined): {
  taskConversationId?: string;
  taskConversationMemberId?: string;
} {
  const conversationId = labels?.[TASK_CONVERSATION_ID_LABEL];
  const memberId = labels?.[TASK_CONVERSATION_MEMBER_ID_LABEL];
  if (
    typeof conversationId !== "string" ||
    !conversationId ||
    typeof memberId !== "string" ||
    !memberId
  )
    return {};
  return { taskConversationId: conversationId, taskConversationMemberId: memberId };
}
