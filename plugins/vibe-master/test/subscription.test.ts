import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { publishEvent } from "../server/vibe/db";
import { workerHistory } from "../server/assess/assess";
import { MASTER_RULES } from "../server/master/rules.generated";
import { createMasterRuntime } from "../server/runtime";
import { pickModel, pickThinking, resolveTarget } from "../server/subscription/target";
import {
  ManualClock,
  MODELS,
  assessmentJson,
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
    const t = build(() => assessmentJson());
    const a = t.board.draft("First");
    const b = t.board.draft("Second");
    t.runtime.triggers.assessNow(a.id);
    t.runtime.triggers.assessNow(b.id);
    await t.runtime.queue.idle();

    expect(t.fake.agents).toHaveLength(1);
    const agent = t.fake.agents[0]!;
    expect(agent.options.config.provider).toBe("claude/opus-x");
    expect(agent.options.config.systemPrompt).toBe(MASTER_RULES);
    expect(agent.options.env).toMatchObject({ VIBE_ROLE: "master" });
    expect(agent.options.labels).toMatchObject({ role: "master" });
    // claude gets the rules as system prompt only; the first wake message is just the wake
    expect(agent.prompts[0]!.startsWith("[wake:assess_draft]")).toBe(true);

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
    const c = t.board.draft("Third");
    again.triggers.assessNow(c.id);
    await again.queue.idle();
    expect(t.fake.agents).toHaveLength(1);
    expect(agent.prompts).toHaveLength(3);
    await again.dispose();
    await t.runtime.dispose();
  });

  it("sends the rules in the conversation for providers that ignore the system prompt", async () => {
    const t = build(() => assessmentJson(), { settings: { provider: "codex" } });
    const card = t.board.draft("Codex master");
    t.runtime.triggers.assessNow(card.id);
    await t.runtime.queue.idle();
    expect(t.fake.agents[0]!.prompts[0]).toContain("# Vibe 总 agent");
    expect(t.fake.agents[0]!.prompts[0]).toContain("[wake:assess_draft]");
    await t.runtime.dispose();
  });
});

describe("subscription switching", () => {
  it("switches to Codex at its highest level and carries on with the same batch of cards", async () => {
    const gate = deferred();
    const t = build(async ({ provider, prompt }) => {
      if (provider === "claude" && prompt.includes("Card 1")) await gate.promise;
      return assessmentJson({ recommendation: { agent: provider, reason: `assessed by ${provider}` } });
    });
    const cards = [1, 2, 3].map((n) => t.board.draft(`Card ${n}`));
    for (const c of cards) t.runtime.triggers.assessNow(c.id);
    await tick(20);
    expect(t.fake.agents).toHaveLength(1); // claude is busy with card 1

    const switching = t.runtime.switchTo({ provider: "codex", thinking: "max" }, "owner picked Codex");
    gate.resolve();
    const result = await switching;
    await t.runtime.queue.idle();

    expect(result).toMatchObject({ changed: true, target: { provider: "codex", model: "gpt-5-codex", thinking: "xhigh" } });
    expect(t.fake.agents.map((a) => a.provider)).toEqual(["claude", "codex"]);
    expect(t.fake.agents[0]!.archived).toBe(false); // WP-93: the old conversation stays openable
    expect(t.fake.agents[1]!.options.config.thinkingOptionId).toBe("xhigh");

    // card 1 finished on claude, cards 2 and 3 on codex: nothing lost, nothing assessed twice
    const evals = cards.map((c) =>
      t.board.store.events.list(c.id).filter((e) => e.type === "evaluation").length,
    );
    expect(evals).toEqual([1, 1, 1]);
    expect(t.fake.agents[0]!.prompts).toHaveLength(1);
    expect(t.fake.agents[1]!.prompts).toHaveLength(2);

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
    const t = build(() => assessmentJson(), { failCreate: (p) => (p === "codex" ? "codex is not logged in" : null) });
    const card = t.board.draft("Before the failed switch");
    t.runtime.triggers.assessNow(card.id);
    await t.runtime.queue.idle();
    await expect(t.runtime.switchTo({ provider: "codex" })).rejects.toThrow(/not logged in/);
    expect(t.fake.agents[0]!.archived).toBe(false);
    expect(t.runtime.state.read().target).toBeUndefined();
    const next = t.board.draft("After the failed switch");
    t.runtime.triggers.assessNow(next.id);
    await t.runtime.queue.idle();
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
        : assessmentJson(),
    );
    const card = t.board.draft("Hits the limit");
    t.runtime.triggers.assessNow(card.id);
    await t.runtime.queue.idle();

    expect(t.fake.agents).toHaveLength(1); // no automatic switch
    expect(t.board.store.events.list(card.id).some((e) => e.type === "evaluation")).toBe(false);
    expect(alerts(t.board).some((m) => m.startsWith("[master:quota_error] claude:"))).toBe(true);
    expect(t.board.store.sessions.list({ role: "master" })[0]!.state).toBe("error");
    const status = await t.runtime.status(false);
    expect(status.queue.blocked).toBe(1);
    expect(status.lastAlert?.kind).toBe("quota_error");

    limited = false;
    await t.runtime.switchTo({ provider: "codex" });
    await t.runtime.queue.idle();
    expect(t.board.store.events.list(card.id).some((e) => e.type === "evaluation")).toBe(true);
    expect((await t.runtime.status(false)).queue.blocked).toBe(0);
    await t.runtime.dispose();
  });

  it("does not block on non-quota failures and raises no reminder", async () => {
    const t = build(() => ({ status: "error", lastMessage: null, error: "network down" }));
    const card = t.board.draft("Plain failure");
    t.runtime.triggers.assessNow(card.id);
    await t.runtime.queue.idle();
    expect(alerts(t.board)).toEqual([]);
    expect((await t.runtime.status(false)).queue.blocked).toBe(0);
    await t.runtime.dispose();
  });

  it("raises one low-quota reminder per cooldown for the master's provider", async () => {
    const t = build(() => assessmentJson(), { usage: [usageOf("claude", 8), usageOf("codex", 90)] });
    const card = t.board.draft("Quota watcher");
    t.runtime.triggers.assessNow(card.id);
    await t.runtime.queue.idle();

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
    const t = build(() => assessmentJson(), { usage: [usageOf("claude", 60), usageOf("codex", 15)] });
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
    const t = build(() => assessmentJson());
    const card = t.board.draft("Scheduler aware");
    t.runtime.triggers.assessNow(card.id);
    await t.runtime.queue.idle(); // master is now live on claude

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

  it("feeds the track record in .vibe/workers/<provider>/MEMORY.md to the selector", () => {
    const board = setupBoard();
    const dir = join(board.repoPath, ".vibe", "workers", "claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "MEMORY.md"), ["- success: fixed layout bug #web", "- failed: android build broke #android", ""].join("\n"));
    const history = workerHistory(board.project, board.store.presets.list());
    const claude = board.store.presets.list().find((p) => p.provider === "claude")!;
    expect(history[claude.id]!.web).toBeGreaterThan(0);
    expect(history[claude.id]!.android).toBeLessThan(0);
    expect(Object.keys(history)).toEqual([claude.id]);
  });
});
