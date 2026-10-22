import { describe, expect, it } from "vitest";
import { publishEvent } from "../server/vibe/db";
import { MASTER_RULES } from "../server/master/rules.generated";
import { createMasterRuntime } from "../server/runtime";
import { pickModel, pickThinking, resolveTarget } from "../server/subscription/target";
import {
  ManualClock,
  askMaster,
  MODELS,
  defaultSettings,
  deferred,
  fakePaseo,
  setupBoard,
  tempDir,
  tick,
  usageOf,
  type Script,
} from "./helpers";

function build(script: Script, over: { usage?: ReturnType<typeof usageOf>[]; failCreate?: (p: string) => string | null; settings?: Parameters<typeof defaultSettings>[0] } = {}) {
  const board = setupBoard();
  const clock = new ManualClock();
  const fake = fakePaseo(script, { usage: over.usage, failCreate: over.failCreate });
  const settings = defaultSettings(over.settings);
  const dataDir = tempDir();
  const runtime = createMasterRuntime({
    db: board.db,
    store: board.store,
    getPaseo: () => fake.paseo,
    settings: () => settings,
    dataDir,
    clock,
    pollIntervalMs: 3_600_000,
    log: () => undefined,
  });
  return { board, clock, fake, runtime, dataDir };
}

/** A finished card: waking the master for it asks for a memory consolidation. */
function doneCard(board: ReturnType<typeof setupBoard>, title: string) {
  const card = board.store.cards.create({ projectId: board.project.id, title }, "user");
  board.store.cards.move(card.id, { to: "todo", actor: "user" });
  board.store.cards.dispatch({ cardId: card.id, agentId: "w1", provider: "claude", worktree: null });
  board.store.cards.move(card.id, { to: "verifying", actor: "lifecycle" });
  board.store.cards.move(card.id, { to: "done", actor: "user" });
  return card;
}
const memoryUpdated = (board: ReturnType<typeof setupBoard>, cardId: string) =>
  board.store.events.list(cardId).some((e) => (e.body as { kind?: string } | null)?.kind === "memory_update");
const CONSOLIDATED = JSON.stringify({ summary: "Recorded." });

const alerts = (board: ReturnType<typeof setupBoard>) =>
  board.db
    .prepare<{ payload_json: string }>("SELECT payload_json FROM vibe_event WHERE type = 'master.alert' ORDER BY seq")
    .all()
    .map((r) => JSON.parse(r.payload_json) as { kind: string; provider: string; message: string })
    .map((p) => `[master:${p.kind}] ${p.provider}: ${p.message}`);

describe("target resolution", () => {
  it("prefers Opus for Claude, the default elsewhere, and the highest thinking level on request", async () => {
    const paseo = fakePaseo(() => "").paseo;
    expect(await resolveTarget(paseo, { provider: "claude" })).toEqual({ provider: "claude", model: "opus-x", thinking: null });
    expect(await resolveTarget(paseo, { provider: "claude", model: "sonnet-x" })).toMatchObject({ model: "sonnet-x" });
    expect(await resolveTarget(paseo, { provider: "codex", thinking: "max" })).toEqual({
      provider: "codex",
      model: "gpt-5-codex",
      thinking: "xhigh",
    });
    expect(pickThinking(MODELS.claude![1]!, "high")).toBe("high");
    expect(() => pickThinking(MODELS.claude![1]!, "ultra")).toThrow(/not available/);
    expect(() => pickModel(MODELS.claude!, "claude", "gpt")).toThrow(/not available/);
  });
});

describe("master session", () => {
  it("starts one long-lived master agent with the rules and reuses it", async () => {
    const t = build(() => "ok");
    await askMaster(t.runtime, "first");
    await askMaster(t.runtime, "second");

    expect(t.fake.agents).toHaveLength(1);
    const agent = t.fake.agents[0]!;
    expect(agent.options.config.provider).toBe("claude/opus-x");
    expect(agent.options.config.systemPrompt).toBe(MASTER_RULES);
    expect(agent.options.env).toMatchObject({ VIBE_ROLE: "master" });
    expect(agent.options.labels).toMatchObject({ role: "master" });
    // claude gets the rules as system prompt only
    expect(agent.prompts[0]).toBe("first");

    const sessions = t.board.store.sessions.list({ role: "master" });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ cardId: null, agentId: agent.id, state: "idle" });

    // a restarted plugin finds the agent through the state file and keeps using it
    const again = createMasterRuntime({
      db: t.board.db,
      store: t.board.store,
      getPaseo: () => t.fake.paseo,
      settings: () => defaultSettings(),
      dataDir: t.dataDir,
      clock: t.clock,
      pollIntervalMs: 3_600_000,
      log: () => undefined,
    });
    await askMaster(again, "third");
    expect(t.fake.agents).toHaveLength(1);
    expect(agent.prompts).toHaveLength(3);
    await again.dispose();
    await t.runtime.dispose();
  });

  it("sends the rules in the conversation for providers that ignore the system prompt", async () => {
    const t = build(() => "ok", { settings: { provider: "codex" } });
    await askMaster(t.runtime, "hello");
    expect(t.fake.agents[0]!.prompts[0]).toContain("# Vibe 总 agent");
    expect(t.fake.agents[0]!.prompts[0]).toContain("hello");
    await t.runtime.dispose();
  });
});

describe("subscription switching", () => {
  it("switches to Codex at its highest level and carries on with the new agent", async () => {
    const t = build(({ provider }) => `answered by ${provider}`);
    await askMaster(t.runtime, "one");
    expect(t.fake.agents).toHaveLength(1);

    const result = await t.runtime.switchTo({ provider: "codex", thinking: "max" }, "owner picked Codex");

    expect(result).toMatchObject({ changed: true, target: { provider: "codex", model: "gpt-5-codex", thinking: "xhigh" } });
    expect(t.fake.agents.map((a) => a.provider)).toEqual(["claude", "codex"]);
    expect(t.fake.agents[0]!.archived).toBe(false); // WP-93: the old conversation stays openable
    expect(t.fake.agents[1]!.options.config.thinkingOptionId).toBe("xhigh");

    await askMaster(t.runtime, "two");
    expect(t.fake.agents[0]!.prompts).toHaveLength(1);
    expect(t.fake.agents[1]!.prompts.at(-1)).toContain("two");

    const sessions = t.board.store.sessions.list({ role: "master" });
    expect(sessions.map((s) => [s.currentProvider, s.state])).toEqual([
      ["codex", "ended"],
      ["codex", "idle"],
    ]);
    const status = await t.runtime.status(false);
    expect(status.targetSource).toBe("switched");
    expect(status.session?.provider).toBe("codex");
    expect(status.switchHistory).toMatchObject([{ from: "claude", to: "codex", reason: "owner picked Codex" }]);
    expect(t.board.eventTypes()).toContain("session.switched");

    // the choice survives a restart; switching to the same target is a no-op
    expect((await t.runtime.switchTo({ provider: "codex", thinking: "max" })).changed).toBe(false);
    expect(t.fake.agents).toHaveLength(2);
    await t.runtime.dispose();
  });

  it("keeps the old master when the new provider cannot start", async () => {
    const t = build(() => "ok", { failCreate: (p) => (p === "codex" ? "codex is not logged in" : null) });
    await askMaster(t.runtime);
    await expect(t.runtime.switchTo({ provider: "codex" })).rejects.toThrow(/not logged in/);
    expect(t.fake.agents[0]!.archived).toBe(false);
    expect(t.runtime.state.read().target).toBeUndefined();
    await askMaster(t.runtime);
    expect(t.fake.agents[0]!.prompts).toHaveLength(2);
    await t.runtime.dispose();
  });
});

describe("quota", () => {
  it("only reminds on a quota error: no switch, the job is kept and runs after the owner switches", async () => {
    let limited = true;
    const t = build(({ provider }) =>
      provider === "claude" && limited
        ? { status: "error", lastMessage: null, error: "Claude usage limit reached. Your limit resets at 5pm." }
        : CONSOLIDATED,
    );
    const card = doneCard(t.board, "Hits the limit");
    t.runtime.wake(card.key, "card_done", true);
    await t.runtime.queue.idle();

    expect(t.fake.agents).toHaveLength(1); // no automatic switch
    expect(memoryUpdated(t.board, card.id)).toBe(false);
    expect(alerts(t.board).some((m) => m.startsWith("[master:quota_error] claude:"))).toBe(true);
    expect(t.board.store.sessions.list({ role: "master" })[0]!.state).toBe("error");
    const status = await t.runtime.status(false);
    expect(status.queue.blocked).toBe(1);
    expect(status.lastAlert?.kind).toBe("quota_error");

    limited = false;
    await t.runtime.switchTo({ provider: "codex" });
    await t.runtime.queue.idle();
    expect(memoryUpdated(t.board, card.id)).toBe(true);
    expect((await t.runtime.status(false)).queue.blocked).toBe(0);
    await t.runtime.dispose();
  });

  it("does not block on non-quota failures and raises no reminder", async () => {
    const t = build(() => ({ status: "error", lastMessage: null, error: "network down" }));
    const card = doneCard(t.board, "Plain failure");
    t.runtime.wake(card.key, "card_done", true);
    await t.runtime.queue.idle();
    expect(alerts(t.board)).toEqual([]);
    expect((await t.runtime.status(false)).queue.blocked).toBe(0);
    await t.runtime.dispose();
  });

  it("raises one low-quota reminder per cooldown for the master's provider", async () => {
    const t = build(() => "ok", { usage: [usageOf("claude", 8), usageOf("codex", 90)] });
    await askMaster(t.runtime);

    t.runtime.startQuotaMonitor();
    t.clock.advance(300_000);
    await tick(20);
    t.clock.advance(300_000);
    await tick(20);
    const lows = alerts(t.board).filter((m) => m.startsWith("[master:quota_low]"));
    expect(lows).toHaveLength(1);
    expect(lows[0]).toContain("claude");
    expect(t.fake.agents).toHaveLength(1);

    t.fake.setUsage([usageOf("claude", 95)]);
    await t.runtime.dispose();
  });
});

describe("status", () => {
  it("lists providers with models, thinking options and quota for the switch UI", async () => {
    const t = build(() => "ok", { usage: [usageOf("claude", 60), usageOf("codex", 15)] });
    const status = await t.runtime.status(true);
    expect(status.paseoReady).toBe(true);
    const claude = status.providers.find((p) => p.id === "claude")!;
    expect(claude).toMatchObject({ remainingPct: 60, level: "ok" });
    const codex = status.providers.find((p) => p.id === "codex")!;
    expect(codex.level).toBe("tight");
    expect(codex.models[0]!.thinking.map((o) => o.id)).toContain("xhigh");
    expect(status.target).toEqual({ provider: "claude", model: "opus-x", thinking: null });
    expect(status.targetSource).toBe("settings");
    await t.runtime.dispose();
  });
});

describe("scheduler signals", () => {
  it("reminds when the scheduler reports low quota on the master's provider and tracks pauses", async () => {
    const t = build(() => "ok");
    await askMaster(t.runtime); // master is now live on claude

    publishEvent(t.board.db, { type: "scheduler.quota_low", payload: { provider: "codex", level: "tight", remainingPct: 9 } });
    publishEvent(t.board.db, { type: "scheduler.paused", payload: { reason: "memory", mem: 0.95, top: [] } });
    await t.runtime.triggers.consumer.poll();
    expect(alerts(t.board)).toEqual([]); // not the master's provider
    expect((await t.runtime.status(false)).schedulerPaused).toBe(true);

    publishEvent(t.board.db, { type: "scheduler.quota_low", payload: { provider: "claude", level: "exhausted", remainingPct: 0 } });
    publishEvent(t.board.db, { type: "scheduler.resumed", payload: { reason: "memory" } });
    await t.runtime.triggers.consumer.poll();
    expect(alerts(t.board).filter((m) => m.startsWith("[master:quota_low] claude"))).toHaveLength(1);
    expect((await t.runtime.status(false)).schedulerPaused).toBe(false);
    await t.runtime.dispose();
  });

  it("reminds the owner when a maintenance rule is paused and only logs triggered runs", async () => {
    const t = build(() => "");
    publishEvent(t.board.db, { type: "maintenance.triggered", payload: { ruleId: "r1", runId: "run1" } });
    publishEvent(t.board.db, {
      type: "maintenance.paused",
      payload: { ruleId: "r1", ruleName: "git-health", reason: "rejections", rejections: 3 },
    });
    await t.runtime.triggers.consumer.poll();
    expect(alerts(t.board)).toHaveLength(1);
    expect(alerts(t.board)[0]).toContain("[master:maintenance_paused]");
    expect(alerts(t.board)[0]).toContain("git-health");
    await t.runtime.dispose();
  });
});
