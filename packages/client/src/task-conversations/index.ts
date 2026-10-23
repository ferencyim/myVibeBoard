import type {
  SessionInboundMessage,
  TaskConversationSnapshot,
  TaskConversationSubscribeResponse,
} from "@getpaseo/protocol/messages";
import type { OwnedSubscription } from "../connection/index.js";
import type { DaemonClient, TaskConversationRequestOptions } from "../daemon-client.js";

type Input<Op extends string> = TaskConversationRequestOptions<
  Extract<`task.conversation.${Op}.request`, SessionInboundMessage["type"]>
>;
type Scoped<Op extends string> = Omit<Input<Op>, "conversationId">;
export interface PaseoTaskConversationHandle {
  readonly id: string;
  current(): TaskConversationSnapshot | null;
  refresh(): Promise<TaskConversationSnapshot | null>;
  send(options: Scoped<"send">): ReturnType<DaemonClient["sendTaskConversationMessage"]>;
  getDelivery(
    options: Scoped<"get_delivery">,
  ): ReturnType<DaemonClient["getTaskConversationDelivery"]>;
  fetch(options?: Scoped<"fetch">): ReturnType<DaemonClient["fetchTaskConversation"]>;
  subscribe(
    options?: Scoped<"subscribe"> & { signal?: AbortSignal },
  ): OwnedSubscription<TaskConversationSubscribeResponse["payload"]>;
  publish(options: Scoped<"publish">): ReturnType<DaemonClient["publishTaskConversation"]>;
  querySource(
    options: Scoped<"query_source">,
  ): ReturnType<DaemonClient["queryTaskConversationSource"]>;
  stop(options?: Scoped<"stop">): ReturnType<DaemonClient["stopTaskConversation"]>;
  archive(): ReturnType<DaemonClient["archiveTaskConversation"]>;
  compact(options: Scoped<"compact">): ReturnType<DaemonClient["compactTaskConversationMember"]>;
}
export interface PaseoTaskConversationActions {
  create(options: Input<"create">): Promise<PaseoTaskConversationHandle>;
  resolve(options: Input<"resolve">): Promise<PaseoTaskConversationHandle | null>;
  ref(conversation: string | TaskConversationSnapshot): PaseoTaskConversationHandle;
}

export function createTaskConversationActions(
  client: DaemonClient,
  own: <T extends { release(): Promise<void> }>(create: () => T) => T,
): PaseoTaskConversationActions {
  const ref = (conversation: string | TaskConversationSnapshot): PaseoTaskConversationHandle => {
    const id = typeof conversation === "string" ? conversation : conversation.conversationId;
    let current = typeof conversation === "string" ? null : conversation;
    return {
      id,
      current: () => current,
      refresh: async () => {
        const result = await client.resolveTaskConversation({ conversationId: id });
        if (result.error) throw new Error(result.error);
        current = result.conversation;
        return current;
      },
      send: (options) => client.sendTaskConversationMessage({ ...options, conversationId: id }),
      getDelivery: (options) =>
        client.getTaskConversationDelivery({ ...options, conversationId: id }),
      fetch: (options = {}) => client.fetchTaskConversation({ ...options, conversationId: id }),
      subscribe: (options = {}) =>
        own(() => client.observeTaskConversation({ ...options, conversationId: id })),
      publish: (options) => client.publishTaskConversation({ ...options, conversationId: id }),
      querySource: (options) =>
        client.queryTaskConversationSource({ ...options, conversationId: id }),
      stop: (options = {}) => client.stopTaskConversation({ ...options, conversationId: id }),
      archive: () => client.archiveTaskConversation({ conversationId: id }),
      compact: (options) =>
        client.compactTaskConversationMember({ ...options, conversationId: id }),
    };
  };
  return {
    ref,
    create: async (options) => {
      const result = await client.createTaskConversation(options);
      if (result.error || !result.conversation)
        throw new Error(result.error ?? "The host did not create a task conversation");
      return ref(result.conversation);
    },
    resolve: async (options) => {
      const result = await client.resolveTaskConversation(options);
      if (result.error) throw new Error(result.error);
      return result.conversation ? ref(result.conversation) : null;
    },
  };
}
