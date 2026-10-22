import { describe, expect, it } from "vitest";
import { publishEvent } from "../server/vibe/db";
import { setup } from "./helpers";

const keys = (r: { admitted: Array<{ cardKey: string }> }) => r.admitted.map((a) => a.cardKey);
const ON = { enabled: true, available: true, reason: "", timeoutSeconds: 60 };

function answer(t: ReturnType<typeof setup>, type: "master.dispatch_chosen" | "master.dispatch_failed", payload: object) {
  publishEvent(t.db, { type, payload } as never, t.clock.now);
}
const noteKinds = (t: ReturnType<typeof setup>, cardId: string) =>
  t.store.events.list(cardId).map((e) => (e.body as { kind?: string }).kind);

describe("master dispatch (WP-109)", () => {
  it("dispatches by the scheduler's rules while the switch is off, without asking the master", async () => {
    const t = setup({ settings: { globalLimit: 1 } });
    const p = t.preset("claude");
    const a = t.card("a", "urgent", p.id);
    t.card("b", "low", p.id);
    expect(keys(await t.runtime.tickOnce())).toEqual([a.key]);
    expect(t.events("scheduler.dispatch_wanted")).toHaveLength(0);
  });

  it("asks once, waits, then admits exactly the cards the master chose, in its order", async () => {
    const t = setup({ settings: { globalLimit: 3 } });
    t.store.masterDispatch.publish(ON);
    const p = t.preset("claude");
    const a = t.card("a", "urgent", p.id);
    const b = t.card("b", "medium", p.id);
    const c = t.card("c", "low", p.id);

    const first = await t.runtime.tickOnce();
    expect(keys(first)).toEqual([]);
    expect(first.deferred[a.key]).toMatch(/等待总 agent/);
    const wanted = t.events("scheduler.dispatch_wanted");
    expect(wanted).toHaveLength(1);
    expect(wanted[0]).toMatchObject({ slots: 3, cardIds: [a.id, b.id, c.id] });
    // still waiting: no second question
    expect(keys(await t.runtime.tickOnce())).toEqual([]);
    expect(t.events("scheduler.dispatch_wanted")).toHaveLength(1);

    answer(t, "master.dispatch_chosen", { requestId: wanted[0]!.requestId, cardIds: [c.id, a.id], reason: "c is a quick win" });
    const second = await t.runtime.tickOnce();
    expect(keys(second)).toEqual([c.key, a.key]);
    expect(second.deferred[b.key]).toMatch(/没有选/);
    expect(noteKinds(t, c.id)).toContain("dispatch_by_master");
    expect(noteKinds(t, b.id)).not.toContain("dispatch_by_master");
  });

  it("cannot exceed the scheduler's slots or checks: extra picks are held back", async () => {
    const t = setup({ settings: { globalLimit: 1 } });
    t.store.masterDispatch.publish(ON);
    const p = t.preset("claude");
    const a = t.card("a", "high", p.id);
    const b = t.card("b", "high", p.id);
    await t.runtime.tickOnce();
    const id = t.events("scheduler.dispatch_wanted")[0]!.requestId;
    expect(t.events("scheduler.dispatch_wanted")[0]).toMatchObject({ slots: 1 });
    answer(t, "master.dispatch_chosen", { requestId: id, cardIds: [b.id, a.id], reason: "" });
    const r = await t.runtime.tickOnce();
    expect(keys(r)).toEqual([b.key]);
    expect(r.deferred[a.key]).toMatch(/全局并发上限/);
  });

  it("never asks when no card can start, and ignores answers to an old request", async () => {
    const t = setup({ settings: { globalLimit: 1 } });
    t.store.masterDispatch.publish(ON);
    const p = t.preset("claude");
    const a = t.card("a", "high", p.id);
    t.store.cards.dispatch({ cardId: t.card("busy", "high", p.id).id, agentId: "w", provider: "claude", worktree: null, presetId: p.id });
    await t.runtime.tickOnce();
    expect(t.events("scheduler.dispatch_wanted")).toHaveLength(0);
    answer(t, "master.dispatch_chosen", { requestId: "stale", cardIds: [a.id], reason: "" });
    expect(keys(await t.runtime.tickOnce())).toEqual([]);
  });

  it("falls back to the rules and says why on the card when the master fails", async () => {
    const t = setup({ settings: { globalLimit: 1 } });
    t.store.masterDispatch.publish(ON);
    const p = t.preset("claude");
    const a = t.card("a", "urgent", p.id);
    t.card("b", "low", p.id);
    await t.runtime.tickOnce();
    answer(t, "master.dispatch_failed", {
      requestId: t.events("scheduler.dispatch_wanted")[0]!.requestId,
      reason: "额度已用完",
    });
    expect(keys(await t.runtime.tickOnce())).toEqual([a.key]);
    const note = t.store.events.list(a.id).find((e) => (e.body as { kind?: string }).kind === "dispatch_fallback");
    expect((note!.body as { text: string }).text).toContain("额度已用完");
    // the back-off window: no new question right away
    expect(t.events("scheduler.dispatch_wanted")).toHaveLength(1);
  });

  it("falls back when the master does not answer in time", async () => {
    const t = setup({ settings: { globalLimit: 1 } });
    t.store.masterDispatch.publish({ ...ON, timeoutSeconds: 10 });
    const p = t.preset("claude");
    const a = t.card("a", "high", p.id);
    await t.runtime.tickOnce();
    t.clock.advance(41_000);
    expect(keys(await t.runtime.tickOnce())).toEqual([a.key]);
    expect(noteKinds(t, a.id)).toContain("dispatch_fallback");
  });

  it("uses the rules with the published reason while the master is unavailable (no preset chosen)", async () => {
    const t = setup({ settings: { globalLimit: 1 } });
    t.store.masterDispatch.publish({ ...ON, available: false, reason: "未选择总 agent 预设" });
    const p = t.preset("claude");
    const a = t.card("a", "high", p.id);
    expect(keys(await t.runtime.tickOnce())).toEqual([a.key]);
    expect(t.events("scheduler.dispatch_wanted")).toHaveLength(0);
    const note = t.store.events.list(a.id).find((e) => (e.body as { kind?: string }).kind === "dispatch_fallback");
    expect((note!.body as { text: string }).text).toContain("未选择总 agent 预设");
  });

  it("rules take over for a while when the master's pick passes no check", async () => {
    const t = setup({ settings: { globalLimit: 2 } });
    t.store.masterDispatch.publish(ON);
    const p = t.preset("claude");
    const a = t.card("a", "high", p.id);
    await t.runtime.tickOnce();
    answer(t, "master.dispatch_chosen", { requestId: t.events("scheduler.dispatch_wanted")[0]!.requestId, cardIds: ["gone"], reason: "" });
    expect(keys(await t.runtime.tickOnce())).toEqual([]);
    expect(keys(await t.runtime.tickOnce())).toEqual([a.key]);
  });
});
