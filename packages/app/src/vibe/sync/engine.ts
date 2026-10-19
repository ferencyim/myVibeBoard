// Sync engine of the phone replica: one `vibe.sync.exchange` round (looped by ClientSync until the
// daemon has nothing more), then the offline reply queue. Transport-agnostic: the caller passes
// the online RPC invoker, tests pass a fake daemon.

import type { ExchangeResponse, FlushResult, Rejection, QuestionState } from "../generated/sync";
import type { LocalReplica } from "../store/replica";

export const SYNC_INTERVAL_MS = 10_000;

export type SyncInvoke = (method: string, input: unknown) => Promise<unknown>;

export interface SyncRunResult {
  ok: boolean;
  rejected: Rejection[];
  replies: FlushResult | null;
}

export function createSyncEngine(deps: { replica: LocalReplica; invoke: SyncInvoke }) {
  const { replica, invoke } = deps;

  async function exchange(): Promise<Rejection[]> {
    const outcome = await replica.sync.sync(async (request) => {
      const response = (await invoke("vibe.sync.exchange", request)) as ExchangeResponse;
      if (typeof response?.ok !== "boolean") throw new Error("Malformed sync response");
      return response;
    });
    return outcome.rejected;
  }

  async function flushReplies(): Promise<FlushResult | null> {
    if (replica.replies.list("pending").length === 0) return null;
    const payload = (r: { id: string; cardId: string; questionId: string; text: string }) => ({
      id: r.id,
      cardId: r.cardId,
      questionId: r.questionId,
      text: r.text,
    });
    const result = await replica.replies.flush({
      check: async (r) =>
        ((await invoke("vibe.reply.check", payload(r))) as { state: QuestionState }).state,
      send: async (r) => void (await invoke("vibe.reply.send", payload(r))),
    });
    replica.persistReplies();
    return result;
  }

  /** Never throws: a failed round (daemon unreachable, ...) is retried by the next trigger. */
  async function run(): Promise<SyncRunResult> {
    try {
      const rejected = await exchange();
      return { ok: true, rejected, replies: await flushReplies() };
    } catch (error) {
      console.warn("[Vibe] Sync failed", error);
      return { ok: false, rejected: [], replies: null };
    }
  }

  return { run };
}

export type VibeSyncEngine = ReturnType<typeof createSyncEngine>;
