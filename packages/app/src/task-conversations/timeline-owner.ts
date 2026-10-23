import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  TaskConversationPage,
  TaskConversationCursor,
  TaskConversationFetchResponse,
} from "@getpaseo/protocol/messages";
import { taskConversationKey, useTaskConversationStore } from "./store";
import { getHostRuntimeStore } from "@/runtime/host-runtime";

const PAGE_SIZE = 100;
type ConversationClient = Pick<
  DaemonClient,
  "observeTaskConversation" | "fetchTaskConversation" | "subscribeConnectionStatus" | "isConnected"
>;
interface TimelineObservation {
  users: number;
  release(): void;
  retry(): void;
}
const observations = new WeakMap<ConversationClient, Map<string, TimelineObservation>>();
const preparingReplicas = new Map<string, Promise<void>>();

export function retryTaskConversationTimeline(
  client: ConversationClient,
  serverId: string,
  conversationId: string,
): void {
  observations.get(client)?.get(taskConversationKey(serverId, conversationId))?.retry();
}

export function prepareTaskConversationReplica(
  serverId: string,
  conversationId: string,
): Promise<void> {
  const key = taskConversationKey(serverId, conversationId);
  const existing = preparingReplicas.get(key);
  if (existing) return existing;
  const request = getHostRuntimeStore()
    .readTaskConversationReplica(serverId, conversationId)
    .then((cached) => {
      if (!cached?.taskConversation) return undefined;
      const store = useTaskConversationStore.getState();
      if (store.timelines.get(key)?.epoch) return undefined;
      store.setConversation(serverId, cached.taskConversation.conversation);
      const replica = cached.taskConversation;
      store.updateTimeline(serverId, conversationId, (state) => ({
        ...state,
        rows: replica.rows,
        epoch: cached.range?.epoch ?? null,
        startSeq: cached.range?.startSeq ?? null,
        endSeq: cached.range?.endSeq ?? null,
        hasOlder: cached.hasOlder,
        sync: "reconnecting",
      }));
      return undefined;
    })
    .finally(() => preparingReplicas.delete(key));
  preparingReplicas.set(key, request);
  return request;
}

function requirePage(result: TaskConversationFetchResponse["payload"]): TaskConversationPage {
  if (result.error || !result.page) throw new Error(result.error ?? "宿主未返回任务历史。");
  return result.page;
}

export function observeTaskConversationTimeline(
  client: ConversationClient,
  serverId: string,
  conversationId: string,
): () => void {
  let byKey = observations.get(client);
  if (!byKey) {
    byKey = new Map();
    observations.set(client, byKey);
  }
  const key = taskConversationKey(serverId, conversationId);
  const existing = byKey.get(key);
  if (existing) {
    existing.users += 1;
    return () => {
      if (--existing.users === 0) {
        existing.release();
        byKey.delete(key);
      }
    };
  }
  const store = useTaskConversationStore.getState;
  const runtime = getHostRuntimeStore();
  const update = (change: Parameters<ReturnType<typeof store>["updateTimeline"]>[2]) =>
    store().updateTimeline(serverId, conversationId, change);
  let active = true;
  let fetching = false;
  let retryDelay = 1000;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let subscription: ReturnType<ConversationClient["observeTaskConversation"]> | null = null;
  let unsubscribe = () => {};
  let preparing = true;

  function failed(error: unknown) {
    if (!active) return;
    if (!client.isConnected) {
      update((state) => ({ ...state, sync: "reconnecting", error: null }));
      return;
    }
    if (retryTimer === null) {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (!subscription) start();
        else void catchUp();
      }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 30000);
    }
    update((state) => ({
      ...state,
      sync: "error",
      error: error instanceof Error ? error.message : String(error),
    }));
  }

  async function fetchCatchUpPage(cursor: TaskConversationCursor | undefined) {
    let direction: "after" | "tail" = cursor ? "after" : "tail";
    let page = requirePage(
      await client.fetchTaskConversation({ conversationId, direction, cursor, limit: PAGE_SIZE }),
    );
    if (cursor && cursor.epoch !== page.epoch) {
      direction = "tail";
      page = requirePage(
        await client.fetchTaskConversation({ conversationId, direction, limit: PAGE_SIZE }),
      );
    }
    return { direction, page };
  }

  async function catchUp() {
    if (!active || !client.isConnected || fetching || retryTimer !== null) return;
    fetching = true;
    try {
      let needsMore = true;
      while (needsMore) {
        if (!active) return;
        const current = store().timelines.get(key);
        const cursor =
          current?.epoch && current.endSeq !== null
            ? { epoch: current.epoch, seq: current.endSeq }
            : undefined;
        const { direction, page } = await fetchCatchUpPage(cursor);
        if (!active) return;
        store().applyPage(serverId, page, direction);
        needsMore = store().timelines.get(key)?.needsRefresh === true;
        const noProgress = needsMore && page.endCursor?.seq === cursor?.seq;
        if (noProgress) throw new Error("任务历史补齐未取得进展，请重试。");
      }
      retryDelay = 1000;
      update((state) => ({ ...state, sync: "ready", error: null }));
    } catch (error) {
      failed(error);
    } finally {
      fetching = false;
    }
  }

  function applySnapshotPage(page: TaskConversationPage) {
    const current = store().timelines.get(key);
    const overlap =
      current?.epoch === page.epoch &&
      current.endSeq !== null &&
      (page.startCursor === null || page.startCursor.seq <= current.endSeq + 1);
    store().applyPage(serverId, page, overlap ? "after" : "tail");
    if (page.hasNewer) void catchUp();
  }

  function start() {
    // DaemonClient becomes connected only after accepting server_info and its feature flags.
    if (!active || preparing || subscription || !client.isConnected) return;
    const current = store().timelines.get(key);
    const cursor =
      current?.epoch && current.endSeq !== null
        ? { epoch: current.epoch, seq: current.endSeq }
        : undefined;
    try {
      const owned = client.observeTaskConversation({ conversationId, cursor, limit: PAGE_SIZE });
      subscription = owned;
      unsubscribe = owned.subscribe({
        snapshot(snapshot) {
          if (!active) return;
          if (snapshot.error) {
            void subscription?.release().catch(() => {});
            subscription = null;
            failed(new Error(snapshot.error));
            return;
          }
          if (snapshot.conversation) store().setConversation(serverId, snapshot.conversation);
          if (snapshot.page) applySnapshotPage(snapshot.page);
          retryDelay = 1000;
          if (retryTimer !== null) clearTimeout(retryTimer);
          retryTimer = null;
        },
        update(message) {
          if (!active || message.type !== "task.conversation.update") return;
          const { conversation, row } = message.payload;
          if (conversation) store().setConversation(serverId, conversation);
          if (row) store().applyRow(serverId, conversationId, row, message.payload.eventSeq);
        },
        error(error) {
          unsubscribe();
          subscription = null;
          failed(error);
        },
      });
      void owned.ready.catch(() => {});
    } catch (error) {
      unsubscribe();
      void subscription?.release().catch(() => {});
      subscription = null;
      failed(error);
    }
  }
  const unwatch = useTaskConversationStore.subscribe((state) => {
    if (preparing) return;
    const conversation = state.conversations.get(key);
    const timeline = state.timelines.get(key);
    const canPersist = conversation && timeline?.epoch === conversation.epoch;
    if (canPersist && timeline) {
      const range =
        timeline.epoch !== null &&
        timeline.startSeq !== null &&
        timeline.endSeq !== null &&
        !timeline.needsRefresh
          ? { epoch: timeline.epoch, startSeq: timeline.startSeq, endSeq: timeline.endSeq }
          : null;
      runtime.commitTaskConversationReplica(serverId, conversationId, {
        agentId: `task-conversation:${conversationId}`,
        items: [],
        range,
        hasOlder: timeline.hasOlder,
        taskConversation: { conversation, rows: timeline.rows },
      });
    }
    if (state.timelines.get(key)?.needsRefresh) void catchUp();
  });
  const unwatchConnection = client.subscribeConnectionStatus((connection) => {
    if (connection.status !== "connected") {
      update((state) => ({ ...state, sync: "reconnecting" }));
      return;
    }
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    retryDelay = 1000;
    if (!subscription) start();
    else void catchUp();
  });
  const observation: TimelineObservation = {
    users: 1,
    retry() {
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
      update((state) => ({ ...state, sync: "loading", error: null }));
      if (!subscription) start();
      else void catchUp();
    },
    release() {
      active = false;
      unwatch();
      unwatchConnection();
      unsubscribe();
      if (retryTimer !== null) clearTimeout(retryTimer);
      void subscription?.release().catch(() => {});
    },
  };
  byKey.set(key, observation);
  void prepareTaskConversationReplica(serverId, conversationId)
    .catch(failed)
    .finally(() => {
      preparing = false;
      start();
    })
    .catch(failed);
  return () => {
    if (--observation.users === 0) {
      observation.release();
      byKey.delete(key);
    }
  };
}

export async function loadOlderTaskConversation(
  client: Pick<ConversationClient, "fetchTaskConversation">,
  serverId: string,
  conversationId: string,
): Promise<boolean> {
  const key = taskConversationKey(serverId, conversationId);
  const store = useTaskConversationStore.getState();
  const current = store.timelines.get(key);
  if (!current?.hasOlder || !current.epoch || current.startSeq === null || current.loadingOlder)
    return false;
  const cursor = { epoch: current.epoch, seq: current.startSeq };
  store.updateTimeline(serverId, conversationId, (state) => ({ ...state, loadingOlder: true }));
  try {
    const result = await client.fetchTaskConversation({
      conversationId,
      direction: "before",
      cursor,
      limit: PAGE_SIZE,
    });
    if (result.error || !result.page) throw new Error(result.error ?? "无法读取更早的消息。");
    const latest = useTaskConversationStore.getState().timelines.get(key);
    if (latest?.epoch === cursor.epoch && latest.startSeq === cursor.seq)
      store.applyPage(serverId, result.page, "before");
    return true;
  } catch (error) {
    store.updateTimeline(serverId, conversationId, (state) => ({
      ...state,
      error: error instanceof Error ? error.message : String(error),
    }));
    return false;
  } finally {
    store.updateTimeline(serverId, conversationId, (state) => ({ ...state, loadingOlder: false }));
  }
}
