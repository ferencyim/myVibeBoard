import { describe, expect, it } from "vitest";
import { createMasterRuntime } from "../server/runtime";
import {
  ManualClock,
  defaultSettings,
  fakePaseo,
  setupBoard,
  tempDir,
  tick,
  type Script,
} from "./helpers";

function build(script: Script, over: Parameters<typeof defaultSettings>[0] = {}) {
  const board = setupBoard();
  const fake = fakePaseo(script);
  const settings = defaultSettings(over);
  const runtime = createMasterRuntime({
    admitMaster: async () => async () => undefined,
    admitMemory: async () => async () => undefined,
    db: board.db,
    store: board.store,
    getPaseo: () => fake.paseo,
    settings: () => settings,
    dataDir: tempDir(),
    clock: new ManualClock(),
    pollIntervalMs: 3_600_000,
    log: () => undefined,
  });
  const cards = ["alpha", "beta", "gamma"].map((title) => {
    const card = board.draft(title);
    board.store.cards.move(card.id, { to: "todo", actor: "user" });
    return board.store.cards.get(card.id)!;
  });
  return { board, fake, settings, runtime, cards };
}

type Built = ReturnType<typeof build>;
const FENCE = "```";
const reply = (order: string[], reason = "because") =>
  `${FENCE}json\n${JSON.stringify({ order, reason })}\n${FENCE}`;

const answers = (t: Built) =>
  t.board.db
    .prepare<{ type: string; payload_json: string }>(
      "SELECT type, payload_json FROM vibe_event WHERE type IN ('master.dispatch_chosen','master.dispatch_failed') ORDER BY seq",
    )
    .all()
    .map((r) =>
      Object.assign({ type: r.type }, JSON.parse(r.payload_json) as Record<string, unknown>),
    );

/** Historical card dispatcher remains readable until WP-114; it is no longer wired to runtime events. */
async function ask(t: Built, slots: number, cardIds = t.cards.map((c) => c.id), requestId = "r1") {
  await t.runtime.dispatcher.handle({ requestId, slots, cardIds });
  for (let i = 0; i < 100 && answers(t).length === 0; i++) await tick(10);
  return answers(t);
}

describe("master dispatch", () => {
  it("answers a dispatch request with the cards it picked, in its order", async () => {
    const t = build(({ prompt }) =>
      prompt.includes("[dispatch]") ? reply(["demo-3", "DEMO-1"], "gamma first") : "ok",
    );
    const [first] = await ask(t, 2);
    expect(first).toMatchObject({
      type: "master.dispatch_chosen",
      requestId: "r1",
      cardIds: [t.cards[2]!.id, t.cards[0]!.id],
      reason: "gamma first",
    });
    // the prompt carries the slots, every candidate and the rules it must weigh
    const prompt = t.fake.agents[0]!.prompts[0]!;
    expect(prompt).toContain("2 个空位");
    for (const card of t.cards) expect(prompt).toContain(card.key);
    expect(prompt).toContain("只回复一个");
    await t.runtime.dispose();
  });

  it("never picks more than the slots, cards it was not offered, or the same card twice", async () => {
    const t = build(() => reply(["DEMO-2", "DEMO-2", "DEMO-9", "DEMO-1", "DEMO-3"]));
    const [first] = await ask(t, 2, [t.cards[0]!.id, t.cards[1]!.id]);
    expect(first).toMatchObject({
      type: "master.dispatch_chosen",
      cardIds: [t.cards[1]!.id, t.cards[0]!.id],
    });
    await t.runtime.dispose();
  });

  it("asks once to repair an unreadable reply, then reports a failure", async () => {
    let calls = 0;
    const t = build(() => (++calls === 1 ? "no json at all" : reply(["DEMO-1"])));
    expect((await ask(t, 1))[0]).toMatchObject({
      type: "master.dispatch_chosen",
      cardIds: [t.cards[0]!.id],
    });
    await t.runtime.dispose();

    const bad = build(() => "never json");
    const [failed] = await ask(bad, 1);
    expect(failed).toMatchObject({ type: "master.dispatch_failed", requestId: "r1" });
    expect(String(failed!.reason)).toContain("回复格式不对");
    await bad.runtime.dispose();
  });

  it("fails with a reason the scheduler can show when the master cannot answer", async () => {
    const quota = build(() => ({
      status: "error",
      lastMessage: null,
      error: "Claude usage limit reached. Your limit resets at 5pm.",
    }));
    expect(String((await ask(quota, 1))[0]!.reason)).toContain("额度已用完");
    const timeout = build(() => ({ status: "timeout", lastMessage: null, error: null }));
    expect(String((await ask(timeout, 1))[0]!.reason)).toContain("没有及时回复");
    const noPreset = build(() => reply(["DEMO-1"]), { provider: "" });
    expect(String((await ask(noPreset, 1))[0]!.reason)).toContain("没有为总 agent 选择预设");
    const off = build(() => reply(["DEMO-1"]), { dispatch: false });
    expect(String((await ask(off, 1))[0]!.reason)).toContain("已关闭");
    for (const t of [quota, timeout, noPreset, off]) await t.runtime.dispose();
  });

  it("fails when the candidates left the todo column", async () => {
    const t = build(() => reply(["DEMO-1"]));
    t.board.store.cards.move(t.cards[0]!.id, { to: "draft", actor: "user" });
    const [failed] = await ask(t, 1, [t.cards[0]!.id]);
    expect(failed).toMatchObject({ type: "master.dispatch_failed" });
    await t.runtime.dispose();
  });

  it("uses the prompt registry: the owner's override reaches the master", async () => {
    const t = build(() => reply(["DEMO-1"]));
    t.board.store.prompts.setOverride("master.dispatch", "CUSTOM {{slots}}\n{{candidates}}");
    await ask(t, 1);
    const prompt = t.fake.agents[0]!.prompts[0]!;
    expect(prompt.startsWith("CUSTOM 1\n")).toBe(true);
    expect(prompt.endsWith("编号必须来自候选待办卡。")).toBe(true);
    await t.runtime.dispose();
  });
});

describe("dispatch mode published to the scheduler", () => {
  it("says whether the master can dispatch and why not", async () => {
    const on = build(() => "ok");
    expect(on.board.store.masterDispatch.get()).toMatchObject({
      enabled: true,
      available: true,
      reason: "",
    });
    const none = build(() => "ok", { provider: "" });
    expect(none.board.store.masterDispatch.get()).toMatchObject({
      enabled: true,
      available: false,
    });
    expect(none.board.store.masterDispatch.get().reason).toContain("预设");
    const off = build(() => "ok", { dispatch: false });
    expect(off.board.store.masterDispatch.get().enabled).toBe(false);

    on.settings.dispatch = false;
    on.settings.dispatchTimeoutSeconds = 30;
    await on.runtime.onSettingsChanged();
    expect(on.board.store.masterDispatch.get()).toMatchObject({
      enabled: false,
      timeoutSeconds: 30,
    });
    for (const t of [on, none, off]) await t.runtime.dispose();
  });
});
