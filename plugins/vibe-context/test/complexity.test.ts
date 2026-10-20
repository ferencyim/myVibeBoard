import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildTurnStats,
  classifyComplexity,
  DEFAULT_THRESHOLDS,
  queryCallUsage,
  readState,
  tightBudgetFor,
  type ComplexitySettingsValues,
  type TurnStats,
} from "../server/complexity";
import {
  createCompactionScheduler,
  skipReason,
  type AgentInfo,
  type CompactionConfig,
  type CompactionHost,
} from "../server/compaction";
import { injectContext } from "../server/inject";
import { createMemoryStore } from "../server/memory";
import { createVibeStore, migrateOwner, openVibeDb, readEvents } from "../server/vibe/db";

const stats = (turns: number, over: Partial<TurnStats> = {}): TurnStats => ({
  turns,
  cacheRead: turns * 1000,
  turnPeaks: Array.from({ length: turns }, () => 1000),
  ...over,
});

describe("classifyComplexity", () => {
  it("splits by turn count: 1-3 short, 4-14 multi, 15+ long", () => {
    expect(classifyComplexity(stats(0))).toBe("short");
    expect(classifyComplexity(stats(1))).toBe("short");
    expect(classifyComplexity(stats(3))).toBe("short");
    expect(classifyComplexity(stats(4))).toBe("multi");
    expect(classifyComplexity(stats(14))).toBe("multi");
    expect(classifyComplexity(stats(15))).toBe("long");
  });

  it("accumulated cacheRead >= 1,000,000 is long, 999,999 is not", () => {
    expect(classifyComplexity(stats(5, { cacheRead: 999_999 }))).toBe("multi");
    expect(classifyComplexity(stats(5, { cacheRead: 1_000_000 }))).toBe("long");
  });

  it("25% heavy turns (peak context >= 177,047) is long, below is not", () => {
    const peaks = (heavy: number, total: number) => [
      ...Array.from({ length: heavy }, () => 177_047),
      ...Array.from({ length: total - heavy }, () => 177_046),
    ];
    expect(classifyComplexity(stats(5, { turnPeaks: peaks(1, 5) }))).toBe("multi"); // 20%
    expect(classifyComplexity(stats(8, { turnPeaks: peaks(2, 8) }))).toBe("long"); // 25%
    expect(classifyComplexity(stats(1, { turnPeaks: peaks(1, 1) }))).toBe("long"); // one bloated turn
    expect(classifyComplexity(stats(2, { turnPeaks: peaks(0, 2) }))).toBe("short");
  });

  it("thresholds are adjustable", () => {
    expect(classifyComplexity(stats(2), { ...DEFAULT_THRESHOLDS, longMinTurns: 2 })).toBe("long");
  });
});

describe("buildTurnStats: calls fold into turns", () => {
  it("30 calls inside one turn are ONE turn; the peak is the max context, cacheRead sums", () => {
    const calls = Array.from({ length: 30 }, (_, i) => ({
      tsMs: 1000 + i * 10,
      context: 1000 + i,
      cacheRead: 500,
    }));
    const s = buildTurnStats([[900, 2000]], calls);
    expect(s).toEqual({ turns: 1, cacheRead: 15_000, turnPeaks: [1029] });
    expect(classifyComplexity(s)).toBe("short");
  });

  it("calls outside every window still add cacheRead but no turn", () => {
    const s = buildTurnStats([[100_000, 101_000]], [{ tsMs: 1, context: 9, cacheRead: 7 }]);
    expect(s).toEqual({ turns: 1, cacheRead: 7, turnPeaks: [0] });
  });
});

describe("skipReason force", () => {
  it("forces past a hot cache, but not past not-idle or an already handled period", () => {
    const base = {
      state: "idle",
      nowMs: 0,
      marginMs: 10,
      cacheExpiresAtMs: 10_000,
      alreadyCompacted: false,
    };
    expect(skipReason(base)).toBe("cache-hot");
    expect(skipReason({ ...base, force: true })).toBeNull();
    expect(skipReason({ ...base, force: true, alreadyCompacted: true })).toBe("already-compacted");
    expect(skipReason({ ...base, force: true, state: "working" })).toBe("not-idle");
  });
});

let dedupeSeq = 0;
const T0 = Date.parse("2026-10-19T10:00:00.000Z");
const cxDefaults: ComplexitySettingsValues = {
  enabled: true,
  shortMaxTurns: 3,
  longMinTurns: 15,
  longCacheRead: 1_000_000,
  heavyTurnContext: 177_047,
  heavyTurnShare: 0.25,
  earlyCompactLong: true,
  handoffAfterCompactions: 2,
  tightMemoryTokens: 100,
};

interface SetupOptions {
  /** Shared db + clock for a "restarted daemon" (a second scheduler on the same data). */
  shared?: ReturnType<typeof setup>;
  systemTurn?: (agentId: string) => boolean;
  onRun?: (text: string, ctx: ReturnType<typeof setup>) => void;
}

function setup(
  provider = "codex",
  cx: Partial<ComplexitySettingsValues> = {},
  opts: SetupOptions = {},
) {
  const shared = opts.shared;
  const time = shared?.time ?? { t: T0 };
  const clock = { advance: (s: number) => void (time.t += s * 1000) };
  const db = shared?.db ?? openVibeDb({ path: ":memory:" });
  if (!shared) {
    migrateOwner(db, "core");
    migrateOwner(db, "stats"); // normally vibe-stats creates usage_event
  }
  const store = shared?.store ?? createVibeStore(db, { now: () => new Date(time.t) });
  const project = shared ? null : store.projects.create({ name: "Demo", prefix: "DEMO", repoPath: "" });
  const card = shared?.card ?? store.cards.create({ projectId: project!.id, title: "Work" });
  const agent: AgentInfo = shared?.agent ?? {
    id: "agent-1",
    provider,
    cwd: mkdtempSync(join(tmpdir(), "vibe-cx-")),
  };
  const session =
    shared?.session ??
    store.sessions.start({ cardId: card.id, agentId: agent.id, role: "worker", provider });
  if (!shared) {
    store.sessions.setState(session.id, "working");
    store.sessions.setState(session.id, "idle");
  }
  store.sessions.touch(session.id, { cacheExpiresAt: new Date(time.t + 300_000).toISOString() });
  const config: CompactionConfig = {
    enabled: true,
    ttlSeconds: {},
    complexity: { ...cxDefaults, ...cx },
  };
  const prompts: string[] = [];
  const handoffs: string[] = [];
  const budgets: (number | undefined)[] = [];
  const host: CompactionHost = {
    async run(_id, text) {
      prompts.push(text);
      opts.onRun?.(text, ctx);
      return { status: "idle" };
    },
    async handoff(a, prompt) {
      handoffs.push(prompt);
      return `${a.id}-next`;
    },
    async archive() {},
    async cliSessionIds() {
      return ["cli-1"];
    },
  };
  const scheduler = createCompactionScheduler({
    store,
    host,
    config: () => config,
    usageDb: db,
    isSystemTurn: opts.systemTurn,
    buildContext: (_cwd, budget) => {
      budgets.push(budget);
      return "CTX";
    },
    now: () => time.t,
    settleMs: 0,
    pollMs: 0,
  });
  let n = (dedupeSeq += 10_000);
  const addUsage = (
    count: number,
    over: Partial<{ in: number; read: number; id: string }> = {},
  ) => {
    for (let i = 0; i < count; i++) {
      db.prepare(
        `INSERT INTO usage_event (ts, provider, model, session_id, tokens_in, tokens_out,
           tokens_cache_read, tokens_cache_write, dedupe_key) VALUES (?, 'codex', 'm', ?, ?, 10, ?, 0, ?)`,
      ).run(
        new Date(time.t).toISOString(),
        over.id ?? "cli-1",
        over.in ?? 100,
        over.read ?? 1000,
        `k${n++}`,
      );
    }
  };
  /** One user turn with `calls` model calls inside it, then the session is idle again. */
  const turn = (calls = 1, over: Partial<{ in: number; read: number }> = {}) => {
    scheduler.onTurnStarted(agent);
    clock.advance(5);
    addUsage(calls, over);
    clock.advance(1);
    scheduler.onTurnEnded(agent);
    clock.advance(1);
  };
  const turns = (count: number, calls = 1, over: Partial<{ in: number; read: number }> = {}) => {
    for (let i = 0; i < count; i++) turn(calls, over);
  };
  const events = () =>
    store.events
      .list(card.id)
      .filter((e) => e.type === "compaction")
      .map((e) => e.body);
  const ctx = {
    time,
    clock,
    store,
    db,
    session,
    card,
    agent,
    scheduler,
    prompts,
    handoffs,
    budgets,
    addUsage,
    turn,
    turns,
    events,
    config,
  };
  return ctx;
}

describe("usage query (integration with usage_event)", () => {
  it("reads the rows of the given CLI sessions only, optionally after a timestamp", () => {
    const s = setup();
    s.addUsage(2);
    s.addUsage(3, { id: "other" });
    expect(queryCallUsage(s.db, ["cli-1"])).toHaveLength(2);
    expect(queryCallUsage(s.db, ["cli-1", "other"])).toHaveLength(5);
    expect(queryCallUsage(s.db, [])).toEqual([]);
    expect(queryCallUsage(s.db, ["cli-1"], new Date(T0 + 60_000).toISOString())).toHaveLength(0);
    // Missing table (vibe-stats not migrated) means no data, not an error.
    const bare = openVibeDb({ path: ":memory:" });
    expect(queryCallUsage(bare, ["cli-1"])).toEqual([]);
  });
});

describe("complexity policy in the scheduler", () => {
  it("30 model calls in one agent turn are one turn: the session stays short", async () => {
    const s = setup();
    s.turn(30);
    s.turn(30);
    s.clock.advance(10);
    expect((await s.scheduler.tick())[0]).toMatchObject({ action: "skipped", reason: "cache-hot" });
    expect(s.store.sessions.get(s.session.id)?.complexity).toBe("short");
    expect(readState(s.db, s.session.id).windows).toHaveLength(2);
    expect(s.prompts).toEqual([]);
  });

  it("records the classification, and the change as an event", async () => {
    const s = setup();
    s.turns(5, 20);
    await s.scheduler.tick();
    expect(s.store.sessions.get(s.session.id)?.complexity).toBe("multi");
    const changed = readEvents(s.db, 0, { types: ["session.complexity_changed"] });
    expect(changed.map((e) => e.payload)).toMatchObject([
      { sessionId: s.session.id, from: null, to: "multi" },
    ]);
  });

  it("multi: normal timing, but re-injection uses the tight memory budget", async () => {
    const s = setup();
    s.turns(6);
    s.clock.advance(10);
    expect((await s.scheduler.tick())[0]).toMatchObject({ reason: "cache-hot" });
    s.store.sessions.touch(s.session.id, {
      cacheExpiresAt: new Date(s.time.t + 30_000).toISOString(),
    });
    expect((await s.scheduler.tick())[0]).toMatchObject({ action: "compact" });
    expect(s.budgets).toEqual([100]);
  });

  it("short sessions keep the default budget", async () => {
    const s = setup();
    s.turns(2);
    s.store.sessions.touch(s.session.id, {
      cacheExpiresAt: new Date(s.time.t + 30_000).toISOString(),
    });
    await s.scheduler.tick();
    expect(s.budgets).toEqual([undefined]);
  });

  it("long (15 turns): compacts at the next idle tick although the cache is hot, once", async () => {
    const s = setup();
    s.turns(14);
    expect((await s.scheduler.tick())[0]).toMatchObject({ reason: "cache-hot" }); // 14 = multi
    s.turn();
    expect(await s.scheduler.tick()).toEqual([{ sessionId: s.session.id, action: "compact" }]);
    expect(s.prompts[1]).toBe("/compact");
    expect(s.events()).toEqual([{ sessionId: s.session.id, strategy: "compact" }]);
    expect(s.budgets).toEqual([100]);
    expect((await s.scheduler.tick())[0]).toMatchObject({ reason: "already-compacted" });
    // The turns before the compaction no longer count: the session is short again.
    expect(s.store.sessions.get(s.session.id)?.complexity).toBe("short");
  });

  it("long by cacheRead, and by heavy turns judged on the max call context of a turn", async () => {
    const a = setup();
    a.turns(2, 5, { read: 150_000 }); // 1.5 M cacheRead, small contexts
    expect((await a.scheduler.tick())[0]).toMatchObject({ action: "compact" });

    const b = setup();
    b.turns(3, 30); // many calls, none big: 90k cacheRead
    b.turn(1, { in: 200_000, read: 0 }); // 1 of 4 turns peaks over 177,047
    expect((await b.scheduler.tick())[0]).toMatchObject({ action: "compact" });

    const c = setup();
    c.turns(4, 30, { read: 80_000 }); // each call 80k: contexts add up per call, not per turn
    expect(classifyComplexity(buildTurnStats(readState(c.db, c.session.id).windows, queryCallUsage(c.db, ["cli-1"])))).toBe("long"); // 9.6 M cacheRead
  });

  it("turns started by the plugin or announced as system turns are not counted", async () => {
    const marked = new Set<string>();
    const s = setup("codex", {}, { systemTurn: (id) => marked.has(id) });
    marked.add(s.agent.id);
    s.turns(20); // e.g. master messages announced via expectSystemTurn
    marked.clear();
    expect(readState(s.db, s.session.id).windows).toHaveLength(0);
    s.turns(2);
    expect(readState(s.db, s.session.id).windows).toHaveLength(2);

    // Our own compaction turns (hooks fire while the flow is busy) do not count either.
    const c = setup("codex", {}, {
      onRun: (_t, x) => {
        x.scheduler.onTurnStarted(x.agent);
        x.scheduler.onTurnEnded(x.agent);
      },
    });
    c.turns(15);
    await c.scheduler.tick();
    expect(c.prompts).toHaveLength(3);
    expect(readState(c.db, c.session.id).windows).toHaveLength(0);
    c.scheduler.onTurnStarted(c.agent);
    c.scheduler.onTurnEnded(c.agent);
    expect(readState(c.db, c.session.id).windows).toHaveLength(1);
  });

  it("still long after repeated compactions: hands over, and the counters survive a restart", async () => {
    let s = setup(); // handoffAfterCompactions = 2
    s.turns(15);
    expect((await s.scheduler.tick())[0]).toMatchObject({ action: "compact" });
    s = setup("codex", {}, { shared: s }); // daemon restarted: fresh scheduler, same vibe.db
    expect(readState(s.db, s.session.id).longCompactions).toBe(1);
    s.turns(15);
    expect((await s.scheduler.tick())[0]).toMatchObject({ action: "compact" });
    s = setup("codex", {}, { shared: s });
    s.turns(15);
    expect(readState(s.db, s.session.id).longCompactions).toBe(2);
    expect((await s.scheduler.tick())[0]).toMatchObject({ action: "handoff" });
    expect(s.handoffs).toHaveLength(1);
    expect(s.handoffs[0]).toContain("CTX");
    expect(s.store.sessions.get(s.session.id)?.state).toBe("ended");
    expect(s.events().at(-1)).toEqual({ sessionId: s.session.id, strategy: "handoff" });

    // The new session inherits "multi" (from long), the early-compaction count and a fresh count.
    const next = s.store.sessions.getByAgent("agent-1-next")!;
    expect(next.cardId).toBe(s.card.id);
    expect(next.complexity).toBe("multi");
    expect(readState(s.db, next.id)).toMatchObject({ windows: [], longCompactions: 3, floor: "multi" });
    // New agents in that directory get the tight budget from the injection hook.
    expect(tightBudgetFor(s.db, s.agent.cwd)).toBe(100);
  });

  it("a provider without /compact is handed over on the first long tick", async () => {
    const s = setup("kimi");
    s.turns(15);
    expect((await s.scheduler.tick())[0]).toMatchObject({ action: "handoff" });
    expect(s.handoffs).toHaveLength(1);
  });

  it("switches: complexity.enabled=false and earlyCompactLong=false", async () => {
    const off = setup("codex", { enabled: false });
    off.turns(15);
    expect((await off.scheduler.tick())[0]).toMatchObject({ reason: "cache-hot" });
    expect(off.store.sessions.get(off.session.id)?.complexity).toBeNull();

    const noEarly = setup("codex", { earlyCompactLong: false });
    noEarly.turns(15);
    expect((await noEarly.scheduler.tick())[0]).toMatchObject({ reason: "cache-hot" });
    expect(noEarly.store.sessions.get(noEarly.session.id)?.complexity).toBe("long");
    noEarly.store.sessions.touch(noEarly.session.id, {
      cacheExpiresAt: new Date(noEarly.time.t + 30_000).toISOString(),
    });
    expect((await noEarly.scheduler.tick())[0]).toMatchObject({ action: "compact" }); // TTL trigger
  });

  it("refreshComplexity updates right after a turn", async () => {
    const s = setup();
    s.turns(20);
    expect(await s.scheduler.refreshComplexity(s.agent)).toBe("long");
    expect(s.store.sessions.get(s.session.id)?.complexity).toBe("long");
    expect(tightBudgetFor(s.db, s.agent.cwd)).toBe(100);
  });
});

describe("agent.create injection budget", () => {
  it("uses the per-directory budget hint for multi/long cards", async () => {
    const base = mkdtempSync(join(tmpdir(), "vibe-cxinj-"));
    const repo = join(base, "repo");
    const home = join(base, "home");
    mkdirSync(repo);
    mkdirSync(home);
    const mem = createMemoryStore({ projectRoot: repo, userHome: home, contextWindowTokens: 100_000 });
    mem.writeProjectState({ role: "master" }, "Phase: M5. The harbor module is half done.");
    writeFileSync(join(repo, ".vibe", "touch"), "");
    const request = { config: { provider: "claude", cwd: repo } };
    const normal = await injectContext(request, { userHome: home });
    expect(normal?.systemPrompt).toContain("harbor module is half done");
    const tight = await injectContext(request, { userHome: home, budgetFor: () => 0 });
    expect(tight?.systemPrompt).not.toContain("harbor module is half done");
    expect(tight?.systemPrompt).toContain("too large to inline");
    const none = await injectContext(request, { userHome: home, budgetFor: () => undefined });
    expect(none?.systemPrompt).toContain("harbor module is half done");
  });
});
