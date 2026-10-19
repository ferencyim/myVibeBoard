/* oxlint-disable typescript-eslint/no-explicit-any -- reads untyped RPC answers */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalVibeRpc } from "../rpc/local-rpc";
import { LocalReplica } from "../store/replica";
import { createTestDb } from "../store/test-db";
import { createSyncEngine } from "../sync/engine";
import { createFakeDaemon, seedBoard } from "../sync/test-daemon";
import { replyOutcomeMessage } from "./queue";

const WAITING = {
  card_id: "C3",
  agent_id: "agent-w",
  role: "worker",
  current_provider: "codex",
  switch_history_json: "[]",
  state: "waiting",
  waiting_since: "2026-10-03T00:05:00.000Z",
  pending_question_json: JSON.stringify({ requestId: "q1", kind: "tool", name: "Bash" }),
  last_activity_at: "2026-10-03T00:05:00.000Z",
  started_at: "2026-10-03T00:00:00.000Z",
};

async function setup() {
  const daemon = createFakeDaemon();
  seedBoard(daemon);
  daemon.publish("agent_session", "S2", WAITING);
  const replica = LocalReplica.open(createTestDb());
  await createSyncEngine({ replica, invoke: (m, i) => daemon.invoke(m, i) }).run();
  const rpc = createLocalVibeRpc(replica);
  /** The daemon side of the reply RPCs; `open` says whether the question is still waiting. */
  const calls: string[] = [];
  let open = true;
  const online = createSyncEngine({
    replica,
    invoke: async (method, input) => {
      if (method === "vibe.reply.check") return { state: open ? "pending" : "answered" };
      if (method === "vibe.reply.send") {
        calls.push((input as { id: string }).id);
        return { sent: true, duplicate: false };
      }
      return daemon.invoke(method, input);
    },
  });
  return { daemon, replica, rpc, online, calls, close: () => void (open = false) };
}

describe("offline reply queue", () => {
  beforeEach(() => void vi.spyOn(console, "warn").mockImplementation(() => undefined));

  it("shows the as-of time and the sessions as of the last sync", async () => {
    const { rpc, replica } = await setup();
    const status = (await rpc.invoke("vibe.local.status", {})) as any;
    expect(status).toMatchObject({ offline: true, replies: [] });
    expect(status.asOf).toBe(replica.asOf);
    expect(status.asOf).toBeGreaterThan(0);
    const { sessions } = (await rpc.invoke("vibe.sessions.list", {})) as any;
    expect(sessions.find((s: any) => s.agentId === "agent-w")).toMatchObject({
      state: "waiting",
      pendingQuestion: { requestId: "q1" },
    });
    // survives a restart: the banner still says when the data is from
    expect(LocalReplica.open(replica.db).asOf).toBe(replica.asOf);
  });

  it("queues an offline answer and sends it after reconnecting while the question is open", async () => {
    const { rpc, replica, online, calls } = await setup();
    const result = await rpc.invoke("vibe.reply.send", {
      id: "r1",
      cardId: "C3",
      questionId: "q1",
      text: " yes ",
    });
    expect(result).toEqual({ sent: false, duplicate: false });
    expect(((await rpc.invoke("vibe.local.status", {})) as any).replies).toMatchObject([
      { questionId: "q1", text: "yes", status: "pending" },
    ]);
    expect(LocalReplica.open(replica.db).replies.list("pending")).toHaveLength(1);

    const run = await online.run();
    expect(run.replies).toMatchObject({ sent: ["r1"], stale: [] });
    expect(calls).toEqual(["r1"]);
    expect(replyOutcomeMessage(run.replies)).toBe("已发送 1 条离线回复");
    expect(((await rpc.invoke("vibe.local.status", {})) as any).replies).toEqual([]);
    await online.run();
    expect(calls).toEqual(["r1"]); // never sent twice
  });

  it("does not send when the question was answered meanwhile and leaves a note", async () => {
    const { rpc, online, calls, close } = await setup();
    await rpc.invoke("vibe.reply.send", { cardId: "C3", questionId: "q1", text: "no" });
    close();
    const run = await online.run();
    expect(run.replies?.stale).toHaveLength(1);
    expect(calls).toEqual([]);
    expect(replyOutcomeMessage(run.replies)).toContain("未发送");
    const { events } = (await rpc.invoke("vibe.events.list", { card: "ALP-3" })) as any;
    expect(events.at(-1).body).toMatchObject({
      kind: "reply_stale",
      questionId: "q1",
      text: "no",
      reason: "already_answered",
    });
  });

  it("refuses answers to questions that are not waiting in the replica", async () => {
    const { rpc } = await setup();
    await expect(
      rpc.invoke("vibe.reply.send", { cardId: "C3", questionId: "nope", text: "x" }),
    ).rejects.toThrow("[stale]");
    await expect(
      rpc.invoke("vibe.reply.send", { cardId: "C3", questionId: "q1", text: "  " }),
    ).rejects.toThrow("[stale]");
  });
});
