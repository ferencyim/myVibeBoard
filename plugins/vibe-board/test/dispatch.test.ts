import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDispatcher, type DispatchPaseo } from "../server/dispatch";
import { buildDispatchBrief, modeIdFor, worktreeSlug } from "../server/dispatch/brief";
import { createFlowService } from "../server/flow";
import { registerLifecycle } from "../server/lifecycle";
import { startFinalizer } from "../server/lifecycle/finalize";
import { eventTypes, setupBoard } from "./helpers";

type Handler = (event: any, context: any) => void;

/** Stand-in for the plugin server's hook registry. */
function fakeServer() {
  const events = new Map<string, Handler[]>();
  const before = new Map<string, Handler[]>();
  const add = (map: Map<string, Handler[]>) => (name: string, handler: Handler) => {
    map.set(name, [...(map.get(name) ?? []), handler]);
    return () => void map.set(name, (map.get(name) ?? []).filter((h) => h !== handler));
  };
  return {
    server: { on: add(events), before: add(before) } as any,
    emit: (name: string, event: unknown) =>
      (events.get(name) ?? []).forEach((h) => h(event, { paseo: {}, signal: new AbortController().signal })),
    runBefore: (name: string, request: unknown) =>
      (before.get(name) ?? []).forEach((h) => h({ request }, { paseo: {}, signal: new AbortController().signal })),
  };
}

function fakePaseo(opts: { failWorkspace?: boolean; failAgent?: boolean; kind?: "git" | "directory" } = {}) {
  const calls = { workspace: [] as any[], agent: [] as any[] };
  const paseo = {
    projects: {
      list: async () => ({
        projects: [
          { projectId: "pp1", projectRootPath: "D:\\Repo\\Demo", projectDisplayName: "demo", projectKind: opts.kind ?? "git" },
        ],
      }),
    },
    workspaces: {
      create: async (options: any) => {
        if (opts.failWorkspace) throw new Error("worktree boom");
        calls.workspace.push(options);
        return {
          id: "ws1",
          directory: "D:\\wt\\demo-1",
          agents: {
            create: async (a: any) => {
              if (opts.failAgent) throw new Error("agent boom");
              calls.agent.push(a);
              return { id: a.agentId };
            },
          },
        };
      },
    },
  } as unknown as DispatchPaseo;
  return { paseo, calls };
}

function setup(paseoOpts: Parameters<typeof fakePaseo>[0] = {}) {
  const ctx = setupBoard();
  const { board, runtime } = ctx;
  const { project } = board.projects.create({ name: "Demo", prefix: "DEMO", repoPath: "d:/repo/demo/", projectType: "web" });
  const { preset } = board.presets.create({
    name: "codex-high",
    provider: "codex",
    model: "gpt-5",
    thinking: "high",
    permissionMode: "full",
    environmentKind: "new-worktree",
    baseBranch: "main",
    runtimeEnv: "web-dev-server",
    instructions: "Be careful.",
  });
  const { card } = board.cards.create({ project: project.prefix, title: "Fix the Login Bug!", column: "todo", presetId: preset.id, acceptance: "login works" });
  const fake = fakePaseo(paseoOpts);
  const hooks = fakeServer();
  const lifecycle = registerLifecycle(hooks.server, { board, log: () => {} });
  const dispatcher = createDispatcher({
    board,
    getPaseo: () => fake.paseo,
    tracker: lifecycle,
    newAgentId: () => "agent-1",
  });
  return { ...ctx, project, preset, card, fake, hooks, lifecycle, dispatcher, store: board.store, runtime, board };
}

const agent = (id = "agent-1") => ({ id, workspaceId: "ws1", parentAgentId: null, provider: "codex", cwd: "x", title: null });
const sessionOf = (t: ReturnType<typeof setup>) => t.store.sessions.getByAgent("agent-1")!;
const column = (t: ReturnType<typeof setup>) => t.store.cards.get(t.card.id)!.column;

describe("brief helpers", () => {
  it("slugs, mode mapping and brief content", () => {
    expect(worktreeSlug({ key: "DEMO-3", title: "Fix the Login Bug!" })).toBe("demo-3-fix-the-login-bug");
    expect(worktreeSlug({ key: "DEMO-3", title: "???" })).toBe("demo-3-card");
    expect(modeIdFor("claude", "full")).toBe("bypassPermissions");
    expect(modeIdFor("codex", "full")).toBe("full-access");
    expect(modeIdFor("codex", "accept-edits")).toBeUndefined();
    const t = setup();
    const brief = buildDispatchBrief({ card: t.card, project: t.project, preset: t.preset, events: [] });
    expect(brief).toContain("DEMO-1");
    expect(brief).toContain("login works");
    expect(brief).toContain("web-dev-server");
    expect(brief).toContain("Be careful.");
    expect(brief).toContain(".vibe/PROJECT_STATE.md");
    expect(brief).toContain("对你只读");
  });
});

describe("brief: plan, acceptance and execution conversation (WP-105)", () => {
  it("carries the card plan, acceptance and exec chat, but not the plan conversation", () => {
    const t = setup();
    t.store.cards.setPlan(t.card.id, { plan: {
      description: "PLAN: do A, then B.",
      checks: [{ text: "check-one" }],
      files: ["src/a.ts"], subCards: [], tags: [], recommendedPresetId: null,
    } as any });
    const chat = (authorKind: any, text: string, thread?: string) =>
      t.store.events.add({
        cardId: t.card.id,
        type: "chat",
        authorKind,
        author: authorKind,
        body: { text, ...(thread ? { thread } : {}) },
      });
    chat("user", "PLAN-THREAD-CHATTER", "plan");
    chat("agent", "PLANNER-REPLY", "plan");
    chat("user", "EXEC-USER-MSG", "exec");
    chat("executor", "EXEC-EXECUTOR-MSG", "exec");
    chat("reviewer", "EXEC-REVIEWER-MSG", "exec");
    chat("system", "EXEC-SYSTEM-NOTE", "exec");
    const card = t.store.cards.get(t.card.id)!;
    const brief = buildDispatchBrief({ card, project: t.project, preset: t.preset, events: t.store.events.list(t.card.id) });
    expect(brief).toContain("PLAN: do A, then B.");
    expect(brief).toContain("check-one");
    expect(brief).toContain("login works");
    expect(brief).toContain("EXEC-USER-MSG");
    expect(brief).toContain("EXEC-EXECUTOR-MSG");
    expect(brief).toContain("EXEC-REVIEWER-MSG");
    expect(brief).not.toContain("PLAN-THREAD-CHATTER");
    expect(brief).not.toContain("PLANNER-REPLY");
    expect(brief).not.toContain("EXEC-SYSTEM-NOTE");
    expect(brief).not.toContain("规划交接");
  });

  it("omits the plan section when the card has no plan", () => {
    const t = setup();
    const brief = buildDispatchBrief({ card: t.card, project: t.project, preset: t.preset, events: [] });
    expect(brief).not.toContain("## 方案");
  });
});

describe("dispatch", () => {
  it("completes a preset without a model from the provider catalog and notes it on the card", async () => {
    const t = setup();
    t.store.presets.update(t.preset.id, { model: "" });
    (t.fake.paseo as any).providers = {
      listModels: async () => ({ models: [{ id: "other", isDefault: false }, { id: "gpt-5-codex", isDefault: true }] }),
    };
    await t.dispatcher.dispatch("DEMO-1");
    expect(t.fake.calls.agent[0].config.provider).toBe("codex/gpt-5-codex");
    const note = t.store.events.list(t.card.id).find((e) => (e.body as any)?.kind === "model_default");
    expect(JSON.stringify(note?.body)).toContain("gpt-5-codex");
  });

  it("fails clearly when a model-less preset's provider has no default model", async () => {
    const t = setup();
    t.store.presets.update(t.preset.id, { model: "" });
    (t.fake.paseo as any).providers = { listModels: async () => ({ models: [] }) };
    await expect(t.dispatcher.dispatch("DEMO-1")).rejects.toThrow(/没有填模型/);
    expect(t.fake.calls.agent).toHaveLength(0);
  });

  it("creates a worktree workspace and a worker agent from the preset, then records the session", async () => {
    const t = setup();
    const result = await t.dispatcher.dispatch("DEMO-1");

    const ws = t.fake.calls.workspace[0];
    expect(ws.source).toMatchObject({
      kind: "worktree",
      action: "branch-off",
      baseBranch: "main",
      projectId: "pp1",
      worktreeSlug: "demo-1-fix-the-login-bug",
    });
    const agentCall = t.fake.calls.agent[0];
    expect(agentCall.config).toEqual({ provider: "codex/gpt-5", thinkingOptionId: "high", modeId: "full-access" });
    expect(agentCall.env).toMatchObject({ VIBE_ROLE: "worker", VIBE_CARD_ID: t.card.id, VIBE_CARD_KEY: "DEMO-1", VIBE_RUNTIME_ENV: "web-dev-server" });
    expect(agentCall.labels.cardKey).toBe("DEMO-1");
    expect(agentCall.prompt).toContain("Fix the Login Bug!");

    expect(result.card.column).toBe("in_progress");
    expect(result.card.worktree).toBe("D:\\wt\\demo-1");
    expect(result.session).toMatchObject({ agentId: "agent-1", workspaceId: "ws1", role: "worker", state: "starting", currentProvider: "codex" });
    expect(eventTypes(t.runtime)).toEqual(
      expect.arrayContaining(["card.created", "session.started", "card.moved", "card.dispatched"]),
    );
  });

  it("uses the project directory when the preset asks for the default environment", async () => {
    const t = setup();
    t.board.presets.update(t.preset.id, { environmentKind: "project-default" });
    await t.dispatcher.dispatch("DEMO-1");
    expect(t.fake.calls.workspace[0].source).toMatchObject({ kind: "directory", path: "D:\\Repo\\Demo" });
    expect(t.store.cards.get(t.card.id)!.worktree).toBeNull();
  });

  it("rejects non-todo cards, missing presets and unlinked projects without side effects", async () => {
    const t = setup();
    const draft = t.board.cards.create({ project: "DEMO", title: "d" }).card;
    await expect(t.dispatcher.dispatch(draft.key)).rejects.toThrow(/只有待办卡片可以派发/);

    t.board.cards.update(t.card.id, { presetId: null });
    await expect(t.dispatcher.dispatch("DEMO-1")).rejects.toThrow(/还没有选执行预设/);

    t.board.cards.update(t.card.id, { presetId: t.preset.id });
    t.board.projects.update("DEMO", { repoPath: "/elsewhere" });
    await expect(t.dispatcher.dispatch("DEMO-1")).rejects.toThrow(/仓库路径不存在或不是目录：\/elsewhere/);
    expect(column(t)).toBe("todo");
    expect(t.fake.calls.workspace).toHaveLength(0);
  });

  it("falls back to the project default preset", async () => {
    const t = setup();
    t.board.cards.update(t.card.id, { presetId: null });
    t.board.projects.update("DEMO", { defaultPresetId: t.preset.id });
    await t.dispatcher.dispatch("DEMO-1");
    expect(t.store.cards.get(t.card.id)!.presetId).toBe(t.preset.id);
  });

  it("uses the master agent's recommended preset when the card and the project have none", async () => {
    const t = setup();
    t.board.cards.update(t.card.id, { presetId: null });
    t.store.cards.update(t.card.id, { suggestedPresetId: t.preset.id });
    const result = await t.dispatcher.dispatch("DEMO-1");
    expect(result.session.currentProvider).toBe("codex");
  });

  it("prefers the card's own preset over the recommendation, and the recommendation over the project default", async () => {
    const t = setup();
    const { preset: other } = t.board.presets.create({
      name: "other",
      provider: "claude",
      model: "opus",
      thinking: "",
      permissionMode: "full",
      environmentKind: "new-worktree",
    } as any);
    t.board.cards.update(t.card.id, { presetId: null });
    t.board.projects.update("DEMO", { defaultPresetId: t.preset.id });
    t.store.cards.update(t.card.id, { suggestedPresetId: other.id });
    const result = await t.dispatcher.dispatch("DEMO-1");
    expect(result.session.currentProvider).toBe("claude");
  });

  it.each([["failWorkspace", /worktree boom/], ["failAgent", /agent boom/]] as const)(
    "%s leaves the card in todo with a dispatch_failed event",
    async (flag, message) => {
      const t = setup({ [flag]: true });
      await expect(t.dispatcher.dispatch("DEMO-1")).rejects.toThrow(message);
      expect(column(t)).toBe("todo");
      expect(t.store.sessions.list({ cardId: t.card.id })).toHaveLength(0);
      const failed = t.store.events.list(t.card.id).find((e) => (e.body as any)?.kind === "dispatch_failed");
      expect(failed).toBeTruthy();
      // The card can be dispatched again once the problem is gone.
    },
  );

  it("honours the scheduler gate unless forced and refuses a second concurrent dispatch", async () => {
    const t = setup();
    const gated = createDispatcher({ board: t.board, getPaseo: () => t.fake.paseo, admit: () => false });
    await expect(gated.dispatch("DEMO-1")).rejects.toThrow(/not_admitted/);
    expect(column(t)).toBe("todo");

    const slow = createDispatcher({ board: t.board, getPaseo: () => t.fake.paseo, newAgentId: () => "agent-2" });
    const [a, b] = await Promise.allSettled([slow.dispatch("DEMO-1"), slow.dispatch("DEMO-1")]);
    expect([a.status, b.status].sort()).toEqual(["fulfilled", "rejected"]);
  });
});

describe("lifecycle", () => {
  it("runs the full state flow: working, question, answer, completed -> verifying, continue, error, end", async () => {
    const t = setup();
    await t.dispatcher.dispatch("DEMO-1");

    t.hooks.emit("agent.turn_started", { agent: agent(), turnId: "t1" });
    expect(sessionOf(t).state).toBe("working");

    // agent asks a question: red dot
    t.hooks.emit("agent.permission_requested", {
      agent: agent(),
      request: { id: "q1", kind: "question", name: "ask", title: "Which db?", input: { q: "pg or sqlite" } },
    });
    let s = sessionOf(t);
    expect(s.state).toBe("waiting");
    expect(s.waitingSince).toBeTruthy();
    expect(s.pendingQuestion).toMatchObject({ requestId: "q1", kind: "question", title: "Which db?", input: { q: "pg or sqlite" } });

    // a round ending while a question is open does not go to verifying
    t.hooks.emit("agent.turn_ended", { agent: agent(), turnId: "t1", outcome: { kind: "completed" }, timeline: [] });
    expect(column(t)).toBe("in_progress");
    expect(sessionOf(t).state).toBe("waiting");

    t.hooks.emit("agent.permission_resolved", { agent: agent(), requestId: "q1", resolution: { behavior: "allow" } });
    s = sessionOf(t);
    expect(s.state).toBe("working");
    expect(s.waitingSince).toBeNull();
    expect(s.pendingQuestion).toBeNull();

    // round completes without open question -> verifying
    t.hooks.emit("agent.turn_ended", { agent: agent(), turnId: "t1", outcome: { kind: "completed" }, timeline: [] });
    expect(sessionOf(t).state).toBe("idle");
    expect(column(t)).toBe("verifying");

    // user continues the chat -> back to in_progress
    t.hooks.emit("agent.turn_started", { agent: agent(), turnId: "t2" });
    expect(column(t)).toBe("in_progress");
    expect(sessionOf(t).state).toBe("working");

    // failure -> error, card stays in_progress
    t.hooks.emit("agent.turn_ended", { agent: agent(), turnId: "t2", outcome: { kind: "failed", error: { message: "quota" } }, timeline: [] });
    s = sessionOf(t);
    expect(s.state).toBe("error");
    expect(s.errorMessage).toBe("quota");
    expect(column(t)).toBe("in_progress");

    // recovers on the next turn, then the agent is closed
    t.hooks.emit("agent.turn_started", { agent: agent(), turnId: "t3" });
    expect(sessionOf(t).state).toBe("working");
    expect(sessionOf(t).errorMessage).toBeNull();
    t.hooks.emit("agent.closed", { agent: agent() });
    expect(sessionOf(t).state).toBe("ended");

    expect(eventTypes(t.runtime)).toEqual([
      "card.created",
      "session.started",
      "card.moved", // dispatch
      "card.dispatched",
      "session.waiting",
      "session.answered",
      "card.moved", // -> verifying
      "card.moved", // -> in_progress
      "session.error",
      "session.ended",
    ]);
  });

  it("keeps the bus order stable and writes card events for each stage", async () => {
    const t = setup();
    await t.dispatcher.dispatch("DEMO-1");
    t.hooks.emit("agent.turn_started", { agent: agent(), turnId: "t1" });
    t.hooks.emit("agent.permission_requested", { agent: agent(), request: { id: "p1", kind: "tool", name: "bash" } });
    t.hooks.emit("agent.permission_resolved", { agent: agent(), requestId: "p1", resolution: { behavior: "allow" } });
    t.hooks.emit("agent.turn_ended", { agent: agent(), turnId: "t1", outcome: { kind: "failed", error: { message: "boom" } }, timeline: [] });
    const kinds = t.store.events.list(t.card.id).map((e) => (e.body as any)?.kind);
    expect(kinds).toEqual(expect.arrayContaining(["session_started", "session_waiting", "session_error"]));
    const types = eventTypes(t.runtime);
    expect(types.slice(types.indexOf("card.dispatched"))).toEqual([
      "card.dispatched",
      "session.waiting",
      "session.answered",
      "session.error",
    ]);
  });

  it("waits for every open request before leaving waiting", async () => {
    const t = setup();
    await t.dispatcher.dispatch("DEMO-1");
    t.hooks.emit("agent.permission_requested", { agent: agent(), request: { id: "a", kind: "tool", name: "x" } });
    t.hooks.emit("agent.permission_requested", { agent: agent(), request: { id: "b", kind: "tool", name: "y" } });
    expect(sessionOf(t).pendingQuestion).toMatchObject({ requestId: "b", pending: 2 });
    t.hooks.emit("agent.permission_resolved", { agent: agent(), requestId: "a", resolution: { behavior: "allow" } });
    expect(sessionOf(t).state).toBe("waiting");
    t.hooks.emit("agent.permission_resolved", { agent: agent(), requestId: "b", resolution: { behavior: "deny" } });
    expect(sessionOf(t).state).toBe("working");
  });

  it("does not move the card when a canceled round ends", async () => {
    const t = setup();
    await t.dispatcher.dispatch("DEMO-1");
    t.hooks.emit("agent.turn_started", { agent: agent(), turnId: "t1" });
    t.hooks.emit("agent.turn_ended", { agent: agent(), turnId: "t1", outcome: { kind: "canceled", reason: "user" }, timeline: [] });
    expect(sessionOf(t).state).toBe("idle");
    expect(column(t)).toBe("in_progress");
  });

  it("replays events that arrive before dispatch has bound the session", async () => {
    const t = setup();
    const slowPaseo = {
      ...t.fake.paseo,
      workspaces: {
        create: async () => ({
          id: "ws1",
          directory: "D:\\wt\\demo-1",
          agents: {
            create: async (a: any) => {
              // the daemon announces the agent and starts its first turn before create() returns
              t.hooks.emit("agent.turn_started", { agent: agent(a.agentId), turnId: "t1" });
              return { id: a.agentId };
            },
          },
        }),
      },
    } as unknown as DispatchPaseo;
    const dispatcher = createDispatcher({ board: t.board, getPaseo: () => slowPaseo, tracker: t.lifecycle, newAgentId: () => "agent-1" });
    await dispatcher.dispatch("DEMO-1");
    expect(sessionOf(t).state).toBe("working");
  });

  it("ignores agents the board does not track and swallows handler errors", () => {
    const t = setup();
    const log = vi.fn();
    const hooks = fakeServer();
    registerLifecycle(hooks.server, { board: t.board, log });
    expect(() => hooks.emit("agent.turn_started", { agent: agent("stranger"), turnId: null })).not.toThrow();
    expect(eventTypes(t.runtime)).not.toContain("session.waiting");
  });

  it("records each completed compaction once, even though the timeline repeats", async () => {
    const t = setup();
    await t.dispatcher.dispatch("DEMO-1");
    const timeline = [{ type: "compaction", status: "completed" }, { type: "compaction", status: "loading" }];
    t.hooks.emit("agent.turn_ended", { agent: agent(), turnId: "t1", outcome: { kind: "completed" }, timeline });
    t.hooks.emit("agent.turn_started", { agent: agent(), turnId: "t2" });
    t.hooks.emit("agent.turn_ended", { agent: agent(), turnId: "t2", outcome: { kind: "completed" }, timeline: [...timeline, { type: "compaction", status: "completed" }] });
    const compactions = t.store.events.list(t.card.id).filter((e) => e.type === "compaction");
    expect(compactions).toHaveLength(2);
    expect(eventTypes(t.runtime).filter((x) => x === "session.compacted")).toHaveLength(2);
  });

  it("records an in-session switch from switch-provider's import", async () => {
    const t = setup();
    await t.dispatcher.dispatch("DEMO-1");
    t.hooks.runBefore("agent.session_open", {
      agentId: "agent-2",
      workspaceId: "ws1",
      provider: "claude",
      cwd: "x",
      reason: "import",
      purpose: "interactive",
      env: {},
    });
    const old = t.store.sessions.getByAgent("agent-1")!;
    expect(old.currentProvider).toBe("claude");
    expect(old.switchHistory).toMatchObject([{ from: "codex", to: "claude", reason: "switch-provider" }]);
    expect(old.state).toBe("ended");
    const next = t.store.sessions.getByAgent("agent-2")!;
    expect(next).toMatchObject({ cardId: t.card.id, role: "worker", currentProvider: "claude" });
    expect(t.store.events.list(t.card.id).some((e) => e.type === "switch_agent")).toBe(true);
    expect(eventTypes(t.runtime)).toContain("session.switched");

    // the card keeps following the new agent
    t.hooks.emit("agent.turn_ended", { agent: agent("agent-2"), turnId: "t1", outcome: { kind: "completed" }, timeline: [] });
    expect(column(t)).toBe("verifying");
  });

  it("ignores non-import session opens and same-provider imports", async () => {
    const t = setup();
    await t.dispatcher.dispatch("DEMO-1");
    const open = { agentId: "agent-2", workspaceId: "ws1", cwd: "x", purpose: "interactive", env: {} };
    t.hooks.runBefore("agent.session_open", { ...open, provider: "claude", reason: "resume" });
    t.hooks.runBefore("agent.session_open", { ...open, provider: "codex", reason: "import" });
    expect(t.store.sessions.getByAgent("agent-2")).toBeUndefined();
  });
});

describe("finalizer", () => {
  it("is called once when a card reaches done", async () => {
    const t = setup();
    await t.dispatcher.dispatch("DEMO-1");
    t.hooks.emit("agent.turn_ended", { agent: agent(), turnId: "t1", outcome: { kind: "completed" }, timeline: [] });
    const finalize = vi.fn(async () => ({ summary: "merged" }));
    const custom = startFinalizer({ db: t.runtime.db, board: t.board, finalize });
    await custom.stop();

    t.board.cards.move("DEMO-1", { to: "done", actor: "user" });
    await custom.poll();
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(finalize.mock.calls[0][0].worktree).toBe("D:\\wt\\demo-1");
    const kinds = t.store.events.list(t.card.id).map((e) => (e.body as any)?.kind);
    expect(kinds).toContain("finalized");
  });
});

describe("agent.closed", () => {
  it("keeps a master or planner session open (it is resumed after a daemon restart) but ends a worker", () => {
    const t = setup();
    const master = t.store.sessions.start({ cardId: null, agentId: "m1", role: "master", provider: "claude" });
    const planner = t.store.sessions.start({ cardId: t.card.id, agentId: "p1", role: "planner", provider: "claude" });
    const worker = t.store.sessions.start({ cardId: t.card.id, agentId: "w1", role: "worker", provider: "codex" });
    for (const id of ["m1", "p1", "w1"]) t.hooks.emit("agent.closed", { agent: agent(id) });
    expect(t.store.sessions.get(master.id)!.state).not.toBe("ended");
    expect(t.store.sessions.get(planner.id)!.state).not.toBe("ended");
    expect(t.store.sessions.get(worker.id)!.state).toBe("ended");
  });
});

describe("flow service (WP-105)", () => {
  function flowSetup() {
    const t = setup();
    const switchTo = vi.fn(async (_sessionId: string, presetId: string) => {
      t.store.cards.update(t.card.id, { presetId });
      return {} as never;
    });
    const flow = createFlowService({ board: t.board, dispatcher: t.dispatcher, reassigner: { switchTo } as never });
    const chats = (id = t.card.id) => t.store.events.list(id).filter((e) => e.type === "chat");
    return { ...t, flow, switchTo, chats };
  }

  it("planStart needs a planning model and writes a plan-thread make_plan message", () => {
    const t = flowSetup();
    expect(() => t.flow.planStart(t.card.key)).toThrow(/规划模型/);
    expect(t.chats()).toHaveLength(0);
    const planner = t.board.presets.create({ name: "planner", provider: "claude", model: "opus", roleHints: ["planner"] }).preset;
    t.store.cards.update(t.card.id, { plannerPresetId: planner.id });
    const { event } = t.flow.planStart(t.card.key, "phone");
    expect(event).toMatchObject({ type: "chat", authorKind: "user", author: "phone" });
    expect(event.body).toMatchObject({ thread: "plan", action: "make_plan" });
    expect(t.chats()).toHaveLength(1);
  });

  it("execStart moves a draft card to todo and dispatches it at once", async () => {
    const t = flowSetup();
    const { card: draft } = t.board.cards.create({ project: t.project.prefix, title: "Idea", presetId: t.preset.id });
    expect(draft.column).toBe("draft");
    const result = await t.flow.execStart(draft.key);
    expect(result.card.column).toBe("in_progress");
    expect(result.session.cardId).toBe(draft.id);
    expect(t.fake.calls.agent).toHaveLength(1);
    const moves = t.store.events.list(draft.id).filter((e) => (e.body as any)?.kind === "moved");
    expect(moves.map((e) => (e.body as any).to)).toContain("todo");
  });

  it("execStart dispatches a todo card, and refuses a card that is already running", async () => {
    const t = flowSetup();
    const result = await t.flow.execStart(t.card.key);
    expect(result.card.column).toBe("in_progress");
    expect(t.fake.calls.agent).toHaveLength(1);
    await expect(t.flow.execStart(t.card.key)).rejects.toThrow(/已经在执行|illegal/);
    expect(t.fake.calls.agent).toHaveLength(1);
  });

  it("execSwitch only stores the choice while nothing runs", async () => {
    const t = flowSetup();
    const other = t.board.presets.create({ name: "other", provider: "claude", model: "opus" }).preset;
    const out = await t.flow.execSwitch(t.card.key, other.id);
    expect(out.switched).toBe(false);
    expect(out.card.presetId).toBe(other.id);
    expect(t.switchTo).not.toHaveBeenCalled();
    expect((await t.flow.execSwitch(t.card.key, null)).card.presetId).toBeNull();
  });

  it("execSwitch hands a running worker over through the reassigner", async () => {
    const t = flowSetup();
    const { session } = await t.flow.execStart(t.card.key);
    const other = t.board.presets.create({ name: "other", provider: "claude", model: "opus" }).preset;
    const out = await t.flow.execSwitch(t.card.key, other.id);
    expect(t.switchTo).toHaveBeenCalledWith(session.id, other.id);
    expect(out).toMatchObject({ switched: true });
    expect(out.card.presetId).toBe(other.id);
    // picking the model that already runs is not a switch
    t.switchTo.mockClear();
    expect((await t.flow.execSwitch(t.card.key, other.id)).switched).toBe(false);
    expect(t.switchTo).not.toHaveBeenCalled();
  });
});
