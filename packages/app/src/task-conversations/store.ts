import { create } from "zustand";
import type {
  TaskConversationDelivery,
  TaskConversationPage,
  TaskConversationRow,
  TaskConversationSnapshot,
} from "@getpaseo/protocol/messages";
import type { MessageSubmissionWriter } from "@/composer/actions";
import {
  acceptMessageSubmission,
  beginMessageSubmission,
  observeMessageSubmissionCanonical,
  rejectMessageSubmission,
  type MessageSubmissionRecord,
} from "@/composer/submission/model";
import type { UserMessageItem } from "@/types/stream";

export interface TaskConversationTimelineState {
  rows: TaskConversationRow[];
  epoch: string | null;
  startSeq: number | null;
  endSeq: number | null;
  hasOlder: boolean;
  hasNewer: boolean;
  needsRefresh: boolean;
  observedEpoch: string | null;
  observedSeq: number;
  sync: "loading" | "ready" | "reconnecting" | "error";
  error: string | null;
  loadingOlder: boolean;
  submissions: MessageSubmissionRecord[];
  submittedRows: UserMessageItem[];
  deliveries: Map<string, TaskConversationDelivery>;
  uncertain: Map<string, string>;
}

interface TaskConversationStore {
  conversations: Map<string, TaskConversationSnapshot>;
  timelines: Map<string, TaskConversationTimelineState>;
  clearHost(serverId: string): void;
  setConversation(serverId: string, conversation: TaskConversationSnapshot): void;
  updateTimeline(
    serverId: string,
    conversationId: string,
    update: (state: TaskConversationTimelineState) => TaskConversationTimelineState,
  ): void;
  applyPage(
    serverId: string,
    page: TaskConversationPage,
    direction: "tail" | "before" | "after",
  ): void;
  applyRow(
    serverId: string,
    conversationId: string,
    row: TaskConversationRow,
    eventSeq?: number,
  ): void;
  setDelivery(serverId: string, delivery: TaskConversationDelivery): void;
  setUncertain(
    serverId: string,
    conversationId: string,
    clientMessageId: string,
    message: string,
  ): void;
}

export function taskConversationKey(serverId: string, conversationId: string): string {
  return `${serverId}\0${conversationId}`;
}

export function emptyTaskConversationTimeline(): TaskConversationTimelineState {
  return {
    rows: [],
    epoch: null,
    startSeq: null,
    endSeq: null,
    hasOlder: false,
    hasNewer: false,
    needsRefresh: false,
    observedEpoch: null,
    observedSeq: 0,
    sync: "loading",
    error: null,
    loadingOlder: false,
    submissions: [],
    submittedRows: [],
    deliveries: new Map(),
    uncertain: new Map(),
  };
}

function acknowledgeRows(
  state: TaskConversationTimelineState,
  rows: TaskConversationRow[],
): TaskConversationTimelineState {
  const identities = rows.flatMap((row) => (row.clientMessageId ? [row.clientMessageId] : []));
  const observed = new Set(identities);
  return {
    ...state,
    submissions: observeMessageSubmissionCanonical(state.submissions, identities),
    // Local presentation retains image metadata and attachment identity after acknowledgement.
    submittedRows: state.submittedRows.map((row) =>
      observed.has(row.clientMessageId ?? "") ? { ...row, messageId: row.clientMessageId } : row,
    ),
  };
}

function mergeRows(
  existingRows: TaskConversationRow[],
  incomingRows: TaskConversationRow[],
): TaskConversationRow[] {
  const bySeq = new Map(existingRows.map((row) => [row.seq, row]));
  for (const row of incomingRows) {
    const existing = bySeq.get(row.seq);
    if (!existing || (existing.updatedSeq ?? existing.seq) <= (row.updatedSeq ?? row.seq))
      bySeq.set(row.seq, row);
  }
  return [...bySeq.values()].sort((left, right) => left.seq - right.seq);
}

function cannotMergePage(
  state: TaskConversationTimelineState,
  page: TaskConversationPage,
  direction: "tail" | "before" | "after",
): boolean {
  const changedEpoch = state.epoch !== page.epoch;
  if (direction !== "tail" && changedEpoch && state.epoch !== null) return true;
  if (state.startSeq === null || state.endSeq === null) return false;
  if (direction === "before" && page.endCursor !== null)
    return page.endCursor.seq + 1 < state.startSeq;
  if (direction === "after" && page.startCursor !== null)
    return page.startCursor.seq > state.endSeq + 1;
  return false;
}

function hasPendingRows(
  state: TaskConversationTimelineState,
  page: TaskConversationPage,
  endSeq: number | null,
): boolean {
  if (page.hasNewer) return true;
  return state.observedEpoch === page.epoch && state.observedSeq > (endSeq ?? 0);
}

export function mergeTaskConversationPage(
  state: TaskConversationTimelineState,
  page: TaskConversationPage,
  direction: "tail" | "before" | "after",
): TaskConversationTimelineState {
  const changedEpoch = state.epoch !== page.epoch;
  const first = page.startCursor?.seq ?? null;
  const last = page.endCursor?.seq ?? null;
  if (cannotMergePage(state, page, direction)) return { ...state, needsRefresh: true };
  const replace = direction === "tail" || changedEpoch;
  const rows = mergeRows(replace ? [] : state.rows, page.rows);
  const startSeq = replace || direction === "before" ? first : state.startSeq;
  let endSeq = state.endSeq;
  if (replace) endSeq = last ?? 0;
  else if (direction === "after") endSeq = Math.max(last ?? 0, state.endSeq ?? 0);
  const acknowledged = acknowledgeRows(state, rows);
  const needsRefresh = hasPendingRows(state, page, endSeq);
  return {
    ...acknowledged,
    rows,
    epoch: page.epoch,
    startSeq,
    endSeq,
    hasOlder: direction === "after" ? state.hasOlder : page.hasOlder,
    hasNewer: direction === "before" ? state.hasNewer : page.hasNewer,
    needsRefresh,
    sync: needsRefresh ? "loading" : "ready",
    error: null,
  };
}

export const useTaskConversationStore = create<TaskConversationStore>((set, get) => ({
  conversations: new Map(),
  timelines: new Map(),
  clearHost(serverId) {
    const prefix = `${serverId}\0`;
    set((state) => ({
      conversations: new Map([...state.conversations].filter(([key]) => !key.startsWith(prefix))),
      timelines: new Map([...state.timelines].filter(([key]) => !key.startsWith(prefix))),
    }));
  },
  setConversation(serverId, conversation) {
    set((state) => {
      const conversations = new Map(state.conversations);
      conversations.set(taskConversationKey(serverId, conversation.conversationId), conversation);
      return { conversations };
    });
  },
  updateTimeline(serverId, conversationId, update) {
    set((state) => {
      const key = taskConversationKey(serverId, conversationId);
      const timelines = new Map(state.timelines);
      timelines.set(key, update(timelines.get(key) ?? emptyTaskConversationTimeline()));
      return { timelines };
    });
  },
  applyPage(serverId, page, direction) {
    get().updateTimeline(serverId, page.conversationId, (state) =>
      mergeTaskConversationPage(state, page, direction),
    );
  },
  applyRow(serverId, conversationId, row, eventSeq = row.updatedSeq ?? row.seq) {
    get().updateTimeline(serverId, conversationId, (state) => {
      const sameEpoch = state.epoch === row.epoch;
      const observedSeq =
        state.observedEpoch === row.epoch ? Math.max(state.observedSeq, eventSeq) : eventSeq;
      const observed = { observedEpoch: row.epoch, observedSeq };
      if (!sameEpoch || state.endSeq === null || eventSeq > state.endSeq + 1) {
        return { ...state, ...observed, needsRefresh: true };
      }
      const rows = mergeRows(state.rows, [row]);
      return {
        ...acknowledgeRows(state, [row]),
        ...observed,
        rows,
        endSeq: Math.max(state.endSeq, eventSeq),
      };
    });
  },
  setDelivery(serverId, delivery) {
    get().updateTimeline(serverId, delivery.conversationId, (state) => {
      const deliveries = new Map(state.deliveries);
      deliveries.set(delivery.clientMessageId, delivery);
      const uncertain = new Map(state.uncertain);
      if (delivery.status === "unknown")
        uncertain.set(
          delivery.clientMessageId,
          delivery.error ?? "投递结果尚不明确，请查询回执后继续。",
        );
      else uncertain.delete(delivery.clientMessageId);
      return { ...state, deliveries, uncertain };
    });
  },
  setUncertain(serverId, conversationId, clientMessageId, message) {
    get().updateTimeline(serverId, conversationId, (state) => {
      const uncertain = new Map(state.uncertain);
      uncertain.set(clientMessageId, message);
      return { ...state, uncertain };
    });
  },
}));

export function selectConversationForBackendAgent(
  state: Pick<TaskConversationStore, "conversations">,
  serverId: string,
  backendAgentId: string,
): TaskConversationSnapshot | null {
  const prefix = `${serverId}\0`;
  for (const [key, conversation] of state.conversations) {
    if (
      key.startsWith(prefix) &&
      conversation.members.some((member) => member.backendAgentId === backendAgentId)
    )
      return conversation;
  }
  return null;
}

export function createTaskConversationSubmissionWriter(serverId: string): MessageSubmissionWriter {
  return {
    begin(conversationId, message) {
      useTaskConversationStore.getState().updateTimeline(serverId, conversationId, (state) => ({
        ...state,
        submittedRows: [...state.submittedRows, message],
        submissions: beginMessageSubmission(state.submissions, {
          clientMessageId: message.clientMessageId ?? message.id,
        }),
      }));
    },
    accept(conversationId, clientMessageId) {
      useTaskConversationStore.getState().updateTimeline(serverId, conversationId, (state) => ({
        ...state,
        submissions: acceptMessageSubmission(state.submissions, clientMessageId),
      }));
    },
    reject(conversationId, clientMessageId) {
      let outcome: ReturnType<MessageSubmissionWriter["reject"]> = "unknown";
      useTaskConversationStore.getState().updateTimeline(serverId, conversationId, (state) => {
        const result = rejectMessageSubmission(state.submissions, clientMessageId);
        outcome = result.outcome;
        const submittedRows =
          result.outcome === "rejected"
            ? state.submittedRows.filter((row) => row.clientMessageId !== clientMessageId)
            : state.submittedRows;
        return { ...state, submissions: result.submissions, submittedRows };
      });
      return outcome;
    },
  };
}
