import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyComplexity,
  DEFAULT_THRESHOLDS,
  queryTurnUsage,
  type ComplexitySettingsValues,
  type TurnUsage,
} from "../server/complexity";
import {
  createCompactionScheduler,
  skipReason,
  type AgentInfo,
  type CompactionConfig,
  type CompactionHost,
} from "../server/compaction";
import { createVibeStore, migrateOwner, openVibeDb, readEvents } from "../server/vibe/db";

const turn = (cacheRead = 1000, tokensIn = 100): TurnUsage => ({
  tokensIn,
  tokensOut: 50,
  cacheRead,
  cacheWrite: 0,
});
const turns = (n: number, t: TurnUsage = turn()) => Array.from({ length: n }, () => t);

describe("classifyComplexity", () => {
  it("splits by turn count: 1-3 short, 4-14 multi, 15+ long", () => {
    expect(classifyComplexity([])).toBe("short");
    expect(classifyComplexity(turns(1))).toBe("short");
    expect(classifyComplexity(turns(3))).toBe("short");
    expect(classifyComplexity(turns(4))).toBe("multi");
    expect(classifyComplexity(turns(14))).toBe("multi");
    expect(classifyComplexity(turns(15))).toBe("long");
  });

  it("ignores all-zero rows", () => {
    const zero = { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0 };
    expect(classifyComplexity([...turns(3), ...turns(20, zero)])).toBe("short");
  });

  it("accumulated cacheRead >= 1,000,000 is long, 999,999 is not", () => {
    const nine = turns(9, turn(100_000));
    expect(classifyComplexity([...nine, turn(99_999)])).toBe("multi");
    expect(classifyComplexity([...nine, turn(100_000)])).toBe("long");
  });

  it("25% heavy turns (context >= 177,047) is long, below is not", () => {
    const heavy = turn(0, 177_047);
    const light = turn(100, 100);
    // 1 of 5 = 20%: multi; 2 of 8 = 25%: long; a context of 177,046 is not heavy.
    expect(classifyComplexity([heavy, ...turns(4, light)])).toBe("multi");
    expect(classifyComplexity([heavy, heavy, ...turns(6, light)])).toBe("long");
    expect(classifyComplexity([turn(0, 177_046), ...turns(4, light)])).toBe("multi");
    // A single bloated turn already makes a short chat long.
    expect(classifyComplexity([heavy])).toBe("long");
  });

  it("counts cacheWrite into the turn context", () => {
    expect(
      classifyComplexity([{ tokensIn: 1, tokensOut: 1, cacheRead: 0, cacheWrite: 177_046 }]),
    ).toBe("long");
  });

  it("thresholds are adjustable", () => {
    expect(classifyComplexity(turns(2), { ...DEFAULT_THRESHOLDS, longMinTurns: 2 })).toBe("long");
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

function setup(provider = "codex", cx: Partial<ComplexitySettingsValues> = {}) {
  let t = T0;
  const clock = { advance: (s: number) => void (t += s * 1000) };
  const db = openVibeDb({ path: ":memory:" });
  migrateOwner(db, "core");
  migrateOwner(db, "stats"); // normally vibe-stats creates usage_event
  const store = createVibeStore(db, { now: () => new Date(t) });
  const project = store.projects.create({ name: "Demo", prefix: "DEMO", repoPath: "" });
  const card = store.cards.create({ projectId: project.id, title: "Work" });
  const agent: AgentInfo = {
    id: "agent-1",
    provider,
    cwd: mkdtempSync(join(tmpdir(), "vibe-cx-")),
  };
  const session = store.sessions.start({
    cardId: card.id,
    agentId: agent.id,
    role: "worker",
    provider,
  });
  store.sessions.setState(session.id, "working");
  store.sessions.setState(session.id, "idle");
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
    buildContext: (_cwd, budget) => {
      budgets.push(budget);
      return "CTX";
    },
    now: () => t,
    settleMs: 0,
    pollMs: 0,
  });
  scheduler.onTurnEnded(agent); // cache expires T0 + 300 s
  let n = 0;
  const addUsage = (
    count: number,
    over: Partial<{ in: number; read: number; id: string }> = {},
  ) => {
    // Rows land 1 ms after "now", so they count after a baseline set at "now".
    for (let i = 0; i < count; i++) {
      db.prepare(
        `INSERT INTO usage_event (ts, provider, model, session_id, tokens_in, tokens_out,
           tokens_cache_read, tokens_cache_write, dedupe_key) VALUES (?, 'codex', 'm', ?, ?, 10, ?, 0, ?)`,
      ).run(
        new Date(t + 1).toISOString(),
        over.id ?? "cli-1",
        over.in ?? 100,
        over.read ?? 1000,
        `k${n++}`,
      );
    }
  };
  const nextPeriod = () => {
    scheduler.onTurnStarted(agent);
    scheduler.onTurnEnded(agent);
    clock.advance(1);
  };
  const events = () =>
    store.events
      .list(card.id)
      .filter((e) => e.type === "compaction")
      .map((e) => e.body);
  return {
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
    nextPeriod,
    events,
  };
}

describe("usage query (integration with usage_event)", () => {
  it("reads the rows of the given CLI sessions only, optionally after a timestamp", () => {
    const s = setup();
    s.addUsage(2);
    s.addUsage(3, { id: "other" });
    expect(queryTurnUsage(s.db, ["cli-1"])).toHaveLength(2);
    expect(queryTurnUsage(s.db, ["cli-1", "other"])).toHaveLength(5);
    expect(queryTurnUsage(s.db, [])).toEqual([]);
    expect(queryTurnUsage(s.db, ["cli-1"], new Date(T0 + 1).toISOString())).toHaveLength(0);
    // Missing table (vibe-stats not migrated) means no data, not an error.
    const bare = openVibeDb({ path: ":memory:" });
    expect(queryTurnUsage(bare, ["cli-1"])).toEqual([]);
  });
});

describe("complexity policy in the scheduler", () => {
  it("records the classification on the session, and the change as an event", async () => {
    const s = setup();
    s.addUsage(5);
    await s.scheduler.tick();
    expect(s.store.sessions.get(s.session.id)?.complexity).toBe("multi");
    const changed = readEvents(s.db, 0, { types: ["session.complexity_changed"] });
    expect(changed.map((e) => e.payload)).toMatchObject([
      { sessionId: s.session.id, from: null, to: "multi" },
    ]);
  });

  it("short: nothing extra happens while the cache is hot", async () => {
    const s = setup();
    s.addUsage(2);
    s.clock.advance(10);
    expect((await s.scheduler.tick())[0]).toMatchObject({ action: "skipped", reason: "cache-hot" });
    expect(s.store.sessions.get(s.session.id)?.complexity).toBe("short");
    expect(s.prompts).toEqual([]);
  });

  it("multi: normal timing, but re-injection uses the tight memory budget", async () => {
    const s = setup();
    s.addUsage(6);
    s.clock.advance(10);
    expect((await s.scheduler.tick())[0]).toMatchObject({ reason: "cache-hot" });
    s.clock.advance(240); // inside the margin
    expect((await s.scheduler.tick())[0]).toMatchObject({ action: "compact" });
    expect(s.budgets).toEqual([100]);
  });

  it("short sessions keep the default budget", async () => {
    const s = setup();
    s.addUsage(2);
    s.clock.advance(250);
    await s.scheduler.tick();
    expect(s.budgets).toEqual([undefined]);
  });

  it("long (15 turns): compacts at the next idle tick although the cache is hot, once", async () => {
    const s = setup();
    s.addUsage(15);
    s.clock.advance(10);
    expect(await s.scheduler.tick()).toEqual([{ sessionId: s.session.id, action: "compact" }]);
    expect(s.prompts[1]).toBe("/compact");
    expect(s.events()).toEqual([{ sessionId: s.session.id, strategy: "compact" }]);
    expect(s.budgets).toEqual([100]);
    s.clock.advance(5);
    expect((await s.scheduler.tick())[0]).toMatchObject({ reason: "already-compacted" });
    // Usage before the compaction no longer counts: the session is short again.
    expect(s.store.sessions.get(s.session.id)?.complexity).toBe("short");
  });

  it("long by cacheRead and by heavy-turn share", async () => {
    const a = setup();
    a.addUsage(2, { read: 600_000 });
    a.clock.advance(10);
    expect((await a.scheduler.tick())[0]).toMatchObject({ action: "compact" });

    const b = setup();
    b.addUsage(1, { in: 200_000, read: 0 });
    b.addUsage(3);
    b.clock.advance(10);
    expect((await b.scheduler.tick())[0]).toMatchObject({ action: "compact" });
  });

  it("still long after repeated compactions: hands over to a new session", async () => {
    const s = setup(); // handoffAfterCompactions = 2
    for (const expected of ["compact", "compact", "handoff"]) {
      s.addUsage(15);
      s.clock.advance(10);
      expect((await s.scheduler.tick())[0]).toMatchObject({ action: expected });
      s.nextPeriod();
    }
    expect(s.handoffs).toHaveLength(1);
    expect(s.handoffs[0]).toContain("CTX");
    expect(s.store.sessions.get(s.session.id)?.state).toBe("ended");
    expect(s.store.sessions.getByAgent("agent-1-next")?.cardId).toBe(s.card.id);
    expect(s.events().at(-1)).toEqual({ sessionId: s.session.id, strategy: "handoff" });
  });

  it("a provider without /compact is handed over on the first long tick", async () => {
    const s = setup("kimi");
    s.addUsage(15);
    s.clock.advance(10);
    expect((await s.scheduler.tick())[0]).toMatchObject({ action: "handoff" });
    expect(s.handoffs).toHaveLength(1);
  });

  it("switches: complexity.enabled=false and earlyCompactLong=false", async () => {
    const off = setup("codex", { enabled: false });
    off.addUsage(15);
    off.clock.advance(10);
    expect((await off.scheduler.tick())[0]).toMatchObject({ reason: "cache-hot" });
    expect(off.store.sessions.get(off.session.id)?.complexity).toBeNull();

    const noEarly = setup("codex", { earlyCompactLong: false });
    noEarly.addUsage(15);
    noEarly.clock.advance(10);
    expect((await noEarly.scheduler.tick())[0]).toMatchObject({ reason: "cache-hot" });
    expect(noEarly.store.sessions.get(noEarly.session.id)?.complexity).toBe("long");
    noEarly.clock.advance(240); // the TTL trigger still works
    expect((await noEarly.scheduler.tick())[0]).toMatchObject({ action: "compact" });
  });

  it("refreshComplexity updates right after a turn", async () => {
    const s = setup();
    s.addUsage(20);
    expect(await s.scheduler.refreshComplexity(s.agent)).toBe("long");
    expect(s.store.sessions.get(s.session.id)?.complexity).toBe("long");
  });
});
