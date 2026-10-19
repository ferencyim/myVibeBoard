import { describe, expect, it } from "vitest";
import { computeOverview, detectCompactions, percentile, periodStart, readPool } from "../server/aggregate";
import { createIndexer } from "../server/indexer";
import { estimateCost, parseLiteLlmPrices, priceFor } from "../server/pricing";
import { buildSessionMap } from "../server/session-map";
import { migrateOwner, openVibeDb, createVibeStore } from "../server/vibe/db";
import { CLAUDE_FIXTURE, claudeLine, lines, openTestDb, rootsFor, tempDir, write } from "./helpers";
import { join } from "node:path";

describe("percentile and speed", () => {
  it("uses nearest rank", () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
  });

  it("reports median and P90 tokens/s from measured turn durations", async () => {
    const base = tempDir();
    const db = openTestDb();
    write(join(base, "claude", "projects", "p", "s.jsonl"), CLAUDE_FIXTURE);
    await createIndexer({ db, roots: () => rootsFor(base) }).scan();
    const { speed, totals, byProvider, byModel } = computeOverview(db, "all");
    // 50/6s = 8.33, 400/10s = 40, 5/5s = 1
    expect(speed.overall.samples).toBe(3);
    expect(speed.overall.median).toBeCloseTo(8.33, 1);
    expect(speed.overall.p90).toBeCloseTo(40, 5);
    expect(byProvider).toHaveLength(1);
    expect(byModel[0]?.label).toBe("claude-sonnet-4-5");
    expect(totals.cost).toBeGreaterThan(0);
  });
});

describe("period filter", () => {
  it("excludes events older than the window", async () => {
    const base = tempDir();
    const db = openTestDb();
    write(join(base, "claude", "projects", "p", "s.jsonl"), CLAUDE_FIXTURE);
    await createIndexer({ db, roots: () => rootsFor(base) }).scan();
    expect(computeOverview(db, "30d", new Date("2026-10-05T00:00:00Z")).totals.events).toBe(3);
    expect(computeOverview(db, "7d", new Date("2026-11-05T00:00:00Z")).totals.events).toBe(0);
    expect(periodStart("all", new Date())).toBeNull();
  });
});

describe("compaction detection", () => {
  it("flags a sharp context drop inside one session", () => {
    const rows = [
      { session_id: "a", card_id: "c1", ctx: 150_000 },
      { session_id: "a", card_id: "c1", ctx: 30_000 },
      { session_id: "a", card_id: "c1", ctx: 40_000 },
      { session_id: "b", card_id: null, ctx: 5_000 },
    ];
    expect(detectCompactions(rows)).toEqual([{ cardId: "c1", before: 150_000, after: 30_000 }]);
  });
});

describe("resources", () => {
  it("reads scheduler samples without owning the table and tolerates its absence", () => {
    const db = openTestDb();
    expect(computeOverview(db, "all").resources.latest).toBeNull();
    migrateOwner(db, "scheduler");
    db.prepare(
      `INSERT INTO resource_sample (ts, cpu, mem, per_session_json, device_pool_json)
       VALUES ('2026-10-01T00:00:00Z', 0.5, 0.25, '{"a":1,"b":2}', '{"emu1":{"leased":true},"emu2":{"leased":false}}')`,
    ).run();
    const r = computeOverview(db, "all").resources;
    expect(r.latest).toMatchObject({ cpu: 0.5, mem: 0.25, sessions: 2, devicesBusy: 1, devicesTotal: 2 });
    expect(r.history).toHaveLength(1);
    expect(readPool('{"busy":2,"total":3}')).toEqual({ busy: 2, total: 3 });
    expect(readPool("garbage")).toEqual({ busy: 0, total: 0 });
  });
});

describe("cards, sessions and tasks", () => {
  it("links CLI sessions to cards and reports per-task efficiency", async () => {
    const base = tempDir();
    const db = openVibeDb({ path: ":memory:" });
    migrateOwner(db, "stats");
    let clock = Date.parse("2026-10-01T10:00:00Z");
    const store = createVibeStore(db, { now: () => new Date(clock) });
    const project = store.projects.create({ name: "Demo", prefix: "DEMO", repoPath: "<repo>", projectType: "web" });
    const card = store.cards.create({ projectId: project.id, title: "Task one" });
    const session = store.sessions.start({ cardId: card.id, agentId: "agent-1", role: "worker", provider: "claude" });
    clock += 1000;
    store.sessions.setState(session.id, "working");
    clock += 60_000;
    store.sessions.setState(session.id, "waiting", { question: "ok?" });
    clock += 120_000;
    store.sessions.setState(session.id, "working");
    clock += 30_000;
    store.sessions.setState(session.id, "ended", { outcome: "done" });

    // A compaction inside the card's session: 150k context, then 30k.
    write(
      join(base, "claude", "projects", "p", "s.jsonl"),
      lines(
        claudeLine("2026-10-01T10:01:00.000Z", "m1", "r1", [100, 10, 149_900, 0]),
        claudeLine("2026-10-01T10:02:00.000Z", "m2", "r2", [100, 10, 29_900, 0]),
      ),
    );
    const indexer = createIndexer({ db, roots: () => rootsFor(base) });
    await indexer.scan();
    expect(computeOverview(db, "all").byProject[0]?.label).toBe("(unlinked)");

    const fakePaseo = {
      agents: {
        list: async () => ({
          entries: [{ agent: { id: "agent-1", persistence: { provider: "claude", sessionId: "sess-claude-1" } } }],
          pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
        }),
      },
    };
    const map = await buildSessionMap(fakePaseo as never, store);
    expect(map.get("sess-claude-1")).toBe(card.id);
    expect(indexer.relink(map)).toBe(2);
    expect(indexer.relink(map)).toBe(0);

    const o = computeOverview(db, "all");
    expect(o.byProject[0]).toMatchObject({ label: "Demo", events: 2 });
    expect(o.tasks).toHaveLength(1);
    expect(o.tasks[0]).toMatchObject({ key: "DEMO-1", tokens: 180_020, waitingMs: 120_000, durationMs: 211_000 });
    expect(o.tasks[0]?.compactions).toEqual([{ before: 150_000, after: 30_000 }]);
    expect(o.compactions).toEqual({ count: 1, avgBefore: 150_000, avgAfter: 30_000 });
  });
});

describe("unpriced models", () => {
  it("has no built-in price for Claude 5 / gpt-6 models but accepts a price file", () => {
    const t = { tokensIn: 1_000_000, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0 };
    for (const m of ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "gpt-6.1-codex"]) {
      expect(estimateCost(m, t)).toBeNull();
    }
    const overrides = parseLiteLlmPrices({ "claude-opus-5-5": { input_cost_per_token: 0.000004 } });
    expect(estimateCost("claude-opus-5-5", t, overrides)).toBeCloseTo(4);
  });

  it("reports the tokens that could not be priced instead of a silent zero cost", async () => {
    const base = tempDir();
    const db = openTestDb();
    const fixture = lines(claudeLine("2026-10-01T10:00:00.000Z", "msg_x", "req_x", [1000, 500, 0, 0], "claude-opus-5-5"));
    write(join(base, "claude", "projects", "p", "s.jsonl"), fixture);
    await createIndexer({ db, roots: () => rootsFor(base) }).scan();
    const { totals, byModel } = computeOverview(db, "all");
    expect(totals.cost).toBe(0);
    expect(totals.unpricedTokens).toBe(1500);
    expect(byModel[0]?.unpricedTokens).toBe(1500);

    // A price file added later prices the old rows on the next full re-scan.
    const prices = parseLiteLlmPrices({ "claude-opus-5-5": { input_cost_per_token: 0.000001, output_cost_per_token: 0.000002 } });
    const indexer = createIndexer({ db, roots: () => rootsFor(base), prices: () => prices });
    indexer.resetCursors();
    await indexer.scan();
    const after = computeOverview(db, "all").totals;
    expect(after.unpricedTokens).toBe(0);
    expect(after.cost).toBeCloseTo(0.002);
  });
});

describe("pricing", () => {
  it("prices known families, returns null for unknown models, honours LiteLLM overrides", () => {
    const t = { tokensIn: 1_000_000, tokensOut: 1_000_000, tokensCacheRead: 0, tokensCacheWrite: 0 };
    expect(estimateCost("claude-sonnet-4-5-20250929", t)).toBeCloseTo(18);
    expect(estimateCost("totally-unknown", t)).toBeNull();
    const overrides = parseLiteLlmPrices({
      "anthropic/claude-sonnet-4-5": { input_cost_per_token: 0.000002, output_cost_per_token: 0.00001 },
    });
    expect(priceFor("claude-sonnet-4-5", overrides)).toMatchObject({ input: 2, output: 10 });
  });
});
