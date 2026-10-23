import { create } from "zustand";
import type { PluginTaskConversationRecipientsInput } from "@getpaseo/plugin/client";
import {
  TaskConversationRecipientSchema,
  type TaskConversationRecipient,
} from "@getpaseo/protocol/messages";
import { taskConversationKey } from "@/task-conversations/store";

export type TaskConversationRecipientOption =
  PluginTaskConversationRecipientsInput["recipients"][number];
export type TaskConversationRecipientsInput = Omit<
  PluginTaskConversationRecipientsInput,
  "workspaceId"
>;

export function findTaskConversationRecipientOption(
  options: readonly TaskConversationRecipientOption[],
  recipient: TaskConversationRecipient,
): TaskConversationRecipientOption | undefined {
  if (recipient.memberId) {
    return options.find((option) => option.recipient.memberId === recipient.memberId);
  }
  return options.find(
    (option) =>
      option.recipient.role === recipient.role && option.recipient.presetId === recipient.presetId,
  );
}

export function withTaskConversationRecipientModel(input: {
  recipient: TaskConversationRecipient;
  provider: TaskConversationRecipient["config"]["provider"];
  model: string;
}): TaskConversationRecipient {
  const { recipient, provider, model } = input;
  const sameProvider = provider === recipient.config.provider;
  if (sameProvider && model === recipient.config.model) return recipient;
  const config: TaskConversationRecipient["config"] = {
    ...recipient.config,
    provider,
    model,
    thinkingOptionId: undefined,
  };
  if (!sameProvider) {
    config.modeId = undefined;
    config.providerOptions = undefined;
    config.featureValues = undefined;
  }
  return { ...recipient, memberId: undefined, presetId: undefined, config };
}

export interface TaskConversationSelection {
  recipients: readonly TaskConversationRecipientOption[];
  selectedRecipientId: string | null;
  recipient: TaskConversationRecipient | null;
}

interface TaskConversationSelectionStore {
  selections: Map<string, TaskConversationSelection>;
  setRecipients(serverId: string, input: TaskConversationRecipientsInput): void;
  setRecipient(
    serverId: string,
    conversationId: string,
    recipient: TaskConversationRecipient,
  ): void;
  clearRecipients(serverId: string, conversationId: string): void;
}

export const useTaskConversationSelectionStore = create<TaskConversationSelectionStore>((set) => ({
  selections: new Map(),
  setRecipients(serverId, input) {
    const identities = new Set<string>();
    const recipients = input.recipients.map((option) => {
      if (!option.id || identities.has(option.id))
        throw new Error("接手者选项 ID 必须唯一且不能为空。");
      identities.add(option.id);
      return { ...option, recipient: TaskConversationRecipientSchema.parse(option.recipient) };
    });
    const requested = recipients.find((option) => option.id === input.selectedRecipientId);
    if (input.selectedRecipientId !== undefined && !requested)
      throw new Error("所选接手者不在选项列表中。");
    set((state) => {
      const key = taskConversationKey(serverId, input.conversationId);
      const previous = state.selections.get(key);
      const retained = recipients.find((option) => option.id === previous?.selectedRecipientId);
      const selected = requested ?? retained ?? recipients[0];
      const preserveManual =
        recipients.length > 0 &&
        input.selectedRecipientId === undefined &&
        previous?.selectedRecipientId === null;
      const recipient = preserveManual ? previous.recipient : (selected?.recipient ?? null);
      const selectedRecipientId = preserveManual ? null : (selected?.id ?? null);
      const selections = new Map(state.selections);
      selections.set(key, { recipients, selectedRecipientId, recipient });
      return { selections };
    });
  },
  setRecipient(serverId, conversationId, recipient) {
    const parsed = TaskConversationRecipientSchema.parse(recipient);
    set((state) => {
      const key = taskConversationKey(serverId, conversationId);
      const previous = state.selections.get(key);
      const recipients = previous?.recipients ?? [];
      const selected = recipients.find((option) => option.recipient === recipient);
      const selections = new Map(state.selections);
      selections.set(key, {
        recipients,
        selectedRecipientId: selected?.id ?? null,
        recipient: parsed,
      });
      return { selections };
    });
  },
  clearRecipients(serverId, conversationId) {
    set((state) => {
      const selections = new Map(state.selections);
      selections.delete(taskConversationKey(serverId, conversationId));
      return { selections };
    });
  },
}));

export function setTaskConversationRecipients(
  serverId: string,
  input: TaskConversationRecipientsInput,
): void {
  useTaskConversationSelectionStore.getState().setRecipients(serverId, input);
}

export function setTaskConversationRecipient(
  serverId: string,
  conversationId: string,
  recipient: TaskConversationRecipient,
): void {
  useTaskConversationSelectionStore.getState().setRecipient(serverId, conversationId, recipient);
}

export function clearTaskConversationRecipients(serverId: string, conversationId: string): void {
  useTaskConversationSelectionStore.getState().clearRecipients(serverId, conversationId);
}
