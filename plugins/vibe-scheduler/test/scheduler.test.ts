import { describe, expect, it } from "vitest";
import { publishEvent } from "../server/vibe/db";
import { effectiveLimit, deviceKindFor } from "../server/scheduler";
import { schedulerSettings } from "../shared/rpc";
import { DEFAULT_CONFIG } from "../server/scheduler";
import { setup, usage } from "./helpers";

const keys = (r: { admitted: Array<{ cardKey: string }> }) => r.admitted.map((a) => a.cardKey);

describe("priority admission", () => {
  it("admits by priority, then by time in todo, within the global limit", async () => {
    const t = setup({ settings: { globalLimit: 2 } });
    const p = t.preset("claude");
    t.card("low early", "low", p.id);
    t.card("medium", "medium", p.id);
    t.card("urgent late", "urgent", p.id);
    t.card("medium later", "medium", p.id);
    const r = await t.runtime.tickOnce();
    expect(keys(r)).toEqual(["DEMO-3", "DEMO-2"]);
    expect(r.deferred["DEMO-4"]).toMatch(/全局并发上限/);
    expect(t.events("scheduler.admitted").map((e) => e.cardId)).toHaveLength(2);
  });

  it("measures time in todo from the move, not from creation", async () => {
    const t = setup({ settings: { globalLimit: 1 } });
    const p = t.preset("claude");
    const a = t.card("a", "medium", p.id);
    const b = t.card("b", "medium", p.id);
    // a is bounced out of todo and back: it now queues behind b.
    t.store.cards.move(a.id, { to: "draft", actor: "user" });
    t.clock.advance(1000);
    t.store.cards.move(a.id, { to: "todo", actor: "user" });
    expect(keys(await t.runtime.tickOnce())).toEqual([b.key]);
  });

  it("does not re-admit while pending and frees the slot once dispatched work ends", async () => {
    const t = setup({ settings: { globalLimit: 1 } });
    const p = t.preset("claude");
    const a = t.card("a", "high", p.id);
    t.card("b", "high", p.id);
    expect(keys(await t.runtime.tickOnce())).toEqual([a.key]);
    expect(keys(await t.runtime.tickOnce())).toEqual([]); // a still pending
    const { session } = t.store.cards.dispatch({ cardId: a.id, agentId: "ag1", provider: "claude", worktree: null, presetId: p.id });
    expect(keys(await t.runtime.tickOnce())).toEqual([]); // a now counts as a running session
    t.store.sessions.setState(session.id, "ended");
    expect(keys(await t.runtime.tickOnce())).toEqual(["DEMO-2"]);
  });

  it("takes the smallest of global, provider and project limits", async () => {
    expect(effectiveLimit({ globalLimit: 4, providerLimits: { codex: 2 } }, "codex", 3)).toBe(2);
    expect(effectiveLimit({ globalLimit: 4, providerLimits: { codex: 2 } }, "codex", 1)).toBe(1);
    expect(effectiveLimit({ globalLimit: 4, providerLimits: {} }, "claude", null)).toBe(4);

    const t = setup({ settings: { globalLimit: 5, providerLimits: { codex: 1 } } });
    const codex = t.preset("codex");
    const claude = t.preset("claude");
    t.card("c1", "high", codex.id);
    t.card("c2", "high", codex.id);
    t.card("k1", "low", claude.id);
    const r = await t.runtime.tickOnce();
    expect(keys(r)).toEqual(["DEMO-1", "DEMO-3"]);
    expect(r.deferred["DEMO-2"]).toMatch(/codex 已达并发上限 1/);
    t.store.projects.update(t.project.id, { concurrencyLimit: 2 });
    t.card("k2", "low", claude.id);
    expect(t.runtime.scheduler.status().deferred).toBeDefined();
    expect(keys(await t.runtime.tickOnce())).toEqual([]); // project cap 2 reached
  });
});

describe("quota-aware admission", () => {
  it("when quota is tight, high priority gets the strong provider first and low waits", async () => {
    const t = setup({ usage: usage(["claude", 80]) }); // 20% left <= tight 25%
    const claude = t.preset("claude");
    t.card("low", "low", claude.id);
    t.card("high", "high", claude.id);
    const r = await t.runtime.tickOnce();
    expect(keys(r)).toEqual(["DEMO-2"]);
    expect(r.deferred["DEMO-1"]).toMatch(/额度紧张/);
    expect(t.events("scheduler.quota_low")).toEqual([
      expect.objectContaining({ provider: "claude", level: "tight", remainingPct: 20 }),
    ]);
    await t.runtime.tickOnce();
    expect(t.events("scheduler.quota_low")).toHaveLength(1); // announced once per change
  });

  it("exhausted quota admits nobody and tells the master once, then recovers after reset", async () => {
    const t = setup({ usage: usage(["claude", 98]) });
    const claude = t.preset("claude");
    const codex = t.preset("codex");
    t.card("urgent", "urgent", claude.id);
    t.card("other", "low", codex.id);
    const r = await t.runtime.tickOnce();
    expect(keys(r)).toEqual(["DEMO-2"]);
    expect(r.deferred["DEMO-1"]).toMatch(/额度已用完/);
    expect(t.events("scheduler.quota_low")[0]).toMatchObject({ level: "exhausted" });
    t.state.usage = usage(["claude", 10]);
    t.clock.advance(120_000);
    expect(keys(await t.runtime.tickOnce())).toEqual(["DEMO-1"]);
  });

  it("unknown quota never blocks", async () => {
    const t = setup({ usage: usage(["claude", null]) });
    t.card("x", "low", t.preset("claude").id);
    expect(keys(await t.runtime.tickOnce())).toEqual(["DEMO-1"]);
  });
});

describe("memory gate", () => {
  it("pauses admissions above the threshold, names the heaviest sessions, resumes with hysteresis", async () => {
    const t = setup();
    const p = t.preset("claude");
    const running = t.card("running", "high", p.id);
    const { session } = t.store.cards.dispatch({ cardId: running.id, agentId: "ag1", provider: "claude", worktree: "/wt/demo-1", presetId: p.id });
    t.machine.procs = [
      { pid: 10, ppid: 1, name: "node", cmd: "node server /wt/demo-1/app", rssBytes: 3e9, cpuMs: 0 },
      { pid: 11, ppid: 10, name: "chrome", cmd: "chrome", rssBytes: 1e9, cpuMs: 0 },
    ];
    t.machine.memUsed = 0.92;
    await t.runtime.sampleNow();
    t.card("waiting", "urgent", p.id);
    const r = await t.runtime.tickOnce();
    expect(r.paused).toBe(true);
    expect(r.admitted).toEqual([]);
    expect(t.runtime.scheduler.canStartEmulator()).toBe(false);
    expect(t.events("scheduler.paused")).toEqual([
      expect.objectContaining({
        reason: "memory",
        top: [expect.objectContaining({ sessionId: session.id, cardKey: running.key, memBytes: 4e9 })],
      }),
    ]);
    // Just under the threshold is still paused (hysteresis), clearly under resumes.
    t.machine.memUsed = 0.83;
    await t.runtime.sampleNow();
    expect((await t.runtime.tickOnce()).paused).toBe(true);
    t.machine.memUsed = 0.5;
    await t.runtime.sampleNow();
    const after = await t.runtime.tickOnce();
    expect(after.paused).toBe(false);
    expect(keys(after)).toEqual(["DEMO-2"]);
    expect(t.events("scheduler.resumed")).toHaveLength(1);
  });
});

describe("device pool and ports", () => {
  it("serialises cards that need the one emulator and reuses the lease across ticks", async () => {
    const t = setup();
    t.runtime.leases.registerDevice({ kind: "emulator", name: "emu-1", meta: { serial: "emulator-5554" } });
    const p = t.preset("claude", "android-emulator");
    t.card("a", "high", p.id);
    t.card("b", "high", p.id);
    const r = await t.runtime.tickOnce();
    expect(keys(r)).toEqual(["DEMO-1"]);
    expect(r.deferred["DEMO-2"]).toBe("没有空闲的 emulator 设备");
    expect(t.runtime.leases.poolStatus()).toMatchObject({ busy: 1, total: 1 });
    expect(keys(await t.runtime.tickOnce())).toEqual([]);
    // Card 1 leaves the board's active columns: lease is released and b gets the device.
    t.store.cards.move(t.store.cards.get("DEMO-1")!.id, { to: "draft", actor: "user" });
    expect(keys(await t.runtime.tickOnce())).toEqual(["DEMO-2"]);
  });

  it("ignores the device pool when no device of that kind is registered", async () => {
    const t = setup();
    t.card("a", "high", t.preset("claude", "android-emulator").id);
    expect(keys(await t.runtime.tickOnce())).toEqual(["DEMO-1"]);
    expect(deviceKindFor("web-dev-server")).toBeNull();
    expect(deviceKindFor("ios-simulator")).toBe("simulator");
  });

  it("gives every admitted card its own dev-server port and frees it with the card", async () => {
    const t = setup();
    const p = t.preset("claude");
    const a = t.card("a", "high", p.id);
    t.card("b", "high", p.id);
    const r = await t.runtime.tickOnce();
    const ports = r.admitted.map((x) => x.port);
    expect(new Set(ports).size).toBe(2);
    expect(t.events("scheduler.admitted")[0]).toMatchObject({ port: ports[0] });
    t.store.cards.move(a.id, { to: "draft", actor: "user" });
    await t.runtime.tickOnce();
    expect(t.runtime.ports.get(a.id)).toBeUndefined();
    expect(t.runtime.ports.get(r.admitted[1]!.cardId)).toBe(ports[1]);
  });
});

describe("dispatch failures", () => {
  it("frees the slot, backs off, and retries after the cooldown", async () => {
    const t = setup({ settings: { globalLimit: 1, retryCooldownSeconds: 60 } });
    const a = t.card("a", "high", t.preset("claude").id);
    expect(keys(await t.runtime.tickOnce())).toEqual([a.key]);
    publishEvent(t.db, { type: "scheduler.dispatch_failed", cardId: a.id, payload: { cardId: a.id, message: "no daemon" } }, t.clock.now);
    const r = await t.runtime.tickOnce();
    expect(r.admitted).toEqual([]);
    expect(r.deferred[a.key]).toMatch(/冷却/);
    t.clock.advance(61_000);
    expect(keys(await t.runtime.tickOnce())).toEqual([a.key]);
    expect(t.events("scheduler.admitted")).toHaveLength(2);
  });

  it("releases a pending admission nobody dispatched", async () => {
    const t = setup({ settings: { globalLimit: 1, retryCooldownSeconds: 1 } });
    const a = t.card("a", "high", t.preset("claude").id);
    await t.runtime.tickOnce();
    t.clock.advance(6 * 60_000);
    expect(keys(await t.runtime.tickOnce())).toEqual([]); // timed out: slot freed, short cooldown
    t.clock.advance(2000);
    expect(keys(await t.runtime.tickOnce())).toEqual([a.key]);
  });

  it("the pending timeout is a setting (default 5 minutes)", async () => {
    expect(schedulerSettings.schema.parse({})).toMatchObject({
      pendingTimeoutMinutes: DEFAULT_CONFIG.pendingTimeoutMinutes,
      retryCooldownSeconds: DEFAULT_CONFIG.retryCooldownSeconds,
      maxAdmitAttempts: DEFAULT_CONFIG.maxAdmitAttempts,
    });
    expect(DEFAULT_CONFIG.pendingTimeoutMinutes).toBe(5);
    const t = setup({ settings: { globalLimit: 1, retryCooldownSeconds: 1, pendingTimeoutMinutes: 30 } });
    const a = t.card("a", "high", t.preset("claude").id);
    await t.runtime.tickOnce();
    t.clock.advance(20 * 60_000); // past the old 5 minutes, inside the configured 30
    expect(keys(await t.runtime.tickOnce())).toEqual([]);
    expect(t.runtime.scheduler.status()).toMatchObject({ pending: [{ cardKey: a.key }] });
    t.clock.advance(11 * 60_000); // now past 30 minutes: released
    expect(keys(await t.runtime.tickOnce())).toEqual([]);
    t.clock.advance(2000);
    expect(keys(await t.runtime.tickOnce())).toEqual([a.key]);
  });

  it("admits a card that only has the master agent's recommended preset", async () => {
    const t = setup();
    const p = t.preset("claude");
    t.clock.advance(1);
    t.store.cards.create({ projectId: t.project.id, title: "recommended", column: "todo", suggestedPresetId: p.id });
    const r = await t.runtime.tickOnce();
    expect(keys(r)).toEqual(["DEMO-1"]);
    expect(r.admitted[0]).toMatchObject({ presetId: p.id });
  });

  it("skips cards without any preset", async () => {
    const t = setup();
    t.clock.advance(1);
    t.store.cards.create({ projectId: t.project.id, title: "bare", column: "todo" });
    const r = await t.runtime.tickOnce();
    expect(r.admitted).toEqual([]);
    expect(r.deferred["DEMO-1"]).toMatch(/没有执行预设/);
  });
});

describe("resource_sample", () => {
  it("writes the vibe-stats contract: cpu/mem fractions, per-session keys, device pool", async () => {
    const t = setup();
    t.runtime.leases.registerDevice({ kind: "emulator", name: "emu-1" });
    await t.runtime.sampleNow();
    t.clock.advance(15_000);
    t.machine.memUsed = 0.4;
    await t.runtime.sampleNow();
    const rows = t.db
      .prepare<{ cpu: number; mem: number; per_session_json: string; device_pool_json: string }>(
        "SELECT * FROM resource_sample ORDER BY id",
      )
      .all();
    expect(rows).toHaveLength(2);
    expect(rows[1]!.mem).toBeCloseTo(0.4);
    expect(rows[1]!.cpu).toBeGreaterThanOrEqual(0);
    expect(rows[1]!.cpu).toBeLessThanOrEqual(1);
    const pool = JSON.parse(rows[1]!.device_pool_json);
    expect(pool).toMatchObject({ busy: 0, total: 1, devices: { "emu-1": { leased: false } } });
  });
});
