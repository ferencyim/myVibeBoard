import { describe, expect, it } from "vitest";
import { startNotifyConsumer, type PushNotification } from "../server/notify";
import { publishEvent } from "../server/vibe/db";
import { setupBoard } from "./helpers";

function start() {
  const board = setupBoard();
  const sent: PushNotification[] = [];
  const consumer = startNotifyConsumer({
    db: board.db,
    store: board.store,
    notify: (n) => sent.push(n),
    pollIntervalMs: 60_000,
  });
  return { board, sent, consumer };
}

describe("push notifier", () => {
  it("does not push for the master's own waiting session", async () => {
    const { board, sent, consumer } = start();
    const session = board.store.sessions.start({
      cardId: null,
      role: "master",
      agentId: "master-1",
      provider: "claude",
    });
    board.store.sessions.setState(session.id, "waiting", { question: { title: "x" } });
    await consumer.poll();
    expect(sent).toEqual([]);
    await consumer.stop();
  });

  it("pushes master alerts by kind, without the message text", async () => {
    const { board, sent, consumer } = start();
    publishEvent(board.db, {
      type: "master.alert",
      payload: { kind: "quota_low", provider: "codex", message: "codex: 9% quota left" },
    });
    await consumer.poll();
    expect(sent).toEqual([
      {
        title: "总 agent",
        body: "Master: quota low",
        data: { event: "master.alert", kind: "quota_low" },
      },
    ]);
    await consumer.stop();
  });

  it("labels the permission_wait alert", async () => {
    const { board, sent, consumer } = start();
    publishEvent(board.db, {
      type: "master.alert",
      payload: { kind: "permission_wait", message: "x" },
    });
    await consumer.poll();
    expect(sent[0]?.body).toBe("Master: waiting for permission");
    await consumer.stop();
  });
});

describe("stall / failover pushes", () => {
  function workerSession() {
    const ctx = start();
    const { board } = ctx;
    const session = board.store.sessions.start({
      cardId: null,
      projectId: board.project.id,
      role: "worker",
      agentId: "worker-1",
      provider: "claude",
    });
    board.store.sessions.setState(session.id, "working");
    return { ...ctx, session };
  }

  it("pushes session.stalled with project name and agent id only; unstall is silent", async () => {
    const { board, sent, consumer, session } = workerSession();
    board.store.sessions.markStalled(session.id, { idleMs: 600_000 });
    board.store.sessions.touchActivity(session.id);
    await consumer.poll();
    expect(sent).toEqual([
      {
        title: "Demo",
        body: "Agent stalled",
        data: { event: "session.stalled", agentId: "worker-1" },
      },
    ]);
    expect(JSON.stringify(sent)).not.toContain("Secret title");
    await consumer.stop();
  });

  it("pushes a reassignment once", async () => {
    const { board, sent, consumer, session } = workerSession();
    board.store.sessions.recordReassign({
      fromSessionId: session.id,
      agentId: "worker-2",
      provider: "codex",
      reason: "quota: limit",
    });
    await consumer.poll();
    expect(sent).toEqual([
      {
        title: "Demo",
        body: "Agent switched",
        data: { event: "session.reassigned", agentId: "worker-2" },
      },
    ]);
    await consumer.stop();
  });

  it("pushes a worker error (deduped against Paseo's own push) but not other roles", async () => {
    const { board, sent, consumer, session } = workerSession();
    board.store.sessions.setState(session.id, "error", { message: "login expired" });
    const planner = board.store.sessions.start({
      cardId: null,
      role: "planner",
      agentId: "p1",
      provider: "claude",
    });
    board.store.sessions.setState(planner.id, "error", { message: "x" });
    await consumer.poll();
    expect(sent).toEqual([
      {
        title: "Demo",
        body: "Agent failed",
        data: { event: "session.error", agentId: "worker-1" },
        agentAttention: { agentId: "worker-1", reason: "error" },
      },
    ]);
    await consumer.stop();
  });
});
