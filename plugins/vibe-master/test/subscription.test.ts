import { describe, expect, it } from "vitest";
import { publishEvent } from "../server/vibe/db";
import { MASTER_RULES } from "../server/master/rules.generated";
import { createMasterRuntime } from "../server/runtime";
import { pickModel, resolveTarget } from "../server/subscription/target";
import {
  ManualClock,
  askMaster,
  choosePreset,
  MODELS,
  defaultSettings,
  fakePaseo,
  setupBoard,
  tempDir,
  tick,
  usageOf,
  type Script,
} from "./helpers";

function build(
  script: Script,
  over: {
    usage?: ReturnType<typeof usageOf>[];
    failCreate?: (p: string) => string | null;
    settings?: Parameters<typeof defaultSettings>[0];
  } = {},
) {
  const board = setupBoard();
  const clock = new ManualClock();
  const fake = fakePaseo(script, { usage: over.usage, failCreate: over.failCreate });
  const settings = defaultSettings(over.settings);
  const dataDir = tempDir();
  const runtime = createMasterRuntime({
    admitMaster: async () => async () => undefined,
    admitMemory: async () => async () => undefined,
    db: board.db,
    store: board.store,
    getPaseo: () => fake.paseo,
    settings: () => settings,
    dataDir,
    clock,
    pollIntervalMs: 3_600_000,
    log: () => undefined,
  });
  return { board, clock, fake, runtime, dataDir, settings };
}

/** A finished card: waking the master for it asks for a memory consolidation. */
function doneCard(board: ReturnType<typeof setupBoard>, title: string) {
  const card = board.store.cards.create({ projectId: board.project.id, title }, "user");
  board.store.cards.move(card.id, { to: "todo", actor: "user" });
  board.store.cards.dispatch({
    cardId: card.id,
    agentId: "w1",
    provider: "claude",
    worktree: null,
  });
  board.store.cards.move(card.id, { to: "verifying", actor: "lifecycle" });
  board.store.cards.move(card.id, { to: "done", actor: "user" });
  return card;
}
const memoryUpdated = (board: ReturnType<typeof setupBoard>, cardId: string) =>
  board.store.events
    .list(cardId)
    .some((e) => (e.body as { kind?: string } | null)?.kind === "memory_update");
const CONSOLIDATED = JSON.stringify({ summary: "Recorded." });

const alerts = (board: ReturnType<typeof setupBoard>) =>
  board.db
    .prepare<{ payload_json: string }>(
      "SELECT payload_json FROM vibe_event WHERE type = 'master.alert' ORDER BY seq",
    )
    .all()
    .map((r) => JSON.parse(r.payload_json) as { kind: string; provider: string; message: string })
    .map((p) => `[master:${p.kind}] ${p.provider}: ${p.message}`);

describe("target resolution", () => {
  it("prefers Opus for Claude and the default model elsewhere", async () => {
    const paseo = fakePaseo(() => "").paseo;
    expect(await resolveTarget(paseo, { provider: "claude" })).toEqual({
      provider: "claude",
      model: "opus-x",
      thinking: null,
    });
    expect(await resolveTarget(paseo, { provider: "claude", model: "sonnet-x" })).toMatchObject({
      model: "sonnet-x",
    });
    expect(await resolveTarget(paseo, { provider: "codex" })).toEqual({
      provider: "codex",
      model: "gpt-5-codex",
      thinking: null,
    });
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
      admitMaster: async () => async () => undefined,
      admitMemory: async () => async () => undefined,
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

describe("preset switching", () => {
  it("moves to another preset and carries on with the new agent", async () => {
    const t = build(({ provider }) => `answered by ${provider}`);
    await askMaster(t.runtime, "one");
    expect(t.fake.agents).toHaveLength(1);

    await choosePreset(t, t.board.presets.codex.id);

    expect(t.fake.agents.map((a) => a.provider)).toEqual(["claude", "codex"]);
    expect(t.fake.agents[0]!.archived).toBe(false); // WP-93: the old conversation stays openable
    expect(t.fake.agents[1]!.options.config.thinkingOptionId).toBe("xhigh");

    await askMaster(t.runtime, "two");
    expect(t.fake.agents[0]!.prompts).toHaveLength(1);
    expect(t.fake.agents[1]!.prompts.at(-1)).toContain("two");

    const sessions = t.board.store.sessions.list({ role: "master" });
    expect(sessions.map((s) => [s.currentProvider, s.state])).toEqual([
      ["claude", "ended"],
      ["codex", "idle"],
    ]);
    const status = await t.runtime.status();
    expect(status.preset).toMatchObject({ id: t.board.presets.codex.id, migrated: false });
    expect(status.session?.provider).toBe("codex");
    expect(status.switchHistory).toMatchObject([
      { from: "claude", to: "codex", reason: "切换总 agent 预设" },
    ]);
    expect(t.board.eventTypes()).toContain("session.switched");

    // applying the same preset again changes nothing
    await t.runtime.onSettingsChanged();
    expect(t.fake.agents).toHaveLength(2);
    await t.runtime.dispose();
  });

  it("keeps the old master running when the new preset's provider cannot start", async () => {
    const t = build(() => "ok", {
      failCreate: (p) => (p === "codex" ? "codex is not logged in" : null),
    });
    await askMaster(t.runtime);
    await choosePreset(t, t.board.presets.codex.id); // logged, not thrown
    expect(t.fake.agents).toHaveLength(1);
    expect(t.fake.agents[0]!.archived).toBe(false);
    expect(t.board.store.sessions.list({ role: "master", states: ["idle"] })).toHaveLength(1);
    await expect(askMaster(t.runtime)).rejects.toThrow(/所有模型均不可用/);
    await choosePreset(t, t.board.presets.claude.id);
    await askMaster(t.runtime);
    expect(t.fake.agents[0]!.prompts).toHaveLength(2);
    await t.runtime.dispose();
  });

  it("migrates the pre-preset provider/model/thinking settings to the matching preset, and asks for a choice when none matches", async () => {
    const old = build(() => "ok", {
      settings: { provider: "codex", model: "gpt-5-codex", thinking: "xhigh" },
    });
    await askMaster(old.runtime);
    expect(old.fake.agents[0]!.provider).toBe("codex");
    expect(await old.runtime.status()).toMatchObject({
      preset: { id: old.board.presets.codex.id, migrated: true },
      target: { provider: "codex", model: "gpt-5-codex", thinking: "xhigh" },
    });
    // a model no preset has: nothing is guessed
    const lost = build(() => "ok", { settings: { provider: "codex", model: "gpt-9" } });
    expect((await lost.runtime.status()).preset).toBeNull();
    await expect(askMaster(lost.runtime)).rejects.toThrow(/预设/);
    expect(lost.fake.agents).toHaveLength(0);
    // no legacy fields and no preset: same
    const fresh = build(() => "ok", { settings: { provider: "" } });
    expect((await fresh.runtime.status()).preset).toBeNull();
    // an explicit choice wins over the legacy fields
    const chosen = build(() => "ok", { settings: { provider: "codex", presetId: "" } });
    await choosePreset(chosen, chosen.board.presets.claude.id);
    expect((await chosen.runtime.status()).preset).toMatchObject({ migrated: false });
    for (const t of [old, lost, fresh, chosen]) await t.runtime.dispose();
  });
});

describe("quota", () => {
  function ordered(t: ReturnType<typeof build>) {
    const preset = t.board.store.presets.update(t.board.presets.claude.id, {
      models: [
        { provider: "claude", model: "opus-x", thinking: "high", permissionMode: "auto" },
        {
          provider: "codex",
          model: "gpt-5-codex",
          thinking: "xhigh",
          permissionMode: "accept-edits",
        },
        { provider: "kimi", model: "kimi-k2", thinking: "", permissionMode: "auto" },
      ],
    });
    t.settings.presetId = preset.id;
    return preset;
  }

  it("retries the same request in order with handoff and persists the actual active model", async () => {
    const t = build(({ provider }) =>
      provider === "claude"
        ? { status: "error", lastMessage: null, error: "quota exhausted" }
        : "continued",
    );
    ordered(t);
    t.settings.permissionMode = "preset";
    expect(await askMaster(t.runtime, "finish the memory update")).toBe("continued");
    expect(t.fake.agents.map((a) => a.provider)).toEqual(["claude", "codex"]);
    expect(t.fake.agents[1]!.prompts[0]).toContain("finish the memory update");
    expect(t.fake.agents[1]!.prompts[0]).toContain("本次更换原因");
    expect(t.fake.agents[1]!.options.config.modeId).toBe("auto");
    expect(t.fake.agents[0]!.archived).toBe(false);
    expect(t.runtime.sessions().find((s) => s.provider === "claude")).toMatchObject({
      state: "ended",
      current: false,
    });
    expect((await t.runtime.status()).target).toMatchObject({
      provider: "codex",
      model: "gpt-5-codex",
    });
    const again = createMasterRuntime({
      admitMaster: async () => async () => undefined,
      admitMemory: async () => async () => undefined,
      db: t.board.db,
      store: t.board.store,
      getPaseo: () => t.fake.paseo,
      settings: () => t.settings,
      dataDir: t.dataDir,
      clock: t.clock,
      log: () => undefined,
    });
    await askMaster(again);
    expect(t.fake.agents).toHaveLength(2);
    expect((await again.status()).target?.provider).toBe("codex");
    await again.dispose();
    await t.runtime.dispose();
  });

  it("skips an unavailable binary and an expired login during startup", async () => {
    const t = build(() => "ok", {
      failCreate: (p) => {
        if (p === "claude") return "provider not installed";
        return p === "codex" ? "not logged in" : null;
      },
    });
    ordered(t);
    expect(await askMaster(t.runtime)).toBe("ok");
    expect(t.fake.agents.map((a) => a.provider)).toEqual(["kimi"]);
    expect((await t.runtime.status()).target?.provider).toBe("kimi");
    await t.runtime.dispose();
  });

  it("stops without looping when every candidate fails, then resets when the preset changes", async () => {
    const t = build(() => ({ status: "error", lastMessage: null, error: "invalid api key" }));
    ordered(t);
    await expect(askMaster(t.runtime)).rejects.toThrow(/所有模型均不可用/);
    expect(t.fake.agents).toHaveLength(3);
    await expect(askMaster(t.runtime)).rejects.toThrow(/所有模型均不可用/);
    expect(t.fake.agents).toHaveLength(3);
    await choosePreset(t, t.board.presets.codex.id);
    expect((await t.runtime.status()).target?.provider).toBe("codex");
    expect(t.runtime.state.read().presetSelection?.exhausted).toBeUndefined();
    await t.runtime.dispose();
  });

  it("moves to the next candidate when the quota monitor confirms exhaustion", async () => {
    const t = build(() => "ok", { usage: [usageOf("claude", 0), usageOf("codex", 70)] });
    ordered(t);
    await askMaster(t.runtime);
    await t.runtime.checkQuota();
    expect(t.fake.agents.map((a) => a.provider)).toEqual(["claude", "codex"]);
    expect((await t.runtime.status()).target?.provider).toBe("codex");
    await t.runtime.dispose();
  });

  it("stops after the sole candidate exhausts quota and resumes after a preset change", async () => {
    let limited = true;
    const t = build(({ provider }) =>
      provider === "claude" && limited
        ? {
            status: "error",
            lastMessage: null,
            error: "Claude usage limit reached. Your limit resets at 5pm.",
          }
        : CONSOLIDATED,
    );
    const card = doneCard(t.board, "Hits the limit");
    t.runtime.queue.enqueue({ kind: "card_done", cardId: card.id, force: true });
    await t.runtime.queue.idle();

    expect(t.fake.agents).toHaveLength(1); // no automatic switch
    expect(memoryUpdated(t.board, card.id)).toBe(false);
    expect(alerts(t.board).some((m) => m.startsWith("[master:quota_error] claude:"))).toBe(true);
    expect(t.board.store.sessions.list({ role: "master" })[0]!.state).toBe("error");
    const status = await t.runtime.status();
    expect(status.queue.blocked).toBe(1);
    expect(status.lastAlert?.kind).toBe("provider_error");

    limited = false;
    await choosePreset(t, t.board.presets.codex.id);
    await t.runtime.queue.idle();
    expect(memoryUpdated(t.board, card.id)).toBe(true);
    expect((await t.runtime.status()).queue.blocked).toBe(0);
    await t.runtime.dispose();
  });

  it("does not block on non-provider failures and raises no reminder", async () => {
    const t = build(() => ({ status: "error", lastMessage: null, error: "network down" }));
    const card = doneCard(t.board, "Plain failure");
    t.runtime.queue.enqueue({ kind: "card_done", cardId: card.id, force: true });
    await t.runtime.queue.idle();
    expect(alerts(t.board)).toEqual([]);
    expect((await t.runtime.status()).queue.blocked).toBe(0);
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
  it("lists the presets with their provider's quota for the settings page", async () => {
    const t = build(() => "ok", { usage: [usageOf("claude", 60), usageOf("codex", 15)] });
    const status = await t.runtime.status();
    expect(status.paseoReady).toBe(true);
    const claude = status.presets.find((p) => p.id === t.board.presets.claude.id)!;
    expect(claude).toMatchObject({
      name: "Claude Opus",
      provider: "claude",
      remainingPct: 60,
      level: "ok",
    });
    expect(status.presets.find((p) => p.id === t.board.presets.codex.id)!.level).toBe("tight");
    expect(status.target).toEqual({ provider: "claude", model: "opus-x", thinking: "high" });
    await t.runtime.dispose();
  });
});

describe("scheduler signals", () => {
  it("reminds when the scheduler reports low quota on the master's provider and tracks pauses", async () => {
    const t = build(() => "ok");
    await askMaster(t.runtime); // master is now live on claude

    publishEvent(t.board.db, {
      type: "scheduler.quota_low",
      payload: { provider: "codex", level: "tight", remainingPct: 9 },
    });
    publishEvent(t.board.db, {
      type: "scheduler.paused",
      payload: { reason: "memory", mem: 0.95, top: [] },
    });
    await t.runtime.triggers.consumer.poll();
    expect(alerts(t.board)).toEqual([]); // not the master's provider
    expect((await t.runtime.status()).schedulerPaused).toBe(true);

    publishEvent(t.board.db, {
      type: "scheduler.quota_low",
      payload: { provider: "claude", level: "exhausted", remainingPct: 0 },
    });
    publishEvent(t.board.db, { type: "scheduler.resumed", payload: { reason: "memory" } });
    await t.runtime.triggers.consumer.poll();
    expect(alerts(t.board).filter((m) => m.startsWith("[master:quota_low] claude"))).toHaveLength(
      1,
    );
    expect((await t.runtime.status()).schedulerPaused).toBe(false);
    await t.runtime.dispose();
  });

  it("reminds the owner when a maintenance rule is paused and only logs triggered runs", async () => {
    const t = build(() => "");
    publishEvent(t.board.db, {
      type: "maintenance.triggered",
      payload: { ruleId: "r1", runId: "run1" },
    });
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
