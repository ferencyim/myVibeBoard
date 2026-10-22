import { describe, expect, it } from "vitest";
import { createWakeQueue } from "../server/wake/queue";
import { createMasterRuntime } from "../server/runtime";
import { createStateFile } from "../server/subscription/state";
import { MasterError } from "../server/types";
import { publishEvent } from "../server/vibe/db";
import {
  ManualClock,
  defaultSettings,
  deferred,
  fakePaseo,
  setupBoard,
  tempDir,
  tick,
} from "./helpers";

describe("wake queue", () => {
  it("runs jobs one at a time, merges duplicates and parks blocked jobs until resume", async () => {
    const order: string[] = [];
    const gate = deferred();
    let blockNext = true;
    const queue = createWakeQueue({
      async run(job) {
        order.push(`start ${job.cardId}`);
        if (job.cardId === "a") await gate.promise;
        if (job.cardId === "b" && blockNext) throw new MasterError("quota", "limit");
        order.push(`end ${job.cardId}`);
      },
      onFailure: (_job, error) => (error instanceof MasterError ? "block" : "drop"),
    });
    queue.enqueue({ kind: "card_done", cardId: "a" });
    queue.enqueue({ kind: "card_done", cardId: "b" });
    queue.enqueue({ kind: "card_done", cardId: "b" }); // merged
    await tick();
    expect(order).toEqual(["start a"]);
    expect(queue.snapshot().pending).toHaveLength(1);
    gate.resolve();
    await queue.idle();
    expect(order).toEqual(["start a", "end a", "start b"]);
    expect(queue.snapshot().blocked).toHaveLength(1);
    blockNext = false;
    queue.resume();
    await queue.idle();
    expect(order.slice(-2)).toEqual(["start b", "end b"]);
    expect(queue.snapshot().blocked).toHaveLength(0);
  });

  it("exclusive work waits for the running job and holds back the next one", async () => {
    const order: string[] = [];
    const gate = deferred();
    const queue = createWakeQueue({
      async run(job) {
        order.push(`run ${job.cardId}`);
        if (job.cardId === "a") await gate.promise;
      },
      onFailure: () => "drop",
    });
    queue.enqueue({ kind: "card_done", cardId: "a" });
    queue.enqueue({ kind: "card_done", cardId: "b" });
    await tick();
    const exclusive = queue.exclusive(async () => void order.push("exclusive"));
    gate.resolve();
    await exclusive;
    await queue.idle();
    expect(order).toEqual(["run a", "exclusive", "run b"]);
  });
});

function runtimeFor(board: ReturnType<typeof setupBoard>, replies: (prompt: string) => string, over = {}) {
  const clock = new ManualClock();
  const fake = fakePaseo(({ prompt }) => replies(prompt));
  const settings = defaultSettings(over);
  const runtime = createMasterRuntime({
    db: board.db,
    store: board.store,
    getPaseo: () => fake.paseo,
    settings: () => settings,
    dataDir: tempDir(),
    clock,
    pollIntervalMs: 3_600_000,
    log: () => undefined,
  });
  return { runtime, clock, fake };
}

const CONSOLIDATED = JSON.stringify({
  summary: "Recorded the dark mode decision.",
  lessons: [{ tag: "ui", body: "Use theme tokens." }],
});

function finish(board: ReturnType<typeof setupBoard>, title: string) {
  const card = board.store.cards.create({ projectId: board.project.id, title }, "user");
  board.store.cards.move(card.id, { to: "todo", actor: "user" });
  const dispatched = board.store.cards.dispatch({ cardId: card.id, agentId: `worker-${title}`, provider: "claude", worktree: null });
  return { card, dispatched };
}
const memoryNote = (board: ReturnType<typeof setupBoard>, cardId: string) =>
  board.store.events.list(cardId).find((e) => (e.body as { kind?: string })?.kind === "memory_update");

describe("wake triggers", () => {
  it("stays out of the card flow: creating, editing, review requests and questions wake nobody", async () => {
    const board = setupBoard();
    const { runtime, clock, fake } = runtimeFor(board, () => CONSOLIDATED);
    const card = board.draft("Plain draft");
    board.store.cards.update(card.id, { description: "more detail" });
    board.store.cards.move(card.id, { to: "todo", actor: "user" });
    board.store.cards.move(card.id, { to: "draft", actor: "user" });
    publishEvent(board.db, {
      type: "card.review_requested",
      cardId: card.id,
      projectId: board.project.id,
      payload: { cardId: card.id, requestedBy: "user" },
    });
    board.store.cards.move(card.id, { to: "todo", actor: "user" });
    const dispatched = board.store.cards.dispatch({ cardId: card.id, agentId: "worker-1", provider: "claude", worktree: null });
    board.store.sessions.setState(dispatched.session.id, "waiting", { question: { requestId: "r1", title: "Which theme?" } });

    await runtime.triggers.consumer.poll();
    clock.advance(300_000);
    await runtime.queue.idle();
    expect(runtime.queue.snapshot()).toMatchObject({ running: null, pending: [], blocked: [] });
    expect(fake.agents).toHaveLength(0);
    await runtime.dispose();
  });

  it("consolidates memory when a card is done", async () => {
    const board = setupBoard();
    const { runtime, fake } = runtimeFor(board, () => CONSOLIDATED);
    const { card, dispatched } = finish(board, "Ship it");
    board.store.sessions.setState(dispatched.session.id, "idle");
    board.store.cards.move(card.id, { to: "verifying", actor: "lifecycle" });
    board.store.cards.move(card.id, { to: "done", actor: "user" });
    await runtime.triggers.consumer.poll();
    await runtime.queue.idle();
    expect(memoryNote(board, card.id)).toBeTruthy();
    expect(fake.agents).toHaveLength(1);
    expect(fake.agents[0]!.prompts[0]).toContain("[wake:card_done]");
    // a master session is never mistaken for a worker
    expect(board.store.sessions.list({ role: "master" })).toHaveLength(1);
    await runtime.dispose();
  });

  it("does nothing when the master is disabled", async () => {
    const board = setupBoard();
    const { runtime, fake } = runtimeFor(board, () => CONSOLIDATED, { enabled: false });
    const { card } = finish(board, "Ignored");
    board.store.cards.move(card.id, { to: "verifying", actor: "lifecycle" });
    board.store.cards.move(card.id, { to: "done", actor: "user" });
    await runtime.triggers.consumer.poll();
    await runtime.queue.idle();
    expect(fake.agents).toHaveLength(0);
    await runtime.dispose();
  });

  it("holds jobs until a daemon handle exists, then runs them", async () => {
    const board = setupBoard();
    const clock = new ManualClock();
    const fake = fakePaseo(() => CONSOLIDATED);
    let handle: typeof fake.paseo | null = null;
    const runtime = createMasterRuntime({
      db: board.db,
      store: board.store,
      getPaseo: () => handle,
      settings: () => defaultSettings(),
      dataDir: tempDir(),
      clock,
      pollIntervalMs: 3_600_000,
      log: () => undefined,
    });
    const { card } = finish(board, "Waits for the daemon");
    board.store.cards.move(card.id, { to: "verifying", actor: "lifecycle" });
    board.store.cards.move(card.id, { to: "done", actor: "user" });
    await runtime.triggers.consumer.poll();
    await runtime.queue.idle();
    expect(runtime.queue.snapshot().blocked).toHaveLength(1);
    expect(memoryNote(board, card.id)).toBeUndefined();

    handle = fake.paseo;
    runtime.onPaseoAvailable();
    await runtime.queue.idle();
    expect(memoryNote(board, card.id)).toBeTruthy();
    await runtime.dispose();
  });

  it("sweeps recently done cards without a memory update on start", async () => {
    const board = setupBoard();
    const { runtime, fake, clock } = runtimeFor(board, () => CONSOLIDATED);
    clock.advance(Date.now() - clock.now()); // the sweep window compares with real board timestamps
    const done = ["A", "B"].map((t) => {
      const { card } = finish(board, t);
      board.store.cards.move(card.id, { to: "verifying", actor: "lifecycle" });
      board.store.cards.move(card.id, { to: "done", actor: "user" });
      return card;
    });
    board.draft("A draft is never swept");
    expect(runtime.sweep()).toBe(2);
    await runtime.queue.idle();
    expect(fake.agents[0]!.prompts).toHaveLength(2);
    // everything consolidated is not queued again
    expect(done.every((c) => memoryNote(board, c.id))).toBe(true);
    expect(runtime.sweep()).toBe(0);
    await runtime.dispose();
  });

  it("keeps the state file readable", () => {
    const dir = tempDir();
    const file = createStateFile(dir);
    expect(file.read()).toEqual({});
    file.update((s) => ({ ...s, target: { provider: "claude", model: "m", thinking: null } }));
    expect(createStateFile(dir).read().target?.model).toBe("m");
  });
});
