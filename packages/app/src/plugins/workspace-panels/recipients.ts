import type { PluginTaskConversationRecipientsInput } from "@getpaseo/plugin/client";
import {
  setTaskConversationRecipients,
  clearTaskConversationRecipients,
} from "@/composer/task-conversation-selection";
import { taskConversationKey, useTaskConversationStore } from "@/task-conversations/store";
import type { InstalledPlugin } from "../types";

const recipientScopes = new WeakMap<AbortSignal, Set<string>>();

export function setPluginTaskConversationRecipients(
  serverId: string,
  input: PluginTaskConversationRecipientsInput,
  installation: Pick<InstalledPlugin, "id" | "lifetime">,
): void {
  const key = taskConversationKey(serverId, input.conversationId);
  const conversation = useTaskConversationStore.getState().conversations.get(key);
  if (!conversation || conversation.workspaceId !== input.workspaceId) {
    throw new Error("Task conversation workspace is unavailable");
  }
  if (conversation.ownerPluginId !== installation.id) {
    throw new Error("Task conversation belongs to another plugin");
  }
  installation.lifetime.signal.throwIfAborted();
  const emptyOption = input.recipients.some((option) => !option.id.trim() || !option.label.trim());
  if (emptyOption) throw new Error("Task conversation recipients require IDs and labels");
  setTaskConversationRecipients(serverId, input);
  let owned = recipientScopes.get(installation.lifetime.signal);
  if (!owned) {
    owned = new Set<string>();
    recipientScopes.set(installation.lifetime.signal, owned);
    const conversations = owned;
    installation.lifetime.signal.addEventListener(
      "abort",
      () => {
        for (const conversationId of conversations)
          clearTaskConversationRecipients(serverId, conversationId);
      },
      { once: true },
    );
  }
  owned.add(input.conversationId);
}
