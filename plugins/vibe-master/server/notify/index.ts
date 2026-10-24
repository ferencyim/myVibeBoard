import { isEvent, type VibeEvent } from "../vibe/contract";
import { createEventConsumer, type EventConsumer, type VibeDb, type VibeStore } from "../vibe/db";

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
  provider_error: "总 agent：预设内所有模型均不可用",
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
    const projectId = event.projectId;
    return (projectId ? store.projects.get(projectId)?.name : undefined) ?? "任务流程";
  }

  function sessionPush(
    event: VibeEvent,
    session: NonNullable<ReturnType<typeof store.sessions.get>>,
    kind: string,
    body: string,
  ): PushNotification {
    return {
      title: projectName({ ...event, projectId: event.projectId ?? session.projectId ?? null }),
      body,
      data: { event: kind, agentId: session.agentId },
    };
  }

  function toNotification(event: VibeEvent): PushNotification | null {
    if (isEvent(event, "session.waiting")) {
      const session = store.sessions.get(event.payload.sessionId);
      if (!session || session.role !== "worker") return null;
      const agentId = event.payload.agentId ?? session.agentId;
      return {
        title: projectName({ ...event, projectId: event.projectId ?? session.projectId ?? null }),
        body: "Needs your answer",
        data: {
          event: "session.waiting",
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
        title: "总 agent",
        body: MASTER_ALERT_LABELS[event.payload.kind] ?? "Master alert",
        data: { event: "master.alert", kind: event.payload.kind },
      };
    }
    return null;
  }

  const consumer = createEventConsumer({
    db: options.db,
    consumer: "vibe-master-notify",
    types: [
      "session.waiting",
      "session.stalled",
      "session.reassigned",
      "session.error",
      "master.alert",
    ],
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
