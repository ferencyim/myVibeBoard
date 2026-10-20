import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDispatcher } from "../server/dispatch";
import { createReassigner, renderTranscript } from "../server/dispatch/reassign";
import { registerLifecycle } from "../server/lifecycle";
import { classifyFailure, isReassignable } from "../server/lifecycle/error-class";
import { eventTypes, setupBoard, tempDir } from "./helpers";

describe("failure classifier", () => {
  it.each([
    ["Claude AI usage limit reached|1760000000", "quota"],
    ["You've hit your usage limit. Upgrade to Pro", "quota"],
    ["Your credit balance is too low to access the Anthropic API", "quota"],
    ["Invalid API key · Please run /login", "auth"],
    ["401 Unauthorized: token expired", "auth"],
    ["There's an issue with the selected model (nope-9). It may not exist", "model"],
    ["model `gpt-9` does not exist", "model"],
    ["spawn codex ENOENT", "unavailable"],
    ["Provider 'codex' is unavailable", "unavailable"],
    ["API Error: 529 overloaded_error", "unavailable"],
    ["Tests failed with 3 errors", "other"],
    ["", "other"],
  ])("%s -> %s", (message, category) => {
    expect(classifyFailure(message)).toBe(category);
    expect(isReassignable(classifyFailure(message))).toBe(category !== "other");
  });
});

/** A fake Paseo with one workspace; records every agent created in it. */
function fakePaseo(opts: { failProviders?: string[]; unavailable?: string[] } = {}) {
  const created: any[] = [];
  const sent: Array<{ agentId: string; text: string }> = [];
  const paseo = {
    workspaces: {
      ref: () => ({
        refresh: async () => ({}),
        agents: {
          create: async (a: any) => {
            const provider = String(a.config.provider).split("/")[0];
            if (opts.failProviders?.includes(provider)) throw new Error(`${provider} login expired: please run /login`);
            created.push(a);
            return { id: a.agentId };
          },
        },
      }),
    },
    agents: {
      ref: (agentId: string) => ({
        timeline: {
          refetch: async () => ({
            entries: [
              { item: { type: "user_message", text: "do the thing" } },
              { item: { type: "assistant_message", text: "working on it" } },
              { item: { type: "error", message: "usage limit reached" } },
            ],
            hasOlder: false,
          }),
        },
        send: async (text: string) => void sent.push({ agentId, text }),
      }),
    },
    providers: {
      listAvailable: async () => ({
        providers: (opts.unavailable ?? []).map((provider) => ({ provider, available: false, error: "not installed" })),
      }),
    },
  } as any;
  return { paseo, created, sent };
}

function setup(paseoOpts: Parameters<typeof fakePaseo>[0] = {}, withFallbacks = true) {
  const t = setupBoard();
  const { board, runtime } = t;
  const { store } = runtime;
  const { project } = board.projects.create({ name: "Demo", prefix: "DEMO", repoPath: "d:/repo/demo", projectType: "web" });
  const mk = (name: string, provider: string, model: string, extra: Record<string, unknown> = {}) =>
    board.presets.create({ name, provider, model, ...extra }).preset;
  const c = mk("codex-fb", "codex", "gpt-5");
  const g = mk("gemini-fb", "gemini", "pro");
  const a = mk("claude-main", "claude", "opus", withFallbacks ? { fallbackPresetIds: [c.id, g.id] } : {});
  const { card } = board.cards.create({ project: project.prefix, title: "Fix login", column: "todo", presetId: a.id });
  const worktree = join(tempDir("wt-"), "card");
  const { session } = store.cards.dispatch({
    cardId: card.id,
    agentId: "old-agent",
    workspaceId: "ws1",
    provider: "claude",
    worktree,
    presetId: a.id,
  });
  store.sessions.setState(session.id, "working");
  const fake = fakePaseo(paseoOpts);
  let n = 0;
  const tracker = { expect: vi.fn(), bind: vi.fn(async () => {}), release: vi.fn() };
  return { ...t, store, a, c, g, card, session, worktree, fake, tracker, nextId: () => `new-${++n}` };
}

const failure = { message: "Claude AI usage limit reached", category: "quota" as const };

describe("reassigner", () => {
  it("continues on the first fallback in the same workspace, records it and hands off a transcript", async () => {
    const t = setup();
    const reassigner = createReassigner({
      board: t.board,
      getPaseo: () => t.fake.paseo,
      tracker: t.tracker,
      newAgentId: t.nextId,
      log: () => {},
    });
    const result = await reassigner.reassign(t.session.id, failure);
    expect(result.reassigned).toMatchObject({ agentId: "new-1", currentProvider: "codex", reassignedFromSessionId: t.session.id });
    expect(t.fake.created).toHaveLength(1);
    const created = t.fake.created[0];
    expect(created.config.provider).toBe("codex/gpt-5");
    expect(created.env.VIBE_CARD_KEY).toBe(t.card.key);
    expect(created.prompt).toContain("usage limit");
    expect(created.prompt).toContain("SAME worktree");
    // transcript file inside the worktree's .vibe/sessions
    const path = /transcript is in (.+\.md)/.exec(created.prompt)![1]!;
    expect(path.startsWith(join(t.worktree, ".vibe", "sessions"))).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("working on it");

    expect(t.store.sessions.get(t.session.id)).toMatchObject({ state: "ended" });
    expect(t.store.cards.get(t.card.id)!.presetId).toBe(t.c.id);
    expect(eventTypes(t.runtime)).toContain("session.reassigned");
    const events = t.store.events.list(t.card.id);
    expect(events.some((e) => e.type === "switch_agent")).toBe(true);
    expect(events.some((e) => (e.body as any)?.kind === "failover")).toBe(true);
    expect(t.tracker.expect).toHaveBeenCalledWith("new-1");
    expect(t.tracker.bind).toHaveBeenCalledWith("new-1");
  });

  it("tries fallbacks in order, skipping an unavailable provider and a start failure", async () => {
    const t = setup({ unavailable: ["codex"], failProviders: [] });
    const reassigner = createReassigner({ board: t.board, getPaseo: () => t.fake.paseo, newAgentId: t.nextId, log: () => {} });
    const result = await reassigner.reassign(t.session.id, failure);
    expect(result.reassigned?.currentProvider).toBe("gemini");

    const u = setup({ failProviders: ["codex"] });
    const r2 = await createReassigner({ board: u.board, getPaseo: () => u.fake.paseo, newAgentId: u.nextId, log: () => {} }).reassign(u.session.id, failure);
    expect(r2.reassigned?.currentProvider).toBe("gemini");
  });

  it("does not reuse presets already tried when the replacement fails too", async () => {
    const t = setup();
    const reassigner = createReassigner({ board: t.board, getPaseo: () => t.fake.paseo, newAgentId: t.nextId, log: () => {} });
    const first = await reassigner.reassign(t.session.id, failure);
    expect(first.reassigned?.currentProvider).toBe("codex");
    // the codex session fails as well: the chain of the ORIGINAL preset continues with gemini
    t.store.sessions.setState(first.reassigned!.id, "working");
    const second = await reassigner.reassign(first.reassigned!.id, { message: "usage limit", category: "quota" });
    expect(second.reassigned?.currentProvider).toBe("gemini");
    // nothing left
    t.store.sessions.setState(second.reassigned!.id, "working");
    const third = await reassigner.reassign(second.reassigned!.id, failure);
    expect(third).toMatchObject({ reassigned: null, reason: "no fallback preset configured" });
  });

  it("stops (reports why) with no fallback configured or when every fallback fails", async () => {
    const none = setup({}, false);
    const r1 = await createReassigner({ board: none.board, getPaseo: () => none.fake.paseo, log: () => {} }).reassign(none.session.id, failure);
    expect(r1).toMatchObject({ reassigned: null, reason: "no fallback preset configured" });
    expect(none.store.sessions.get(none.session.id)!.state).toBe("working");

    const all = setup({ failProviders: ["codex", "gemini"] });
    const r2 = await createReassigner({ board: all.board, getPaseo: () => all.fake.paseo, tracker: all.tracker, newAgentId: all.nextId, log: () => {} }).reassign(all.session.id, failure);
    expect(r2.reassigned).toBeNull();
    expect((r2 as any).attempts).toHaveLength(2);
    expect(all.tracker.release).toHaveBeenCalledTimes(2);
    expect(all.store.sessions.get(all.session.id)!.state).toBe("working");
  });

  it("uses native conversion when available (guarded import, then prompts the converted agent)", async () => {
    const t = setup();
    const convert = vi.fn(async () => "converted-1");
    const guard = vi.fn(async (_ws: string | null, fn: () => Promise<any>) => fn());
    const result = await createReassigner({
      board: t.board,
      getPaseo: () => t.fake.paseo,
      tracker: t.tracker,
      convert,
      guardImport: guard,
      newAgentId: t.nextId,
      log: () => {},
    }).reassign(t.session.id, failure);
    expect(result).toMatchObject({ method: "converted" });
    expect(result.reassigned).toMatchObject({ agentId: "converted-1", currentProvider: "codex" });
    expect(guard).toHaveBeenCalledWith("ws1", expect.any(Function));
    expect(convert).toHaveBeenCalledWith(expect.objectContaining({ fromProvider: "claude", fromAgentId: "old-agent" }));
    expect(t.fake.created).toHaveLength(0); // no transcript agent
    expect(t.fake.sent.some((s) => s.agentId === "converted-1" && s.text.includes(t.card.key))).toBe(true);
  });

  it("falls back to the transcript hand-off when conversion declines or throws", async () => {
    for (const convert of [async () => null, async () => Promise.reject(new Error("txcript missing"))]) {
      const t = setup();
      const result = await createReassigner({ board: t.board, getPaseo: () => t.fake.paseo, convert, newAgentId: t.nextId, log: () => {} }).reassign(t.session.id, failure);
      expect(result).toMatchObject({ method: "transcript" });
      expect(t.fake.created).toHaveLength(1);
    }
  });

  it("only reassigns card workers and ignores ended sessions", async () => {
    const t = setup();
    const r = createReassigner({ board: t.board, getPaseo: () => t.fake.paseo, newAgentId: t.nextId, log: () => {} });
    t.store.sessions.setState(t.session.id, "ended", { outcome: "closed" });
    expect(await r.reassign(t.session.id, failure)).toMatchObject({ reassigned: null });
    const verifier = t.store.sessions.start({ cardId: t.card.id, role: "verifier", agentId: "v1", provider: "claude" });
    expect(await r.reassign(verifier.id, failure)).toMatchObject({ reassigned: null, reason: "only card workers are reassigned" });
  });

  it("renders a transcript from timeline pages", async () => {
    const md = await renderTranscript(fakePaseo().paseo, "x");
    expect(md).toContain("## User");
    expect(md).toContain("### error");
  });
});

describe("lifecycle failover", () => {
  function wired(taken: boolean, throws = false) {
    const t = setup();
    const handlers = new Map<string, (e: any, c: any) => unknown>();
    const server = { on: (n: string, h: any) => (handlers.set(n, h), () => {}), before: () => () => {} } as any;
    const onFailure = vi.fn(async () => {
      if (throws) throw new Error("boom");
      return taken;
    });
    registerLifecycle(server, { board: t.board, log: () => {}, onFailure });
    const agent = { id: "old-agent", workspaceId: "ws1", parentAgentId: null, provider: "claude", cwd: "x", title: null };
    const fail = async (message: string) => {
      await handlers.get("agent.turn_ended")!(
        { agent, turnId: "t", outcome: { kind: "failed", error: { message } }, timeline: [] },
        { paseo: {}, signal: new AbortController().signal },
      );
      await new Promise((r) => setTimeout(r, 10));
    };
    return { ...t, onFailure, fail };
  }

  it("hands a reassignable worker failure to onFailure and leaves the session alone when taken over", async () => {
    const t = wired(true);
    await t.fail("Claude AI usage limit reached");
    expect(t.onFailure).toHaveBeenCalledWith(expect.objectContaining({ id: t.session.id }), expect.objectContaining({ category: "quota" }));
    expect(t.store.sessions.get(t.session.id)!.state).toBe("working");
    expect(eventTypes(t.runtime)).not.toContain("session.error");
  });

  it("stops at error (and pushes the error event) when nothing took over or the handler throws", async () => {
    for (const [taken, throws] of [[false, false], [false, true]] as const) {
      const t = wired(taken, throws);
      await t.fail("login expired: please run /login");
      expect(t.store.sessions.get(t.session.id)).toMatchObject({ state: "error" });
      expect(eventTypes(t.runtime)).toContain("session.error");
    }
  });

  it("goes straight to error for non-reassignable failures", async () => {
    const t = wired(true);
    await t.fail("the test suite failed");
    expect(t.onFailure).not.toHaveBeenCalled();
    expect(t.store.sessions.get(t.session.id)!.state).toBe("error");
  });
});

describe("dispatch failover (agent cannot start)", () => {
  function dispatchSetup(failProviders: string[], withFallbacks = true, failover = true) {
    const t = setupBoard();
    const { board, runtime } = t;
    const { project } = board.projects.create({ name: "Demo", prefix: "DEMO", repoPath: "d:/repo/demo", projectType: "web" });
    const fb = board.presets.create({ name: "codex-fb", provider: "codex", model: "gpt-5", environmentKind: "project-default" }).preset;
    const main = board.presets.create({
      name: "bad-claude",
      provider: "claude",
      model: "nope-9",
      environmentKind: "project-default",
      ...(withFallbacks ? { fallbackPresetIds: [fb.id] } : {}),
    }).preset;
    const { card } = board.cards.create({ project: project.prefix, title: "Fix", column: "todo", presetId: main.id });
    const created: any[] = [];
    const paseo = {
      projects: { list: async () => ({ projects: [{ projectId: "pp", projectRootPath: "D:\\Repo\\Demo", projectDisplayName: "demo", projectKind: "directory" }] }) },
      workspaces: {
        create: async () => ({
          id: "ws1",
          directory: "D:\\Repo\\Demo",
          agents: {
            create: async (a: any) => {
              const provider = String(a.config.provider).split("/")[0];
              if (failProviders.includes(provider)) throw new Error("There's an issue with the selected model (nope-9). It may not exist");
              created.push(a);
              return { id: a.agentId };
            },
          },
        }),
      },
    } as any;
    let n = 0;
    const dispatcher = createDispatcher({ board, getPaseo: () => paseo, newAgentId: () => `a-${++n}`, failoverEnabled: () => failover });
    return { ...t, dispatcher, card, fb, main, created, store: runtime.store };
  }

  it("starts the next preset of the chain and dispatches the card on it", async () => {
    const t = dispatchSetup(["claude"]);
    const result = await t.dispatcher.dispatch(t.card.key);
    expect(t.created).toHaveLength(1);
    expect(t.created[0].config.provider).toBe("codex/gpt-5");
    expect(result.session.currentProvider).toBe("codex");
    const card = t.store.cards.get(t.card.id)!;
    expect(card.column).toBe("in_progress");
    expect(card.presetId).toBe(t.fb.id);
    expect(t.store.events.list(t.card.id).some((e) => (e.body as any)?.kind === "failover")).toBe(true);
  });

  it("fails as before without a fallback or for a non-reassignable error", async () => {
    const t = dispatchSetup(["claude"], false);
    await expect(t.dispatcher.dispatch(t.card.key)).rejects.toThrow(/selected model/);
    expect(t.store.cards.get(t.card.id)!.column).toBe("todo");
  });

  it("respects the failover switch", async () => {
    const t = dispatchSetup(["claude"], true, false);
    await expect(t.dispatcher.dispatch(t.card.key)).rejects.toThrow(/selected model/);
    expect(t.created).toHaveLength(0);
  });
});
