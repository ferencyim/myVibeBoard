import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareVersions,
  createCompactionScheduler,
  detectNativeIdleCompaction,
  marginSeconds,
  skipReason,
  type AgentInfo,
  type CompactionConfig,
  type CompactionHost,
} from "../server/compaction";
import { createVibeStore, migrateOwner, openVibeDb } from "../server/vibe/db";

const T0 = Date.parse("2026-10-19T10:00:00.000Z");

type RunStatus = Awaited<ReturnType<CompactionHost["run"]>>;
type Ctx = ReturnType<typeof setup>;

interface SetupOptions {
  nativeClaude?: boolean;
  /** Runs inside every host.run (the daemon would fire hooks / the lifecycle would react). */
  onRun?: (text: string, ctx: Ctx) => RunStatus | void;
}

function setup(provider = "codex", opts: SetupOptions = {}) {
  let t = T0;
  const config: CompactionConfig = { enabled: true, ttlSeconds: {} };
  const clock = { now: () => t, advance: (s: number) => void (t += s * 1000) };
  const db = openVibeDb({ path: ":memory:" });
  migrateOwner(db, "core");
  const store = createVibeStore(db, { now: () => new Date(t) });
  const project = store.projects.create({ name: "Demo", prefix: "DEMO", repoPath: "" });
  const card = store.cards.create({ projectId: project.id, title: "Work" });
  const cwd = mkdtempSync(join(tmpdir(), "vibe-cmp-"));
  const agent: AgentInfo = { id: "agent-1", provider, cwd };
  const session = store.sessions.start({
    cardId: card.id,
    agentId: agent.id,
    role: "worker",
    provider,
  });
  store.sessions.setState(session.id, "working");
  store.sessions.setState(session.id, "idle");

  const prompts: string[] = [];
  const handoffs: string[] = [];
  const archived: string[] = [];
  const host: CompactionHost = {
    async run(_id, text) {
      prompts.push(text);
      return opts.onRun?.(text, ctx) ?? { status: "idle" };
    },
    async handoff(a, prompt) {
      handoffs.push(prompt);
      return `${a.id}-next`;
    },
    async archive(id) {
      archived.push(id);
    },
  };
  const scheduler = createCompactionScheduler({
    store,
    host,
    config: () => config,
    buildContext: () => "GOALS+PROJECT_STATE",
    now: clock.now,
    settleMs: 0,
    pollMs: 0,
    nativeClaude: opts.nativeClaude,
  });
  scheduler.onTurnEnded(agent); // round over: cache written, expires T0 + ttl
  const events = () =>
    store.events
      .list(card.id)
      .filter((e) => e.type === "compaction")
      .map((e) => e.body);
  const ctx = {
    clock,
    config,
    store,
    scheduler,
    agent,
    session,
    card,
    prompts,
    handoffs,
    archived,
    events,
    cwd,
  };
  return ctx;
}

describe("trigger rules", () => {
  it("margin is 3 min for a 1 h TTL and 1 min for 5 min", () => {
    expect(marginSeconds(3600)).toBe(180);
    expect(marginSeconds(300)).toBe(60);
    expect(marginSeconds(20)).toBe(10);
  });

  it("only idle sessions inside the window qualify", () => {
    const base = { state: "idle", nowMs: 1000, marginMs: 100, alreadyCompacted: false };
    expect(skipReason({ ...base, cacheExpiresAtMs: 1050 })).toBeNull();
    expect(skipReason({ ...base, cacheExpiresAtMs: 1101 })).toBe("cache-hot");
    expect(skipReason({ ...base, cacheExpiresAtMs: 1000 })).toBe("cache-cold");
    expect(skipReason({ ...base, cacheExpiresAtMs: null })).toBe("no-expiry");
    expect(skipReason({ ...base, state: "waiting", cacheExpiresAtMs: 1050 })).toBe("not-idle");
  });
});

describe("scheduler (fake clock)", () => {
  it("leaves a hot cache alone, compacts inside the margin, once, with one card event", async () => {
    const s = setup("codex"); // ttl 300 s, margin 60 s
    s.clock.advance(100);
    expect((await s.scheduler.tick())[0]).toMatchObject({ action: "skipped", reason: "cache-hot" });
    expect(s.prompts).toEqual([]);

    s.clock.advance(150); // 50 s left
    expect(await s.scheduler.tick()).toEqual([{ sessionId: s.session.id, action: "compact" }]);
    expect(s.prompts).toHaveLength(3);
    expect(s.prompts[0]).toContain(`${s.card.id}.md`); // progress goes to the session .md
    expect(existsSync(join(s.cwd, ".vibe", "sessions"))).toBe(true);
    expect(s.prompts[1]).toBe("/compact");
    expect(s.prompts[2]).toContain("GOALS+PROJECT_STATE"); // restored after compaction
    expect(s.events()).toEqual([{ sessionId: s.session.id, strategy: "compact" }]);

    s.clock.advance(5);
    expect((await s.scheduler.tick())[0]).toMatchObject({ reason: "already-compacted" });
    expect(s.prompts).toHaveLength(3);
  });

  it("ignores its own turns, but a real turn starts a new idle period", async () => {
    const s = setup("codex", {
      onRun: (_text, c) => {
        c.scheduler.onTurnStarted(c.agent); // the daemon fires hooks for our turns too
        c.scheduler.onTurnEnded(c.agent); // cache rewritten: new expiry = now + 300
      },
    });
    s.clock.advance(250);
    await s.scheduler.tick();
    expect(s.events()).toHaveLength(1);
    s.clock.advance(250); // inside the refreshed window, same idle period
    expect((await s.scheduler.tick())[0]).toMatchObject({ reason: "already-compacted" });
    expect(s.events()).toHaveLength(1);

    // A genuine turn ends the idle period; the next idle window compacts again.
    s.scheduler.onTurnStarted(s.agent);
    s.scheduler.onTurnEnded(s.agent);
    s.clock.advance(250);
    await s.scheduler.tick();
    expect(s.events()).toHaveLength(2);
  });

  it("skips a session stuck in a permission approval, and an expired cache", async () => {
    const s = setup("codex");
    s.store.sessions.setState(s.session.id, "waiting", { question: { requestId: "r" } });
    s.clock.advance(250);
    expect(await s.scheduler.tick()).toEqual([]); // not idle: not even a candidate
    expect(s.prompts).toEqual([]);

    s.store.sessions.setState(s.session.id, "idle");
    s.clock.advance(100); // past expiry
    expect((await s.scheduler.tick())[0]).toMatchObject({ reason: "cache-cold" });
    expect(s.prompts).toEqual([]);
  });

  it("defers (not fails) when the progress turn needs a permission, and retries later", async () => {
    let status: "permission" | "idle" = "permission";
    const s = setup("codex", { onRun: () => ({ status }) });
    s.clock.advance(250);
    expect((await s.scheduler.tick())[0]).toMatchObject({ action: "skipped", reason: "deferred" });
    expect(s.prompts).toHaveLength(1);
    expect(s.events()).toEqual([]);

    status = "idle"; // the user answered
    s.clock.advance(5);
    expect((await s.scheduler.tick())[0]).toMatchObject({ action: "compact" });
  });

  it("does not duplicate an event the board lifecycle already recorded", async () => {
    const s = setup("codex", {
      onRun: (text, c) => {
        if (text === "/compact") c.store.sessions.recordCompaction(c.session.id, "auto");
      },
    });
    s.clock.advance(250);
    await s.scheduler.tick();
    expect(s.events()).toEqual([{ sessionId: s.session.id, strategy: "auto" }]);
  });

  it("hands over CLIs without /compact: new session from memory files, old one ended", async () => {
    const s = setup("kimi");
    s.clock.advance(250);
    expect(await s.scheduler.tick()).toEqual([{ sessionId: s.session.id, action: "handoff" }]);
    expect(s.prompts).toHaveLength(1); // only the progress notes; no /compact
    expect(s.handoffs[0]).toContain(`${s.card.id}.md`);
    expect(s.handoffs[0]).toContain("GOALS+PROJECT_STATE");
    expect(s.archived).toEqual(["agent-1"]);
    expect(s.store.sessions.get(s.session.id)?.state).toBe("ended");
    expect(s.store.sessions.getByAgent("agent-1-next")?.cardId).toBe(s.card.id);
    expect(s.events()).toEqual([{ sessionId: s.session.id, strategy: "handoff" }]);
  });

  it("leaves claude to Claude Code when native idle compaction exists", async () => {
    const s = setup("claude", { nativeClaude: true }); // ttl 3600, margin 180
    s.clock.advance(3500);
    expect((await s.scheduler.tick())[0]).toMatchObject({ action: "skipped", reason: "native" });
    expect(s.prompts).toEqual([]);

    const own = setup("claude"); // not native: the same moment compacts
    own.clock.advance(3500);
    expect((await own.scheduler.tick())[0]).toMatchObject({ action: "compact" });
  });

  it("honours enabled=false", async () => {
    const s = setup("codex");
    s.config.enabled = false;
    s.clock.advance(250);
    expect(await s.scheduler.tick()).toEqual([]);
  });
});

describe("native idle compaction probe", () => {
  it("detects the flag in --help, falls back to a version floor, and fails closed", async () => {
    expect(await detectNativeIdleCompaction(async () => "  --idle-compaction  compact idle")).toBe(
      true,
    );
    expect(await detectNativeIdleCompaction(async () => "usage: claude [options]")).toBe(false);
    const byVersion = async (_c: string, args: string[]) =>
      args[0] === "--version" ? "2.5.0 (Claude Code)" : "usage";
    expect(await detectNativeIdleCompaction(byVersion, "2.4.0")).toBe(true);
    expect(await detectNativeIdleCompaction(byVersion, "2.6.0")).toBe(false);
    expect(await detectNativeIdleCompaction(() => Promise.reject(new Error("ENOENT")))).toBe(false);
    expect(compareVersions("0.16.0", "0.9.5")).toBeGreaterThan(0);
  });
});
