// WP-92: the card discussion is the group chat (chat events), the master suggests card edits as
// proposals, assessments are posted as chat verdicts, and accepting a proposal does not loop.

import { describe, expect, it } from "vitest";
import { contentHash, createAssessor, lastAssessmentMarker, summarizeAssessment, writeVerdictChat } from "../server/assess/assess";
import { effectiveChanges } from "../server/assess/proposal";
import { AssessmentSchema } from "../server/assess/schema";
import { MASTER_RULES } from "../server/master/rules.generated";
import { createPlanning } from "../server/planning/planner";
import { threadState, type RoutingContext } from "../server/planning/thread";
import { createMasterRuntime } from "../server/runtime";
import type { MemoryPort } from "../server/memory/files";
import { createQuotaReader } from "../server/subscription/quota";
import type { MasterAsk } from "../server/types";
import type { CardEvent, CardView } from "../server/vibe/contract";
import {
  ManualClock,
  assessmentJson,
  defaultSettings,
  fakeMaster,
  fakePaseo,
  setupBoard,
  tempDir,
  type Board,
  type Script,
} from "./helpers";

const fence = (value: unknown) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
const memory: MemoryPort = {
  snapshot: () => ({ "PROJECT_STATE.md": [], "DECISIONS.md": [], "LESSONS.md": [], "INDEX.md": [] }),
  apply: () => ({ stateWritten: false, added: 0, superseded: 0, archived: 0, duplicates: 0 }),
};

const chats = (board: Board, cardId: string) => board.store.events.list(cardId).filter((e) => e.type === "chat");
const bodyOf = (e: CardEvent) => e.body as Record<string, unknown>;
const proposals = (board: Board, cardId: string) => board.store.events.list(cardId).filter((e) => e.type === "proposal");

function plannerFor(script: Script) {
  const board = setupBoard();
  const fake = fakePaseo(script);
  const planning = createPlanning({
    db: board.db,
    store: board.store,
    getPaseo: () => fake.paseo,
    master: fakeMaster(fake),
    rules: MASTER_RULES,
    dataDir: tempDir("vibe-master-data-"),
    clock: new ManualClock(),
    memory,
    enabled: () => true,
    log: () => undefined,
  });
  const say = (cardId: string, text: string) =>
    board.store.cards.addChat({ cardId, authorKind: "user", author: "user", text });
  return { ...board, fake, planning, say };
}

/** A card in in_progress with a worker session (state `starting`). */
function inProgress(board: Board, title: string) {
  const card = board.draft(title);
  board.store.cards.move(card.id, { to: "todo", actor: "user" });
  const { session } = board.store.cards.dispatch({ cardId: card.id, agentId: "worker-1", provider: "claude", worktree: null });
  return { card, session };
}

describe("thread routing of owner chat messages", () => {
  const msg = (board: Board, cardId: string) =>
    board.store.cards.addChat({ cardId, authorKind: "user", author: "user", text: "question?" });
  const pendingOf = (board: Board, cardId: string, ctx: RoutingContext) =>
    threadState(board.store.events.list(cardId), ctx).pending.map((m) => m.id);

  it("belongs to the planner in draft and todo, and not at all in done", () => {
    const board = setupBoard();
    const card = board.draft("Routing");
    const m = msg(board, card.id);
    expect(pendingOf(board, card.id, { column: "draft", executorOnline: false })).toEqual([m.id]);
    expect(pendingOf(board, card.id, { column: "todo", executorOnline: false })).toEqual([m.id]);
    expect(pendingOf(board, card.id, { column: "done", executorOnline: false })).toEqual([]);
    expect(pendingOf(board, card.id, { column: "done", executorOnline: true })).toEqual([]);
  });

  it("in_progress / verifying: the planner only takes messages without an online executor, or after a failed forward", () => {
    const board = setupBoard();
    const card = board.draft("Routing 2");
    const m = msg(board, card.id);
    for (const column of ["in_progress", "verifying"] as const) {
      expect(pendingOf(board, card.id, { column, executorOnline: true })).toEqual([]);
      expect(pendingOf(board, card.id, { column, executorOnline: false })).toEqual([m.id]);
    }
    board.store.cards.addChat({
      cardId: card.id,
      authorKind: "system",
      kind: "info",
      text: "could not forward",
      fallback: [m.id],
    });
    expect(pendingOf(board, card.id, { column: "in_progress", executorOnline: true })).toEqual([m.id]);
    expect(pendingOf(board, card.id, { column: "verifying", executorOnline: true })).toEqual([m.id]);
  });

  it("a message counts as handled once any chat lists it in answers (forwarded, answered), without duplicates", () => {
    const board = setupBoard();
    const card = board.draft("Routing 3");
    const a = msg(board, card.id);
    const b = msg(board, card.id);
    board.store.cards.addChat({
      cardId: card.id,
      authorKind: "system",
      kind: "info",
      text: "forwarded",
      answers: [a.id],
      key: `forward:${a.id}`,
    });
    board.store.cards.addChat({ cardId: card.id, authorKind: "system", kind: "info", text: "forwarded", answers: [a.id], key: `forward:${a.id}` });
    expect(pendingOf(board, card.id, { column: "draft", executorOnline: false })).toEqual([b.id]);
    board.store.cards.addChat({ cardId: card.id, authorKind: "master", author: "planner", text: "ok", answers: [b.id] });
    expect(pendingOf(board, card.id, { column: "draft", executorOnline: false })).toEqual([]);
  });
});

describe("planner turn on chat events", () => {
  it("answers a user chat with chat(master, answers) once; a second tick does not repeat it", async () => {
    const t = plannerFor(() => fence({ reply: "Which screens?", ready: false }));
    const card = t.draft("Dark mode");
    const m = t.say(card.id, "let us plan");
    await t.planning.tick();
    await t.planning.tick();
    await t.planning.tick();
    const replies = chats(t, card.id).filter((e) => e.authorKind === "master");
    expect(replies).toHaveLength(1);
    expect(replies[0]!.author).toBe("planner");
    expect(bodyOf(replies[0]!)).toMatchObject({ text: "Which screens?", answers: [m.id], key: `reply:${m.id}`, agentId: "agent-1" });
    expect(t.fake.agents[0]!.prompts).toHaveLength(1);

    // the same write-back again (crash after the reply) returns the first event
    const again = t.store.cards.addChat({ cardId: card.id, authorKind: "master", author: "planner", text: "dup", answers: [m.id], key: `reply:${m.id}` });
    expect(again.id).toBe(replies[0]!.id);
  });

  it("keeps tick cursor-based: only new user chats, routing fallbacks and hand-off requests wake a card", async () => {
    const t = plannerFor(() => fence({ reply: "ok" }));
    const card = t.draft("Cursor");
    t.say(card.id, "one");
    await t.planning.tick();
    const prompts = t.fake.agents[0]!.prompts.length;
    await t.planning.tick(); // live session is polled, nothing is pending
    expect(t.fake.agents[0]!.prompts).toHaveLength(prompts);
    t.say(card.id, "two");
    await t.planning.tick();
    expect(t.fake.agents[0]!.prompts).toHaveLength(prompts + 1);
  });

  it("turns a proposal of the reply into a pending proposal and drops fields equal to the card", async () => {
    let n = 0;
    const t = plannerFor(() => {
      n++;
      if (n === 1) {
        return fence({
          reply: "I suggest a clearer description.",
          proposal: { title: "Dark mode", description: "Add a dark mode toggle", rationale: "The description lacks the goal" },
        });
      }
      if (n === 2) return fence({ reply: "Nothing to change.", proposal: { title: "Dark mode", rationale: "same" } });
      return fence({ reply: "Also acceptance.", proposal: { acceptance: "Toggle works", rationale: "needs checks" } });
    });
    const card = t.draft("Dark mode", { description: "dark" });
    t.say(card.id, "first");
    await t.planning.tick();
    let ps = proposals(t, card.id);
    expect(ps).toHaveLength(1);
    expect(ps[0]!.authorKind).toBe("master");
    expect(bodyOf(ps[0]!)).toMatchObject({
      status: "pending",
      changes: { description: "Add a dark mode toggle" },
      rationale: "The description lacks the goal",
      before: { description: "dark" },
    });
    expect((bodyOf(ps[0]!).changes as Record<string, unknown>).title).toBeUndefined();

    t.say(card.id, "second"); // proposal equal to the card: ignored
    await t.planning.tick();
    expect(proposals(t, card.id)).toHaveLength(1);

    t.say(card.id, "third"); // a new proposal supersedes the pending one
    await t.planning.tick();
    ps = proposals(t, card.id);
    expect(ps.map((p) => bodyOf(p).status)).toEqual(["superseded", "pending"]);
    // the master never edits the card itself
    expect(t.store.cards.get(card.id)).toMatchObject({ title: "Dark mode", description: "dark", acceptance: "" });
  });

  it("writes failures as chat(master, error)", async () => {
    const t = plannerFor(() => ({ status: "error" as const, lastMessage: null, error: "boom" }));
    const card = t.draft("Fails");
    const m = t.say(card.id, "hello");
    await t.planning.tick();
    const reply = chats(t, card.id).at(-1)!;
    expect(bodyOf(reply)).toMatchObject({ error: true, answers: [m.id] });
    await t.planning.tick();
    expect(chats(t, card.id)).toHaveLength(2);
  });

  it("skips messages routed to an online executor, and takes them back on fallback", async () => {
    const t = plannerFor(() => fence({ reply: "I will take it." }));
    const { card } = inProgress(t, "Executing");
    const m = t.say(card.id, "please also handle X");
    await t.planning.tick();
    expect(t.fake.agents).toHaveLength(0);
    expect(chats(t, card.id).filter((e) => e.authorKind === "master")).toHaveLength(0);

    t.store.cards.addChat({ cardId: card.id, authorKind: "system", kind: "info", text: "forward failed", fallback: [m.id] });
    await t.planning.tick();
    expect(t.fake.agents).toHaveLength(1);
    const reply = chats(t, card.id).find((e) => e.authorKind === "master")!;
    expect(bodyOf(reply)).toMatchObject({ answers: [m.id] });
    expect(t.store.cards.get(card.id)!.column).toBe("in_progress");
  });

  it("answers in in_progress without an online executor, and ignores done cards", async () => {
    const t = plannerFor(() => fence({ reply: "answer" }));
    const { card, session } = inProgress(t, "No worker");
    t.store.sessions.setState(session.id, "ended", { outcome: "failed" });
    t.say(card.id, "what is going on?");
    await t.planning.tick();
    expect(chats(t, card.id).filter((e) => e.authorKind === "master")).toHaveLength(1);

    const done = t.draft("Finished");
    t.store.cards.move(done.id, { to: "todo", actor: "user" });
    t.store.cards.dispatch({ cardId: done.id, agentId: "w2", provider: "claude", worktree: null });
    t.store.cards.move(done.id, { to: "verifying", actor: "lifecycle" });
    t.store.cards.move(done.id, { to: "done", actor: "user" });
    const agents = t.fake.agents.length;
    t.say(done.id, "any news?");
    await t.planning.tick();
    expect(t.fake.agents).toHaveLength(agents);
    expect(chats(t, done.id).filter((e) => e.authorKind === "master")).toHaveLength(0);
  });
});

function assessorFor(board: Board, replies: string[]) {
  const master: MasterAsk = { ask: async () => replies.shift() ?? "" };
  const reader = createQuotaReader({
    getPaseo: () => ({ providers: { listModels: async () => ({}), listUsage: async () => ({ providers: [] }) } }),
    tightPct: () => 20,
    clock: new ManualClock(),
  });
  return createAssessor({ db: board.db, store: board.store, master, quota: reader });
}

describe("assessment as a chat verdict", () => {
  it("writes chat(master, verdict) next to the evaluation and proposes only changed fields", async () => {
    const board = setupBoard();
    const card = board.draft("Fix login", { description: "same text" });
    const assessor = assessorFor(board, [
      assessmentJson({
        verdict: "可行，但验收标准缺失。",
        proposal: { description: "same text", acceptance: "Login works on mobile", rationale: "No acceptance criteria" },
      }),
    ]);
    const outcome = await assessor.assess(card.key);
    if (outcome.status !== "assessed") throw new Error("expected an assessment");
    const events = board.store.events.list(card.id);
    expect(events.filter((e) => e.type === "evaluation")).toHaveLength(1);
    const verdict = chats(board, card.id).find((e) => bodyOf(e).kind === "verdict")!;
    expect(verdict.authorKind).toBe("master");
    expect(bodyOf(verdict)).toMatchObject({ text: "可行，但验收标准缺失。", key: `assess:${outcome.eventId}` });
    const ps = proposals(board, card.id);
    expect(ps).toHaveLength(1);
    expect(bodyOf(ps[0]!)).toMatchObject({ status: "pending", changes: { acceptance: "Login works on mobile" } });
    expect((bodyOf(ps[0]!).changes as Record<string, unknown>).description).toBeUndefined();
    // the card itself is untouched
    expect(board.store.cards.get(card.id)).toMatchObject({ description: "same text", acceptance: "" });

    // writing the same evaluation back again changes nothing
    const fresh = board.store.cards.get(card.id)!;
    writeVerdictChat(board.store, fresh, outcome.eventId, outcome.assessment, outcome.applied);
    expect(chats(board, card.id).filter((e) => bodyOf(e).kind === "verdict")).toHaveLength(1);
    expect(proposals(board, card.id)).toHaveLength(1);
  });

  it("falls back to a generated Chinese summary and ignores a malformed proposal", async () => {
    const board = setupBoard();
    const card = board.draft("No verdict");
    const assessor = assessorFor(board, [assessmentJson({ proposal: { title: "x" } })]); // no rationale
    const outcome = await assessor.assess(card.key);
    expect(outcome.status).toBe("assessed");
    const verdict = chats(board, card.id).find((e) => bodyOf(e).kind === "verdict")!;
    expect(bodyOf(verdict).text).toContain("需求清晰");
    expect(proposals(board, card.id)).toHaveLength(0);
  });

  it("summarizeAssessment covers clarity, questions, risks, agent, size and split", () => {
    const a = AssessmentSchema.parse(
      JSON.parse(
        assessmentJson({
          clarity: { status: "needs_clarification", summary: "目标模糊", questions: ["要支持哪些平台？"] },
          split: { suggested: true, reason: "两个独立模块", subCards: [{ title: "后端" }, { title: "前端" }] },
          risks: ["兼容性"],
        }).replace(/^```json\n|\n```$/g, ""),
      ),
    );
    const text = summarizeAssessment(a, { presetName: "Claude Opus" });
    expect(text).toContain("需求还需要澄清：目标模糊");
    expect(text).toContain("需要你回答的问题：\n- 要支持哪些平台？");
    expect(text).toContain("预估规模 M");
    expect(text).toContain("推荐执行 agent：Claude Opus");
    expect(text).toContain("建议拆分：两个独立模块\n- 后端\n- 前端");
    expect(text).toContain("风险：\n- 兼容性");
  });

  it("effectiveChanges drops blank and unchanged fields", () => {
    const card = { title: "T", description: "D\r\n", acceptance: "" };
    expect(effectiveChanges(card, { title: "T", description: "D", rationale: "r" })).toBeNull();
    expect(effectiveChanges(card, { title: " ", acceptance: "A", rationale: "r" })).toEqual({ acceptance: "A" });
    expect(effectiveChanges(card, undefined)).toBeNull();
  });
});

describe("runtime: manual review during a planning session", () => {
  it("says where to ask instead of silently doing nothing (once per minute)", async () => {
    const board = setupBoard();
    const fake = fakePaseo(() => fence({ reply: "planner answer" }));
    const runtime = createMasterRuntime({
      db: board.db,
      store: board.store,
      getPaseo: () => fake.paseo,
      settings: () => defaultSettings(),
      dataDir: tempDir(),
      clock: new ManualClock(),
      pollIntervalMs: 3_600_000,
      log: () => undefined,
    });
    const card = board.draft("Busy planning");
    board.store.cards.addChat({ cardId: card.id, authorKind: "user", author: "user", text: "plan with me" });
    await runtime.planning.tick();
    runtime.wake(card.key, "assess_draft", true);
    await runtime.queue.idle();
    runtime.wake(card.key, "assess_draft", true);
    await runtime.queue.idle();
    const info = chats(board, card.id).filter((e) => bodyOf(e).kind === "info");
    expect(info).toHaveLength(1);
    expect(info[0]!.authorKind).toBe("system");
    expect(bodyOf(info[0]!).text).toContain("规划会话进行中");
    await runtime.dispose();
  });
});

describe("accepting a proposal does not re-trigger the review", () => {
  function runtimeFor(board: Board) {
    const clock = new ManualClock();
    const fake = fakePaseo(() => assessmentJson({ proposal: { description: "A much clearer description", rationale: "clarity" } }));
    const runtime = createMasterRuntime({
      db: board.db,
      store: board.store,
      getPaseo: () => fake.paseo,
      settings: () => defaultSettings({ debounceSeconds: 30 }),
      dataDir: tempDir(),
      clock,
      pollIntervalMs: 3_600_000,
      log: () => undefined,
    });
    return { runtime, clock, fake };
  }

  /** Create a draft, let the master assess it (which proposes a new description) and return the proposal. */
  async function assessedWithProposal(board: Board) {
    const ctx = runtimeFor(board);
    const card = board.draft("Needs words");
    await ctx.runtime.triggers.consumer.poll();
    ctx.clock.advance(30_000);
    await ctx.runtime.queue.idle();
    await ctx.runtime.triggers.consumer.poll(); // the master's own write-back
    expect(ctx.fake.agents[0]!.prompts).toHaveLength(1);
    const proposal = proposals(board, card.id)[0]!;
    expect(bodyOf(proposal).status).toBe("pending");
    return { ...ctx, card, proposal };
  }

  const reviews = (ctx: { fake: ReturnType<typeof fakePaseo> }) => ctx.fake.agents[0]!.prompts.length;

  it("accepting does not wake the master, even after the quiet period", async () => {
    const board = setupBoard();
    const ctx = await assessedWithProposal(board);
    board.store.cards.acceptProposal(ctx.proposal.id, "user");
    await ctx.runtime.triggers.consumer.poll();
    expect(ctx.runtime.triggers.debouncer.pending()).toEqual([]);
    ctx.clock.advance(120_000);
    await ctx.runtime.queue.idle();
    expect(reviews(ctx)).toBe(1);
    expect(board.store.cards.get(ctx.card.id)!.description).toBe("A much clearer description");

    // the accepted content is recorded as evaluated, once per proposal
    const applied = board.store.events.list(ctx.card.id).filter((e) => bodyOf(e).kind === "proposal_applied");
    expect(applied).toHaveLength(1);
    expect(bodyOf(applied[0]!)).toMatchObject({ proposalId: ctx.proposal.id });
    await ctx.runtime.triggers.consumer.poll();
    expect(board.store.events.list(ctx.card.id).filter((e) => bodyOf(e).kind === "proposal_applied")).toHaveLength(1);
    await ctx.runtime.dispose();
  });

  it("a normal edit right after still triggers the review", async () => {
    const board = setupBoard();
    const ctx = await assessedWithProposal(board);
    board.store.cards.acceptProposal(ctx.proposal.id, "user");
    await ctx.runtime.triggers.consumer.poll();
    expect(ctx.runtime.triggers.debouncer.pending()).toEqual([]);

    board.store.cards.update(ctx.card.id, { description: "I rewrote it myself" });
    await ctx.runtime.triggers.consumer.poll();
    expect(ctx.runtime.triggers.debouncer.pending()).toHaveLength(1);
    ctx.clock.advance(30_000);
    await ctx.runtime.queue.idle();
    expect(reviews(ctx)).toBe(2);

    // another field, not part of the proposal, also counts
    board.store.cards.update(ctx.card.id, { title: "New title" });
    await ctx.runtime.triggers.consumer.poll();
    expect(ctx.runtime.triggers.debouncer.pending()).toHaveLength(1);
    await ctx.runtime.dispose();
  });

  it("rejecting changes nothing on the card and wakes nobody", async () => {
    const board = setupBoard();
    const ctx = await assessedWithProposal(board);
    const updatedBefore = board.eventTypes().filter((t) => t === "card.updated").length;
    board.store.cards.rejectProposal(ctx.proposal.id, "user");
    await ctx.runtime.triggers.consumer.poll();
    expect(board.eventTypes().filter((t) => t === "card.updated")).toHaveLength(updatedBefore);
    expect(ctx.runtime.triggers.debouncer.pending()).toEqual([]);
    expect(bodyOf(proposals(board, ctx.card.id)[0]!).status).toBe("rejected");
    expect(board.store.cards.get(ctx.card.id)!.description).not.toBe("A much clearer description");
    ctx.clock.advance(120_000);
    await ctx.runtime.queue.idle();
    expect(reviews(ctx)).toBe(1);
    await ctx.runtime.dispose();
  });

  it("the proposal_applied marker makes the sweep treat the accepted content as reviewed", async () => {
    const board = setupBoard();
    const ctx = await assessedWithProposal(board);
    // content before accepting: the sweep is quiet because the assessment matches
    expect(ctx.runtime.triggers.sweep()).toBe(0);
    board.store.cards.acceptProposal(ctx.proposal.id, "user");
    await ctx.runtime.triggers.consumer.poll();
    const card = board.store.cards.get(ctx.card.id) as CardView;
    const marker = lastAssessmentMarker(board.store.events.list(card.id));
    expect(marker).toEqual({ hash: contentHash(card, []), failed: false });
    expect(ctx.runtime.triggers.sweep()).toBe(0);
    await ctx.runtime.dispose();
  });
});
