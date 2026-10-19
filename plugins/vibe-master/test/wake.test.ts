import { describe, expect, it } from "vitest";
import { createDebouncer } from "../server/wake/debounce";
import { createWakeQueue } from "../server/wake/queue";
import { createMasterRuntime } from "../server/runtime";
import { createStateFile } from "../server/subscription/state";
import { MasterError } from "../server/types";
import {
  ManualClock,
  assessmentJson,
  defaultSettings,
  deferred,
  fakePaseo,
  setupBoard,
  tempDir,
  tick,
} from "./helpers";

describe("debouncer", () => {
  it("fires once after the quiet period and restarts on every touch", () => {
    const clock = new ManualClock();
    const fired: string[] = [];
    const d = createDebouncer<string>(clock, () => 30_000, (k) => fired.push(k));
    d.touch("a");
    clock.advance(20_000);
    d.touch("a");
    clock.advance(20_000);
    expect(fired).toEqual([]);
    clock.advance(10_000);
    expect(fired).toEqual(["a"]);
    d.touch("b", 0);
    clock.advance(0);
    expect(fired).toEqual(["a", "b"]);
    d.touch("c");
    d.cancel("c");
    clock.advance(60_000);
    expect(fired).toEqual(["a", "b"]);
  });
});

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
    queue.enqueue({ kind: "assess_draft", cardId: "a" });
    queue.enqueue({ kind: "assess_draft", cardId: "b" });
    queue.enqueue({ kind: "assess_draft", cardId: "b" }); // merged
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
    queue.enqueue({ kind: "assess_draft", cardId: "a" });
    queue.enqueue({ kind: "assess_draft", cardId: "b" });
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
  const settings = defaultSettings({ debounceSeconds: 30, ...over });
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

describe("wake triggers", () => {
  it("assesses a new draft once the 30 s quiet period ended (within one minute)", async () => {
    const board = setupBoard();
    const { runtime, clock, fake } = runtimeFor(board, () => assessmentJson());
    const card = board.draft("Fresh draft");
    await runtime.triggers.consumer.poll();
    await expect(runtime.status(false)).resolves.toMatchObject({ queue: { pending: [{ cardKey: card.key }] } });

    clock.advance(29_000);
    await tick();
    expect(fake.agents).toHaveLength(0);
    clock.advance(1_000);
    await runtime.queue.idle();

    expect(board.store.events.list(card.id).filter((e) => e.type === "evaluation")).toHaveLength(1);
    expect(fake.agents).toHaveLength(1);
    expect(board.eventTypes()).toContain("card.assessed");
    await runtime.dispose();
  });

  it("restarts the quiet period on edits and ignores the master's own write-back", async () => {
    const board = setupBoard();
    const { runtime, clock, fake } = runtimeFor(board, () => assessmentJson());
    const card = board.draft("Edited twice");
    await runtime.triggers.consumer.poll();
    clock.advance(25_000);
    board.store.cards.update(card.id, { description: "more detail" });
    await runtime.triggers.consumer.poll();
    clock.advance(25_000);
    await tick();
    expect(fake.agents).toHaveLength(0);
    clock.advance(5_000);
    await runtime.queue.idle();
    expect(fake.agents[0]!.prompts).toHaveLength(1);
    expect(fake.agents[0]!.prompts[0]).toContain("more detail");

    // the write-back emitted card.updated(suggested_preset_id) + plan.updated: no new wake
    await runtime.triggers.consumer.poll();
    expect(runtime.triggers.debouncer.pending()).toEqual([]);
    // priority changes are not owner content either
    board.store.cards.update(card.id, { priority: "high" });
    await runtime.triggers.consumer.poll();
    expect(runtime.triggers.debouncer.pending()).toEqual([]);
    await runtime.dispose();
  });

  it("does not wake for cards outside draft, or when disabled", async () => {
    const board = setupBoard();
    const { runtime, clock, fake } = runtimeFor(board, () => assessmentJson(), { enabled: false });
    board.draft("Ignored while disabled");
    await runtime.triggers.consumer.poll();
    clock.advance(120_000);
    await runtime.queue.idle();
    expect(fake.agents).toHaveLength(0);
    await runtime.dispose();

    const board2 = setupBoard();
    const second = runtimeFor(board2, () => assessmentJson());
    const todo = board2.store.cards.create({ projectId: board2.project.id, title: "Already todo", column: "todo" }, "user");
    await second.runtime.triggers.consumer.poll();
    second.clock.advance(120_000);
    await second.runtime.queue.idle();
    expect(second.fake.agents).toHaveLength(0);
    expect(todo.column).toBe("todo");
    await second.runtime.dispose();
  });

  it("wakes for a card moved back to draft and cancels the wake when it leaves draft", async () => {
    const board = setupBoard();
    const { runtime, clock, fake } = runtimeFor(board, () => assessmentJson());
    const card = board.draft("Ping pong");
    await runtime.triggers.consumer.poll();
    board.store.cards.move(card.id, { to: "todo", actor: "user" });
    await runtime.triggers.consumer.poll();
    clock.advance(60_000);
    await runtime.queue.idle();
    expect(fake.agents).toHaveLength(0);

    board.store.cards.move(card.id, { to: "draft", actor: "user" });
    await runtime.triggers.consumer.poll();
    clock.advance(30_000);
    await runtime.queue.idle();
    expect(board.store.events.list(card.id).some((e) => e.type === "evaluation")).toBe(true);
    await runtime.dispose();
  });

  it("holds jobs until a daemon handle exists, then runs them", async () => {
    const board = setupBoard();
    const clock = new ManualClock();
    const fake = fakePaseo(() => assessmentJson());
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
    const card = board.draft("Waits for the daemon");
    await runtime.triggers.consumer.poll();
    clock.advance(30_000);
    await runtime.queue.idle();
    expect(runtime.queue.snapshot().blocked).toHaveLength(1);
    expect(board.store.events.list(card.id).some((e) => e.type === "evaluation")).toBe(false);

    handle = fake.paseo;
    runtime.onPaseoAvailable();
    await runtime.queue.idle();
    expect(board.store.events.list(card.id).some((e) => e.type === "evaluation")).toBe(true);
    await runtime.dispose();
  });

  it("consolidates memory when a card is done and advises on a worker question", async () => {
    const board = setupBoard();
    const { runtime, fake } = runtimeFor(board, (prompt) =>
      prompt.includes("[wake:card_done]")
        ? JSON.stringify({ summary: "Recorded the dark mode decision.", lessons: [{ tag: "ui", body: "Use theme tokens." }] })
        : JSON.stringify({ summary: "Worker needs a theme name", suggestedAnswer: "Use 'midnight'", confidence: "medium", needsOwner: true }),
    );
    const card = board.store.cards.create({ projectId: board.project.id, title: "Ship it" }, "user");
    board.store.cards.move(card.id, { to: "todo", actor: "user" });
    const dispatched = board.store.cards.dispatch({ cardId: card.id, agentId: "worker-1", provider: "claude", worktree: null });
    board.store.sessions.setState(dispatched.session.id, "waiting", { question: { requestId: "r1", title: "Which theme name?" } });
    await runtime.triggers.consumer.poll();
    await runtime.queue.idle();
    expect(board.store.events.list(card.id).some((e) => (e.body as { kind?: string })?.kind === "help_advice")).toBe(true);

    board.store.sessions.setState(dispatched.session.id, "idle");
    board.store.cards.move(card.id, { to: "verifying", actor: "lifecycle" });
    board.store.cards.move(card.id, { to: "done", actor: "user" });
    await runtime.triggers.consumer.poll();
    await runtime.queue.idle();
    const note = board.store.events.list(card.id).find((e) => (e.body as { kind?: string })?.kind === "memory_update");
    expect(note).toBeTruthy();
    expect(fake.agents).toHaveLength(1); // one master agent for everything
    // a master session is never mistaken for a worker
    expect(board.store.sessions.list({ role: "master" })).toHaveLength(1);
    await runtime.dispose();
  });

  it("sweeps drafts without a current assessment on start (newest first, capped)", async () => {
    const board = setupBoard();
    const { runtime, fake } = runtimeFor(board, () => assessmentJson());
    for (let i = 0; i < 12; i++) board.draft(`Old draft ${i}`);
    expect(runtime.sweep()).toBe(10);
    await runtime.queue.idle();
    expect(fake.agents[0]!.prompts).toHaveLength(10);
    // everything assessed is not queued again
    expect(runtime.sweep()).toBe(2);
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
