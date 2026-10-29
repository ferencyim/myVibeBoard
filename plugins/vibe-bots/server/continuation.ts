import { EVENT_PAYLOADS } from "./vibe/contract/events";
import { clearInterval, setInterval } from "node:timers";
import { createEventConsumer, publishEvent } from "./vibe/db/events";
import type { VibeDb } from "./vibe/db/sqlite";
import type { BotService } from "./service";

interface PendingContinuation {
  request_id: string;
  payload_json: string;
}

/** Busy requests remain durable and are retried after idle, including across daemon restarts. */
export function registerBotContinuations(db: VibeDb, service: BotService) {
  let stopped = false;
  let work: Promise<void> | null = null;
  const consumer = createEventConsumer({
    db,
    consumer: "vibe-bots:master-continuations",
    types: ["context.continuation_requested"],
    handler: async (event) => {
      if (event.type !== "context.continuation_requested") return;
      const request = EVENT_PAYLOADS["context.continuation_requested"].parse(event.payload);
      if (request.role !== "master") return;
      await service.ready();
      db.prepare(`INSERT OR IGNORE INTO bot_continuation_request(request_id,payload_json)
        VALUES(?,?)`).run(request.requestId, JSON.stringify(request));
    },
    onError: (error) => console.error("[vibe-bots] 接续请求入队失败", error),
  });

  async function drain() {
    await service.ready();
    const pending = db.prepare<PendingContinuation>(
      "SELECT request_id,payload_json FROM bot_continuation_request WHERE result_json IS NULL",
    ).all();
    for (const row of pending) {
      if (stopped) return;
      const request = EVENT_PAYLOADS["context.continuation_requested"].parse(JSON.parse(row.payload_json));
      try {
        const result = await service.continueConversation(request);
        if (result.status === "paused") continue;
        const payload = { requestId: request.requestId, workspaceId: null, ...result };
        db.immediate(() => {
          publishEvent(db, {
            type: "context.continuation_result",
            dedupeKey: "bot_continuation:" + request.requestId,
            payload,
          });
          db.prepare("UPDATE bot_continuation_request SET result_json=? WHERE request_id=?")
            .run(JSON.stringify(payload), row.request_id);
        });
      } catch (error) {
        // A transient host failure must not consume the durable request or its authority.
        console.error("[vibe-bots] 接续暂未完成，将重试", error);
      }
    }
  }

  function poll() {
    if (stopped || work) return;
    work = drain().catch((error) => console.error("[vibe-bots] 接续队列读取失败", error))
      .finally(() => { work = null; });
  }

  const timer = setInterval(poll, 1000);
  consumer.start();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await consumer.stop();
    await work;
  };
}
