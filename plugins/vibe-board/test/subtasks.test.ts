// WP-106: the main agent starts sub-agents through the board; their outcomes reach it as messages.

import { describe, expect, it, vi } from "vitest";
import { createChatRouter } from "../server/chat/router";
import { buildDispatchBrief } from "../server/dispatch/brief";
import { createReassigner } from "../server/dispatch/reassign";
import { createFlowService } from "../server/flow";
import { registerLifecycle } from "../server/lifecycle";
import { callMcpTool } from "../server/mcp/tools";
import { createSubtaskService } from "../server/subtasks";
import type { Subtask } from "../server/vibe/contract";
import { setupBoard, tempDir } from "./helpers";

type Handler = (event: any, context: any) => unknown;

const st = (id: string, over: Partial<Subtask> = {}): Subtask => ({
  id,
  title: `任务${id}`,
  goal: `目标${id}`,
  method: `方法${id}`,
  notes: `注意${id}`,
  acceptance: `验收${id}`,
  files: [],
  dependsOn: [],
  presetId: null,
  ...over,
});

function fakePaseo(opts: { failProviders?: string[] } = {}) {
  const created: any[] = [];
  const sent: Array<{ agentId: string; text: string; options?: unknown }> = [];
  const resumed: string[] = [];
  const responded: unknown[] = [];
  const paseo = {
    workspaces: {
      ref: (workspaceId: string) => ({
        refresh: async () => ({}),
        agents: {
          create: async (a: any) => {
            const provider = String(a.config.provider).split("/")[0];
            if (opts.failProviders?.includes(provider)) throw new Error(`${provider} login expired: please run /login`);
            created.push({ ...a, workspaceId });
            return { id: a.agentId };
          },
        },
      }),
    },
    agents: {
      ref: (agentId: string) => ({
        send: async (text: string, options?: unknown) => void sent.push({ agentId, text, options }),
        resume: async () => void resumed.push(agentId),
        refresh: async () => ({}),
        current: () => null,
        respondToPermission: async (r: unknown) => void responded.push(r),
        archive: async () => ({ archivedAt: "x" }),
        timeline: { refetch: async () => ({ entries: [], hasOlder: false }) },
      }),
    },
    providers: { listAvailable: async () => ({ providers: [] }) },
  } as any;
  return { paseo, created, sent, resumed, responded };
}

function setup(opts: { failProviders?: string[]; subtasks?: Subtask[] } = {}) {
  const t = setupBoard();
  const { board, runtime } = t;
  const { store } = runtime;
  const { project } = board.projects.create({ name: "Demo", prefix: "DEMO", repoPath: "d:/repo/demo", projectType: "web" });
  const mk = (name: string, provider: string, extra: Record<string, unknown> = {}) =>
    board.presets.create({ name, provider, model: "m", ...extra }).preset;
  const cheapFb = mk("cheap-fb", "codex");
  const main = mk("main", "claude");
  const cheap = mk("cheap", "claude", { fallbackPresetIds: [cheapFb.id] });
  const special = mk("special", "gemini");
  const { card } = board.cards.create({ project: project.prefix, title: "Big job", column: "todo", presetId: main.id });
  store.cards.update(card.id, { subagentPresetId: cheap.id });
  store.cards.setPlan(card.id, {
    plan: {
      description: "整体方案",
      checks: [],
      subCards: [],
      tags: [],
      recommendedPresetId: null,
      subtasks: opts.subtasks ?? [
        st("s1", { files: ["src/a/**"] }),
        st("s2", { files: ["src/a/x.ts"] }),
        st("s3", { dependsOn: ["s1"], presetId: special.id, files: ["src/c.ts"] }),
      ],
    },
  });
  const worktree = tempDir("wt-");
  const { session: mainSession } = store.cards.dispatch({
    cardId: card.id,
    agentId: "main-agent",
    workspaceId: "ws1",
    provider: "claude",
    worktree,
    presetId: main.id,
  });
  store.sessions.setState(mainSession.id, "working");
  const fake = fakePaseo(opts);
  let n = 0;
  const tracker = { expect: vi.fn(), bind: vi.fn(async () => {}), release: vi.fn() };
  const replies = { send: vi.fn(async () => ({ sent: true, duplicate: false })) };
  const service = createSubtaskService({
    board,
    getPaseo: () => fake.paseo,
    tracker,
    replies,
    newAgentId: () => `sub-${++n}`,
    log: () => {},
  });
  const reassigner = createReassigner({ board, getPaseo: () => fake.paseo, tracker, newAgentId: () => `fb-${++n}`, log: () => {} });

  // Lifecycle wired like index.server.ts.
  const handlers = new Map<string, Handler[]>();
  const server = {
    on: (name: string, h: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), h]);
      return () => {};
    },
    before: () => () => {},
  } as any;
  registerLifecycle(server, {
    board,
    log: () => {},
    systemTurnDir: tempDir("turns-"),
    subtasks: () => service.hooks,
    onFailure: async (s, failure) => (await reassigner.reassign(s.id, failure)).reassigned !== null,
  });
  const emit = (name: string, event: unknown) =>
    Promise.all((handlers.get(name) ?? []).map((h) => h(event, { paseo: fake.paseo, signal: new AbortController().signal })));
  const agent = (id: string) => ({ id, workspaceId: "ws1", parentAgentId: null, provider: "claude", cwd: worktree, title: null });
  const reply = (text: string) => [{ type: "assistant_message", text }];
  return {
    ...t,
    store,
    card,
    main,
    cheap,
    cheapFb,
    special,
    mainSession,
    fake,
    service,
    replies,
    emit,
    started: (id: string, turnId = "t") => emit("agent.turn_started", { agent: agent(id), turnId }),
    done: (id: string, text: string, turnId = "t") =>
      emit("agent.turn_ended", { agent: agent(id), turnId, outcome: { kind: "completed" }, timeline: reply(text) }),
    failed: (id: string, message: string) =>
      emit("agent.turn_ended", { agent: agent(id), turnId: "f", outcome: { kind: "failed", error: { message } }, timeline: [] }),
    ask: (id: string, requestId: string, question: string) =>
      emit("agent.permission_requested", {
        agent: agent(id),
        request: { id: requestId, kind: "question", name: "AskUserQuestion", input: { questions: [{ question }] } },
      }),
    now: () => store.cards.get(card.id)!,
    run: (id: string) => store.cards.get(card.id)!.subtaskRuns[id],
    execChat: () =>
      store.events
        .list(card.id)
        .filter((e) => e.type === "chat")
        .map((e) => e.body as { text: string; subtask?: string; thread?: string }),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 10));

describe("starting sub-agents", () => {
  it("starts a subtask in the main agent's workspace with its brief, role and default model", async () => {
    const t = setup();
    const r = await t.service.start(t.card.key, "s1", "先看 README");
    expect(r).toMatchObject({ started: true, subtask: "s1", agentId: "sub-1", model: "cheap" });
    const created = t.fake.created[0];
    expect(created.workspaceId).toBe("ws1");
    expect(created.config.provider).toBe("claude/m");
    expect(created.env).toMatchObject({ VIBE_ROLE: "subagent", VIBE_SUBTASK_ID: "s1", VIBE_CARD_KEY: t.card.key });
    for (const part of ["目标s1", "方法s1", "注意s1", "验收s1", "src/a/**", "整体方案", "先看 README"]) {
      expect(created.prompt).toContain(part);
    }
    const session = t.store.sessions.getByAgent("sub-1")!;
    expect(session.role).toBe("subagent");
    expect(t.run("s1")).toMatchObject({ status: "running", sessionId: session.id, presetId: t.cheap.id, attempts: 1, notified: true });
    expect(t.execChat().at(-1)).toMatchObject({ subtask: "s1", thread: "exec" });
    expect(t.execChat().at(-1)!.text).toContain("已启动子代理");
  });

  it("refuses: card not running, dependency unfinished, overlapping files, concurrency full", async () => {
    const t = setup();
    expect(await t.service.start(t.card.key, "s3")).toMatchObject({ started: false, reason: expect.stringContaining("s1 还没有完成") });
    await t.service.start(t.card.key, "s1");
    expect(await t.service.start(t.card.key, "s2")).toMatchObject({ started: false, reason: expect.stringContaining("相同的文件") });
    expect(await t.service.start(t.card.key, "s1")).toMatchObject({ started: false, reason: expect.stringContaining("已在运行") });
    expect(t.fake.created).toHaveLength(1);

    const u = setup({ subtasks: [st("a"), st("b")] });
    u.store.limits.publish({ globalLimit: 2, providerLimits: {} }); // the main agent takes one slot
    expect(await u.service.start(u.card.key, "a")).toMatchObject({ started: true });
    expect(await u.service.start(u.card.key, "b")).toMatchObject({ started: false, reason: expect.stringContaining("全局并发上限 2") });
    u.store.limits.publish({ globalLimit: 9, providerLimits: { claude: 2 } });
    expect(await u.service.start(u.card.key, "b")).toMatchObject({ started: false, reason: expect.stringContaining("claude 已达并发上限 2") });

    const v = setup();
    v.store.cards.move(v.card.id, { to: "verifying", actor: "lifecycle" });
    expect(await v.service.start(v.card.key, "s1")).toMatchObject({ started: false, reason: expect.stringContaining("不在“进行中”") });
  });

  it("uses the subtask's own model, falls back along the preset chain when it cannot start", async () => {
    const t = setup({ failProviders: ["claude"] });
    t.store.cards.setSubtaskRun(t.card.id, "s1", { status: "done", notified: true });
    expect(await t.service.start(t.card.key, "s3")).toMatchObject({ started: true, model: "special" });
    expect(t.fake.created[0].config.provider).toBe("gemini/m");
    // s2's default model (claude) cannot start: its fallback (codex) takes it.
    t.store.cards.setSubtaskRun(t.card.id, "s1", { status: "done" });
    expect(await t.service.start(t.card.key, "s2")).toMatchObject({ started: true, model: "cheap-fb" });
    expect(t.fake.created[1].config.provider).toBe("codex/m");
  });
});

describe("sub-agent outcomes reach the main agent", () => {
  it("done -> exec chat line and one notification; the card finishes only after the main agent's last round", async () => {
    const t = setup();
    await t.service.start(t.card.key, "s1");
    // The main agent ends its round while s1 works: the card stays in progress.
    await t.done("main-agent", "已启动 s1，等待");
    expect(t.now().column).toBe("in_progress");

    await t.started("sub-1");
    await t.done("sub-1", "s1 做完了，测试通过");
    expect(t.run("s1")).toMatchObject({ status: "done", summary: "s1 做完了，测试通过", notified: false });
    expect(t.execChat().some((m) => m.subtask === "s1" && m.text === "s1 做完了，测试通过")).toBe(true);
    expect(t.now().column).toBe("in_progress");

    expect(await t.service.deliver()).toBe(1);
    const note = t.fake.sent.find((s) => s.agentId === "main-agent")!;
    expect(note.text).toContain("[子任务通知]");
    expect(note.text).toContain("s1「任务s1」 已完成");
    expect(note.options).toEqual({ activeTurnBehavior: "steer" });
    expect(t.run("s1")!.notified).toBe(true);
    expect(await t.service.deliver()).toBe(0); // nothing new

    await t.started("main-agent", "t2");
    await t.done("main-agent", "全部完成", "t2");
    expect(t.now().column).toBe("verifying");
  });

  it("a question goes to the main agent, which answers through the board; never while it waits for the owner", async () => {
    const t = setup();
    await t.service.start(t.card.key, "s1");
    await t.started("sub-1");
    await t.ask("sub-1", "q1", "用哪个库？");
    expect(t.run("s1")).toMatchObject({ status: "waiting", notified: false });
    expect(t.run("s1")!.summary).toContain("用哪个库");

    // The main agent itself waits for the owner: no message now (it would clear its question).
    t.store.sessions.setState(t.mainSession.id, "waiting", { question: { requestId: "m1" } });
    expect(await t.service.deliver()).toBe(0);
    t.store.sessions.setState(t.mainSession.id, "working");
    expect(await t.service.deliver()).toBe(1);
    expect(t.fake.sent.at(-1)!.text).toContain("在提问");

    // Answer through the MCP tool (main agent role).
    const res = await callMcpTool("vibe_subtask_message", { key: t.card.key, subtask: "s1", text: "用 zod" }, t.board, { role: "worker" }, { subtasks: t.service });
    expect(res.isError).toBeUndefined();
    expect(t.replies.send).toHaveBeenCalledWith(expect.objectContaining({ questionId: "q1", text: "用 zod", author: "main-agent" }));
    // A sub-agent cannot use the tools.
    const denied = await callMcpTool("vibe_subtask_start", { key: t.card.key, subtask: "s2" }, t.board, { role: "subagent" }, { subtasks: t.service });
    expect(denied.isError).toBe(true);
  });

  it("failure: reassigned along the sub-agent's chain without touching the main model; otherwise reported", async () => {
    const t = setup();
    await t.service.start(t.card.key, "s1");
    const first = t.run("s1")!.sessionId;
    await t.started("sub-1");
    await t.failed("sub-1", "Claude AI usage limit reached");
    await flush();
    const run = t.run("s1")!;
    expect(run.presetId).toBe(t.cheapFb.id);
    expect(run.sessionId).not.toBe(first);
    expect(run.status).toBe("running");
    expect(t.now().presetId).toBe(t.main.id);
    const fb = t.fake.created.at(-1);
    expect(fb.env.VIBE_ROLE).toBe("subagent");
    expect(fb.prompt).toContain("目标s1");
    expect(t.execChat().some((m) => m.text.includes("已改派"))).toBe(true);

    // A plain failure (not a provider problem) is reported to the main agent.
    const replacement = t.store.sessions.get(run.sessionId!)!;
    await t.failed(replacement.agentId, "Tests failed with 3 errors");
    await flush();
    expect(t.run("s1")).toMatchObject({ status: "failed", notified: false });
    expect(t.run("s1")!.error).toContain("Tests failed");
    await t.service.deliver();
    expect(t.fake.sent.at(-1)!.text).toContain("失败");
  });

  it("a sub-agent lost with the daemon (closed while working) is reported as failed", async () => {
    const t = setup();
    await t.service.start(t.card.key, "s1");
    await t.started("sub-1");
    await t.emit("agent.closed", { agent: { id: "sub-1" } });
    expect(t.run("s1")).toMatchObject({ status: "failed", notified: false });
  });

  it("the main agent can mark a subtask itself; the owner can address a sub-agent in the exec chat", async () => {
    const t = setup();
    t.service.mark(t.card.key, "s1", "done", "我自己改好了");
    expect(t.run("s1")).toMatchObject({ status: "done", summary: "我自己改好了", notified: true });
    expect(await t.service.start(t.card.key, "s3")).toMatchObject({ started: true });

    const router = createChatRouter({
      db: t.runtime.db,
      board: t.board,
      getPaseo: () => t.fake.paseo,
      replies: t.replies,
      subtasks: () => t.service,
    });
    router.start();
    t.store.cards.addChat({ cardId: t.card.id, authorKind: "user", text: "s3 请顺便加注释", thread: "exec", subtask: "s3" });
    t.store.cards.addChat({ cardId: t.card.id, authorKind: "user", text: "主代理你好", thread: "exec" });
    await router.poll();
    await router.stop();
    const sub = t.store.sessions.getByAgent("sub-1")!;
    expect(t.fake.sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentId: sub.agentId, text: "[用户] s3 请顺便加注释" }),
        // Without a subtask the main agent gets it, even though a sub-agent started later.
        expect.objectContaining({ agentId: "main-agent", text: "主代理你好" }),
      ]),
    );
  });
});

describe("main agent brief and subtask edits", () => {
  it("the dispatch brief lists the subtasks with their models and the orchestration note", () => {
    const t = setup();
    const card = t.now();
    const brief = buildDispatchBrief({
      card,
      project: t.store.projects.get(card.projectId)!,
      preset: t.main,
      events: [],
      presets: t.store.presets.list(),
    });
    expect(brief).toContain("## 子任务（由你统筹）");
    expect(brief).toContain("vibe_subtask_start");
    expect(brief).toContain("### s3 · 任务s3（模型：special；依赖：s1）");
    expect(brief).toContain("### s1 · 任务s1（模型：cheap（默认）；无依赖）");
  });

  it("changing the model of a running subtask applies to later sub-agents and says so", async () => {
    const t = setup();
    await t.service.start(t.card.key, "s1");
    const flow = createFlowService({ board: t.board, dispatcher: { dispatch: vi.fn() } as never, reassigner: { switchTo: vi.fn() } as never });
    const list = t.now().plan!.subtasks!.map((s) => (s.id === "s1" ? { ...s, presetId: t.special.id } : s));
    const { card } = flow.setSubtasks(t.card.key, list);
    expect(card.plan?.subtasks?.[0]?.presetId).toBe(t.special.id);
    expect(card.plan?.subtasksEdited).toBe(true);
    expect(t.run("s1")!.presetId).toBe(t.cheap.id); // the running one is not touched
    expect(t.execChat().at(-1)!.text).toContain("正在运行的子代理不受影响");
  });
});
