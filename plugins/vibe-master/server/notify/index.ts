// Phone pushes for board events, sent through the daemon's push service (`server.notify`).
//   card.moved -> verifying    "Ready to verify"
//   session.waiting (worker)   "Needs your answer"  (Paseo already pushes the agent's own
//                              permission/question; agentAttention lets the daemon drop the twin)
//   session.stalled (worker)   "Agent stalled"  (watchdog: no output for too long; session.unstalled is silent)
//   session.reassigned         "Agent switched"  (a failed worker continued on a fallback preset)
//   session.error (worker)     "Agent failed"    (no fallback took over; agentAttention drops the daemon twin)
//   master.alert               "Master: quota low" etc. (the reminders of the master agent)
// Title = project name, body = event type, data = card key (+ agentId for session.waiting): never card text, so the push stays
// within the daemon's minimal-payload rule.

import { createEventConsumer, type EventConsumer, type VibeDb, type VibeStore } from "../vibe/db";
import { isEvent, type VibeEvent } from "../vibe/contract";

export interface PushNotification {
  title: string;
  body: string;
  data?: Record<string, unknown>;
  agentAttention?: { agentId: string; reason: "permission" | "finished" | "error" };
}

export interface NotifyOptions {
  db: VibeDb;
  store: VibeStore;
  notify: (notification: PushNotification) => void;
  pollIntervalMs?: number;
  onError?: (error: unknown, seq: number) => void;
}

const MASTER_ALERT_LABELS: Record<string, string> = {
  quota_low: "Master: quota low",
  quota_error: "Master: quota error",
  maintenance_paused: "Maintenance rule paused",
  permission_wait: "Master: waiting for permission",
  requirements_failed: "Master: requirements document not updated",
  review_loop: "Review: repeated severe issues",
};

export function startNotifyConsumer(options: NotifyOptions): EventConsumer {
  const { store } = options;

  function projectName(event: VibeEvent): string {
    const card = event.cardId ? store.cards.get(event.cardId) : undefined;
    const projectId = event.projectId ?? card?.projectId;
    return (projectId ? store.projects.get(projectId)?.name : undefined) ?? "Vibe Board";
  }

  function sessionPush(
    event: VibeEvent,
    session: NonNullable<ReturnType<typeof store.sessions.get>>,
    kind: string,
    body: string,
  ): PushNotification {
    const card = session.cardId ? store.cards.get(session.cardId) : undefined;
    return {
      title: projectName({ ...event, cardId: session.cardId ?? event.cardId }),
      body,
      data: { event: kind, ...(card ? { cardKey: card.key } : {}), agentId: session.agentId },
    };
  }

  function toNotification(event: VibeEvent): PushNotification | null {
    if (isEvent(event, "card.moved")) {
      if (event.payload.to !== "verifying") return null;
      const card = event.cardId ? store.cards.get(event.cardId) : undefined;
      return {
        title: projectName(event),
        body: "Ready to verify",
        data: { event: "card.verifying", ...(card ? { cardKey: card.key } : {}) },
      };
    }
    if (isEvent(event, "session.waiting")) {
      const session = store.sessions.get(event.payload.sessionId);
      if (!session || session.role !== "worker") return null;
      const agentId = event.payload.agentId ?? session.agentId;
      const card = session.cardId ? store.cards.get(session.cardId) : undefined;
      return {
        title: projectName({ ...event, cardId: session.cardId ?? event.cardId }),
        body: "Needs your answer",
        data: {
          event: "session.waiting",
          ...(card ? { cardKey: card.key } : {}),
          // Same field the daemon puts in its own agent pushes, so a tap opens the session.
          ...(agentId ? { agentId } : {}),
        },
        ...(agentId ? { agentAttention: { agentId, reason: "permission" as const } } : {}),
      };
    }
    if (isEvent(event, "session.stalled")) {
      const session = store.sessions.get(event.payload.sessionId);
      if (!session || session.role === "master") return null;
      return sessionPush(event, session, "session.stalled", "Agent stalled");
    }
    if (isEvent(event, "session.reassigned")) {
      const session = store.sessions.get(event.payload.sessionId);
      if (!session) return null;
      return sessionPush(event, session, "session.reassigned", "Agent switched");
    }
    if (isEvent(event, "session.error")) {
      const session = store.sessions.get(event.payload.sessionId);
      if (!session || session.role !== "worker") return null;
      return {
        ...sessionPush(event, session, "session.error", "Agent failed"),
        agentAttention: { agentId: session.agentId, reason: "error" as const },
      };
    }
    if (isEvent(event, "master.alert")) {
      return {
        title: "Vibe Board",
        body: MASTER_ALERT_LABELS[event.payload.kind] ?? "Master alert",
        data: { event: "master.alert", kind: event.payload.kind },
      };
    }
    return null;
  }

  const consumer = createEventConsumer({
    db: options.db,
    consumer: "vibe-master-notify",
    types: ["card.moved", "session.waiting", "session.stalled", "session.reassigned", "session.error", "master.alert"],
    // A restart must not replay old events as fresh pushes.
    startAt: "now",
    pollIntervalMs: options.pollIntervalMs,
    onError: options.onError,
    handler(event) {
      const notification = toNotification(event);
      if (notification) options.notify(notification);
    },
  });
  consumer.start();
  return consumer;
}
