import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createChatService } from "../server/chat";
import { lastAssistantText, questionSummary } from "../server/chat/format";
import { createChatRouter, routeOf } from "../server/chat/router";
import { createDispatcher } from "../server/dispatch";
import { buildDispatchBrief } from "../server/dispatch/brief";
import { registerLifecycle } from "../server/lifecycle";
import { registerBoardRpcs } from "../server/rpc";
import { createSyncService } from "../server/sync";
import { createServerPolicy } from "../server/sync/policy";
import { newId } from "../server/vibe/contract";
import { ClientSync, MemoryChangeStore } from "../server/vibe/sync";
import * as rpc from "../shared/rpc";
import { setupBoard, tempDir } from "./helpers";

type Handler = (event: any, context: any) => unknown;

function setup() {
  const ctx = setupBoard();
  const { board, runtime } = ctx;
  const { project } = board.projects.create({ name: "Demo", prefix: "DEMO", repoPath: "d:/repo/demo/", projectType: "web" });
  const { preset } = board.presets.create({ name: "codex-high", provider: "codex", model: "gpt-5", environmentKind: "new-worktree" });
  const { card } = board.cards.create({ project: project.prefix, title: "Card", description: "d", column: "todo", presetId: preset.id });
  const chats = (type = "chat") => board.store.events.list(card.id).filter((e) => e.type === type);
  return { ...ctx, project, preset, card, store: board.store, runtime, chats };
}

/** The card with a live worker agent (so user messages go to the executor). */
function withWorker(t: ReturnType<typeof setup>, column: "in_progress" | "verifying" = "in_progress") {
  t.store.cards.dispatch({ cardId: t.card.id, agentId: "a1", workspaceId: "ws1", provider: "codex", worktree: null });
  if (column === "verifying") t.store.cards.move(t.card.id, { to: "verifying", actor: "lifecycle" });
}

const user = (t: ReturnType<typeof setup>, text: string, thread: "plan" | "exec" | null = "exec") =>
  t.store.cards.addChat({ cardId: t.card.id, authorKind: "user", author: "user", text, ...(thread ? { thread } : {}) });

describe("chat service and proposal RPCs", () => {
  it("stores the owner's message and applies / rejects proposals through the command layer", () => {
    const t = setup();
    const chat = createChatService(t.board, t.runtime.db);
    const sent = chat.send(t.card.key, "hello", "phone");
    expect(sent.event).toMatchObject({ type: "chat", authorKind: "user", author: "phone", body: { text: "hello" } });
    expect(chat.send(t.card.key, "to the executor", "user", "exec").event.body).toMatchObject({ thread: "exec" });

    const p1 = t.store.cards.propose({ cardId: t.card.id, changes: { title: "New title", acceptance: "A" }, rationale: "clearer" });
    const accepted = chat.accept(p1.id, "user");
    expect(accepted.event.body).toMatchObject({ status: "accepted", resolvedBy: "user" });
    expect(accepted.card).toMatchObject({ title: "New title", acceptance: "A", description: "d" });
    expect(() => chat.accept(p1.id)).toThrow(/\[conflict\]/);

    const p2 = t.store.cards.propose({ cardId: t.card.id, changes: { description: "D2" }, rationale: "r" });
    expect(chat.reject(p2.id, "phone").event.body).toMatchObject({ status: "rejected", resolvedBy: "phone" });
    expect(t.store.cards.get(t.card.id)!.description).toBe("d");
    expect(() => chat.accept("no-such-event")).toThrow(/\[not_found\]/);
    expect(() => chat.reject(sent.event.id)).toThrow(/\[not_found\]/);
  });

  it("is served by the registered RPC handlers and satisfies their schemas", async () => {
    const t = setup();
    const handlers = new Map<string, (input: unknown, ctx: unknown) => unknown>();
    registerBoardRpcs({ handle: (def: { name: string }, fn: never) => handlers.set(def.name, fn) } as never, t.board, {
      chat: createChatService(t.board, t.runtime.db),
    });
    const call = async (def: { name: string; input: any; output: any }, input: unknown) =>
      def.output.parse(await handlers.get(def.name)!(def.input.parse(input), {}));
    const sent = await call(rpc.chatSendRpc, { card: t.card.key, text: "hi" });
    expect(sent.event.type).toBe("chat");
    const proposal = t.store.cards.propose({ cardId: t.card.id, changes: { title: "T2" }, rationale: "r" });
    const accepted = await call(rpc.proposalsAcceptRpc, { eventId: proposal.id });
    expect(accepted.card.title).toBe("T2");
    const second = t.store.cards.propose({ cardId: t.card.id, changes: { title: "T3" }, rationale: "r" });
    expect((await call(rpc.proposalsRejectRpc, { eventId: second.id, actor: "phone" })).event.body).toMatchObject({ status: "rejected" });
  });
});

describe("chat router: who gets a user message (exec thread only)", () => {
  it("routes by column and worker presence", () => {
    const live = { id: "s" } as never;
    const ended = { id: "e" } as never;
    expect(routeOf("in_progress", live, live)).toBe("executor");
    expect(routeOf("verifying", live, live)).toBe("executor");
    expect(routeOf("todo", undefined, ended)).toBe("resume");
    expect(routeOf("verifying", undefined, ended)).toBe("resume");
    expect(routeOf("todo", undefined, undefined)).toBe("none");
    expect(routeOf("draft", undefined, undefined)).toBe("none");
    expect(routeOf("done", live, live)).toBe("none");
  });

  function routerFor(
    t: ReturnType<typeof setup>,
    over: { send?: (text: string) => Promise<unknown>; paseo?: boolean; replies?: any } = {},
  ) {
    const send = vi.fn(over.send ?? (async () => undefined));
    const resume = vi.fn(async () => undefined);
    const replies = over.replies ?? { send: vi.fn(async () => ({ sent: true, duplicate: false })) };
    const router = createChatRouter({
      db: t.runtime.db,
      board: t.board,
      getPaseo: () => (over.paseo === false ? null : ({ agents: { ref: () => ({ send, resume }) } } as never)),
      replies,
      log: () => {},
    });
    router.start(); // pins the cursor at the current end
    return { router, send, resume, replies, stop: () => router.stop() };
  }
  const systemNotes = (t: ReturnType<typeof setup>) => t.chats().filter((e) => e.authorKind === "system");

  it("forwards to the live executor once and marks the message as answered", async () => {
    const t = setup();
    withWorker(t);
    const r = routerFor(t);
    const m = user(t, "please use sqlite");
    await r.router.poll();
    await r.router.poll();
    expect(r.send).toHaveBeenCalledTimes(1);
    expect(r.send).toHaveBeenCalledWith("please use sqlite");
    expect(r.resume).not.toHaveBeenCalled();
    expect(systemNotes(t)[0]!.body).toMatchObject({ answers: [m.id], key: `forward:${m.id}`, agentId: "a1", thread: "exec" });
    await r.stop();
  });

  it("also forwards while the card waits for verification", async () => {
    const t = setup();
    withWorker(t, "verifying");
    const r = routerFor(t);
    user(t, "one more thing");
    await r.router.poll();
    expect(r.send).toHaveBeenCalledTimes(1);
    await r.stop();
  });

  it("answers a waiting question through the reply service", async () => {
    const t = setup();
    withWorker(t);
    const session = t.store.sessions.getByAgent("a1")!;
    t.store.sessions.setState(session.id, "waiting", { question: { requestId: "q1", kind: "question" } });
    const r = routerFor(t);
    const m = user(t, "use postgres");
    await r.router.poll();
    expect(r.replies.send).toHaveBeenCalledWith({ id: m.id, cardId: t.card.id, questionId: "q1", text: "use postgres" });
    expect(r.send).not.toHaveBeenCalled();
    expect(systemNotes(t)[0]!.body).toMatchObject({ answers: [m.id], thread: "exec" });
    await r.stop();
  });

  it("ignores plan-thread messages, including legacy rows without a thread", async () => {
    const t = setup();
    withWorker(t);
    const r = routerFor(t);
    user(t, "plan talk", "plan");
    user(t, "legacy owner message", null);
    await r.router.poll();
    expect(r.send).not.toHaveBeenCalled();
    expect(r.resume).not.toHaveBeenCalled();
    expect(systemNotes(t)).toHaveLength(0);
    await r.stop();
  });

  it("resumes the finished executor agent and then sends the message", async () => {
    const t = setup();
    withWorker(t);
    t.store.sessions.setState(t.store.sessions.getByAgent("a1")!.id, "ended", { outcome: "closed" });
    const r = routerFor(t);
    const m = user(t, "one more round please");
    await r.router.poll();
    expect(r.resume).toHaveBeenCalledTimes(1);
    expect(r.send).toHaveBeenCalledWith("one more round please");
    expect(r.resume.mock.invocationCallOrder[0]).toBeLessThan(r.send.mock.invocationCallOrder[0]!);
    expect(systemNotes(t)[0]!.body).toMatchObject({ text: "已唤回主代理并转给它。", answers: [m.id], thread: "exec" });
    await r.stop();
  });

  it("tells the owner when there is no executor yet", async () => {
    const t = setup(); // todo, never dispatched
    const r = routerFor(t);
    const m = user(t, "start by reading the docs");
    await r.router.poll();
    expect(r.send).not.toHaveBeenCalled();
    expect(r.resume).not.toHaveBeenCalled();
    const mark = systemNotes(t)[0]!;
    expect((mark.body as { text: string }).text).toContain("还没有执行 agent：点「立即执行」");
    expect(mark.body).toMatchObject({ answers: [m.id], thread: "exec" });
    await r.stop();
  });

  it("records a message on a done card without sending it", async () => {
    const t = setup();
    withWorker(t, "verifying");
    t.store.cards.move(t.card.id, { to: "done", actor: "user" });
    const r = routerFor(t);
    user(t, "thanks");
    await r.router.poll();
    expect(r.send).not.toHaveBeenCalled();
    expect((systemNotes(t)[0]!.body as { text: string }).text).toBe("卡片已完成，这条消息只作记录。");
    await r.stop();
  });

  it("reports a send failure in the exec thread and never involves the master", async () => {
    const t = setup();
    withWorker(t);
    const r = routerFor(t, { send: async () => Promise.reject(new Error("agent is gone")) });
    const m = user(t, "hello?");
    await r.router.poll();
    const body = systemNotes(t)[0]!.body as { text: string; answers?: string[]; fallback?: unknown; thread?: string };
    expect(body.text).toContain("agent is gone");
    expect(body.thread).toBe("exec");
    expect(body.answers).toEqual([m.id]);
    expect(body.fallback).toBeUndefined();
    await r.stop();
  });

  it("waits for the daemon handle and keeps its cursor across restarts", async () => {
    const t = setup();
    withWorker(t);
    const first = routerFor(t, { paseo: false });
    user(t, "early message");
    await first.router.poll();
    expect(systemNotes(t)).toHaveLength(0);
    await first.stop();
    const second = routerFor(t); // a new process: same cursor, handle available now
    await second.router.poll();
    expect(second.send).toHaveBeenCalledWith("early message");
    await second.stop();
  });
});

describe("lifecycle write-backs", () => {
  function lifecycleFor(t: ReturnType<typeof setup>) {
    const handlers = new Map<string, Handler[]>();
    const server = {
      on: (name: string, h: Handler) => (handlers.set(name, [...(handlers.get(name) ?? []), h]), () => {}),
      before: () => () => {},
    } as any;
    registerLifecycle(server, { board: t.board, log: () => {}, systemTurnDir: tempDir("turns-") });
    const paseo = { agents: { ref: () => ({ respondToPermission: async () => {}, timeline: { refetch: async () => ({ entries: [] }) } }) } };
    const emit = (name: string, event: unknown) =>
      Promise.all((handlers.get(name) ?? []).map((h) => h(event, { paseo, signal: new AbortController().signal })));
    const agent = { id: "a1", workspaceId: null, parentAgentId: null, provider: "codex", cwd: "x", title: null };
    return { emit, agent };
  }

  it("writes the executor's question once per request and its round summary once per turn", async () => {
    const t = setup();
    withWorker(t);
    const l = lifecycleFor(t);
    const ask = () =>
      l.emit("agent.permission_requested", {
        agent: l.agent,
        request: { id: "r1", kind: "question", name: "ask", input: { questions: [{ question: "Which database?", options: ["sqlite", "pg"] }] } },
      });
    await ask();
    await ask();
    const question = t.chats().filter((e) => e.authorKind === "executor");
    expect(question).toHaveLength(1);
    expect(question[0]!.body).toMatchObject({ kind: "question", agentId: "a1", thread: "exec" });
    expect((question[0]!.body as { text: string }).text).toContain("Which database?");

    await l.emit("agent.permission_resolved", { agent: l.agent, requestId: "r1" });
    const timeline = [
      { type: "assistant_message", text: "working" },
      { type: "assistant_message", text: "All done: added the table." },
    ];
    const end = () => l.emit("agent.turn_ended", { agent: l.agent, turnId: "t1", outcome: { kind: "completed" }, timeline });
    await end();
    await end();
    const summaries = t.chats().filter((e) => (e.body as { kind?: string }).kind === "summary");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ authorKind: "executor", body: { text: "All done: added the table.", thread: "exec", key: expect.stringContaining("summary:") } });
    expect(t.store.cards.get(t.card.id)!.column).toBe("verifying");
  });

  it("formats questions and picks the last assistant message", () => {
    expect(questionSummary({ kind: "tool", name: "Bash", title: "run npm test" })).toContain("run npm test");
    expect(lastAssistantText([{ type: "assistant_message", text: "a" }, { type: "tool_call" }])).toBe("a");
    expect(lastAssistantText([{ type: "tool_call" }])).toBeNull();
    expect(lastAssistantText([{ type: "assistant_message", text: "x".repeat(3000) }])!.length).toBeLessThan(1600);
  });
});

describe("dispatch writes back to the chat and the brief follows the card", () => {
  it("posts who got the card plus the full prompt, once per session", async () => {
    const t = setup();
    const prompts: string[] = [];
    const paseo = {
      projects: { list: async () => ({ projects: [{ projectId: "pp1", projectRootPath: "D:\\Repo\\Demo", projectDisplayName: "demo", projectKind: "git" }] }) },
      workspaces: {
        create: async () => ({
          id: "ws1",
          directory: "D:\\wt\\demo-1",
          agents: { create: async (a: any) => (prompts.push(a.prompt), { id: a.agentId }) },
        }),
      },
    } as never;
    t.store.cards.addChat({ cardId: t.card.id, authorKind: "user", text: "remember the offline case", thread: "exec" });
    const proposal = t.store.cards.propose({ cardId: t.card.id, changes: { title: "Accepted title", acceptance: "must work offline" }, rationale: "be precise" });
    t.store.cards.acceptProposal(proposal.id, "user");
    const dispatcher = createDispatcher({ board: t.board, getPaseo: () => paseo, newAgentId: () => "agent-1" });
    const result = await dispatcher.dispatch(t.card.key);
    const info = t.chats().find((e) => e.authorKind === "system")!;
    expect(info.body).toMatchObject({ kind: "info", agentId: "agent-1", sessionId: result.session.id, key: `dispatch:${result.session.id}`, thread: "exec" });
    expect((info.body as { text: string }).text).toContain("codex-high");
    // the prompt shown in the chat is the prompt the agent received, built from the card as it is now
    expect((info.body as { detail: string }).detail).toBe(prompts[0]);
    expect(prompts[0]).toContain("# DEMO-1 · Accepted title");
    expect(prompts[0]).toContain("must work offline");
    expect(prompts[0]).toContain("be precise");
    expect(prompts[0]).toContain("remember the offline case");
    expect(prompts[0]).not.toContain("# DEMO-1 · Card\n");
    // writing the same dispatch again is a no-op
    t.store.cards.addChat({ cardId: t.card.id, authorKind: "system", text: "dup", key: `dispatch:${result.session.id}` });
    expect(t.chats().filter((e) => e.authorKind === "system")).toHaveLength(1);
  });

  it("buildDispatchBrief takes title, description and acceptance from the card, not from older events", () => {
    const t = setup();
    const stale = t.store.cards.get(t.card.id)!;
    t.store.events.add({ cardId: t.card.id, type: "evaluation", authorKind: "agent", author: "master", body: { text: "old description said X" } });
    const edited = t.store.cards.update(t.card.id, { title: "Edited", description: "Edited body", acceptance: "Edited check" });
    const brief = buildDispatchBrief({ card: edited, project: t.project, preset: t.preset, events: t.store.events.list(t.card.id) });
    expect(brief).toContain("# DEMO-1 · Edited");
    expect(brief).toContain("Edited body");
    expect(brief).toContain("Edited check");
    expect(brief).toContain("以它们为准");
    expect(brief).not.toContain(`# DEMO-1 · ${stale.title}\n`);
  });
});

describe("phone sync refuses forged proposals and chat", () => {
  it("admits new user notes and plain chat; proposals and existing events are immutable", async () => {
    const t = setup();
    const policy = createServerPolicy(t.runtime.db);
    const proposal = t.store.cards.propose({ cardId: t.card.id, changes: { title: "T" }, rationale: "r" });
    const change = (rowId: string, column: string, value: unknown) =>
      ({ kind: "set", table: "card_event", rowId, column, value, hlc: "x", deviceId: "phone" }) as never;
    const ok = (c: never) => policy(c, new MemoryChangeStore() as never).ok;
    // forged proposal / other author kinds / other event types
    expect(ok(change("new-1", "type", "proposal"))).toBe(false);
    expect(ok(change("new-3", "author_kind", "master"))).toBe(false);
    expect(ok(change("new-5", "type", "evaluation"))).toBe(false);
    // direct rewrite of an existing proposal's status or any other existing event
    expect(ok(change(proposal.id, "body_json", JSON.stringify({ status: "accepted" })))).toBe(false);
    const chat = user(t, "hi");
    expect(ok(change(chat.id, "body_json", "{}"))).toBe(false);
    // a plain note and a plain user chat message are fine
    expect(ok(change("new-4", "type", "note"))).toBe(true);
    expect(ok(change("new-2", "type", "chat"))).toBe(true);
  });

  it("allows only text and kind in a phone chat body", async () => {
    const t = setup();
    const sync = createSyncService({ db: t.runtime.db, store: t.store, log: () => {} });
    const client = new ClientSync({ deviceId: "phone-1", store: new MemoryChangeStore() });
    const base = { card_id: t.card.id, author_kind: "user", author: "phone", created_at: new Date().toISOString() };
    const send = async (body: unknown) => {
      const id = newId();
      client.write("card_event", id, { ...base, type: "chat", body_json: JSON.stringify(body) });
      const out = await client.sync(async (req) => sync.exchange(JSON.parse(JSON.stringify(req))));
      return { id, rejected: out.rejected.length };
    };
    const good = await send({ text: "offline hello", kind: "question" });
    expect(good.rejected).toBe(0);
    expect(t.chats().find((e) => e.id === good.id)).toMatchObject({
      type: "chat",
      authorKind: "user",
      body: { text: "offline hello", kind: "question" },
    });
    const withThread = await send({ text: "exec talk", thread: "exec" });
    expect(withThread.rejected).toBe(0);
    expect(t.chats().find((e) => e.id === withThread.id)?.body).toMatchObject({ thread: "exec" });
    for (const forged of [{ text: "x", answers: ["e1"] }, { text: "x", fallback: ["e1"] }, { text: "x", key: "k" }, { text: "x", thread: "master" }, { kind: "info" }, { text: 3 }]) {
      const bad = await send(forged);
      expect(bad.rejected).toBeGreaterThan(0);
      expect(t.chats().some((e) => e.id === bad.id)).toBe(false);
    }
  });

  it("forwards a chat message written offline on the phone exactly once after it syncs", async () => {
    const t = setup();
    withWorker(t);
    const sync = createSyncService({ db: t.runtime.db, store: t.store, log: () => {} });
    const send = vi.fn(async () => undefined);
    const router = createChatRouter({
      db: t.runtime.db,
      board: t.board,
      getPaseo: () => ({ agents: { ref: () => ({ send }) } }) as never,
      replies: { send: vi.fn(async () => ({ sent: true, duplicate: false })) },
      log: () => {},
    });
    router.start();
    const client = new ClientSync({ deviceId: "phone-1", store: new MemoryChangeStore() });
    const transport = async (req: Parameters<typeof sync.exchange>[0]) => sync.exchange(JSON.parse(JSON.stringify(req)));
    await client.sync(transport);
    const id = newId();
    client.write("card_event", id, {
      card_id: t.card.id,
      type: "chat",
      author_kind: "user",
      author: "phone",
      created_at: new Date().toISOString(),
      body_json: JSON.stringify({ text: "use sqlite", thread: "exec" }),
    });
    expect(await router.poll()).toBe(0); // nothing reached the computer yet
    await client.sync(transport);
    await router.poll();
    await client.sync(transport); // the re-sync must not replay the message
    await router.poll();
    await router.poll();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("use sqlite");
    expect(t.chats().find((e) => e.authorKind === "system")?.body).toMatchObject({ answers: [id] });
    await router.stop();
  });
});
