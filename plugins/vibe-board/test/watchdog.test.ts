import { describe, expect, it, vi } from "vitest";
import { badgeOf } from "../client/badges/logic";
import { registerLifecycle } from "../server/lifecycle";
import {
  createWatchdog,
  DEFAULT_STALL_CONFIG,
  parseProviderMinutes,
  stallThresholdMs,
  type StallConfig,
} from "../server/lifecycle/watchdog";
import { eventTypes, setupBoard } from "./helpers";

const MIN = 60_000;

function setup(config: Partial<StallConfig> = {}) {
  const t = setupBoard();
  const { store } = t.runtime;
  const project = store.projects.create({ name: "D", prefix: "DEMO", repoPath: "d:/repo" });
  const card = store.cards.create({ projectId: project.id, title: "Feature", column: "todo" });
  const { session } = store.cards.dispatch({ cardId: card.id, agentId: "a1", provider: "claude", worktree: null });
  store.sessions.setState(session.id, "working");
  const start = Date.parse(store.sessions.get(session.id)!.lastActivityAt);
  let nowMs = start;
  /** what the daemon reports for agent a1 */
  const agent = { updatedAt: new Date(start).toISOString() };
  const send = vi.fn(async (_: string) => {});
  const paseo = {
    agents: {
      ref: () => ({
        timeline: { refetch: async () => ({ entries: [{ timestamp: agent.updatedAt, item: {} }] }) },
        send,
      }),
    },
  } as any;
  const watchdog = createWatchdog({
    board: t.board,
    getPaseo: () => paseo,
    getConfig: () => ({ ...DEFAULT_STALL_CONFIG, ...config }),
    now: () => nowMs,
    log: () => {},
  });
  return {
    ...t,
    store,
    card,
    session,
    agent,
    send,
    watchdog,
    advance: (ms: number) => void (nowMs += ms),
    row: () => store.sessions.get(session.id)!,
  };
}

describe("stall watchdog", () => {
  it("marks a working session after the threshold, writes the event and card event once", async () => {
    const t = setup();
    t.advance(9 * MIN);
    await t.watchdog.tick();
    expect(t.row().stalledSince).toBeNull();
    t.advance(2 * MIN);
    await t.watchdog.tick();
    await t.watchdog.tick(); // idempotent
    expect(t.row().stalledSince).not.toBeNull();
    expect(eventTypes(t.runtime).filter((x) => x === "session.stalled")).toHaveLength(1);
    expect(
      t.store.events.list(t.card.id).filter((e) => (e.body as any)?.kind === "session_stalled"),
    ).toHaveLength(1);
    expect(badgeOf(t.row())).toMatchObject({ label: "可能卡住", tone: "danger" });
  });

  it("does not count a waiting session as stalled", async () => {
    const t = setup();
    t.store.sessions.setState(t.session.id, "waiting", { question: { requestId: "r" } });
    t.advance(60 * MIN);
    await t.watchdog.tick();
    expect(t.row().stalledSince).toBeNull();
  });

  it("new timeline output postpones the stall and clears an existing mark", async () => {
    const t = setup();
    t.advance(9 * MIN);
    // updatedAt is compared with the session's recorded activity, not the injected clock
    t.agent.updatedAt = new Date(Date.parse(t.row().lastActivityAt) + 9 * MIN).toISOString();
    await t.watchdog.tick();
    t.advance(5 * MIN); // 14 min since start, 5 since output
    await t.watchdog.tick();
    expect(t.row().stalledSince).toBeNull();

    t.advance(6 * MIN); // 11 min since output
    await t.watchdog.tick();
    expect(t.row().stalledSince).not.toBeNull();

    t.agent.updatedAt = new Date(Date.parse(t.agent.updatedAt) + 12 * MIN).toISOString();
    await t.watchdog.tick();
    expect(t.row().stalledSince).toBeNull();
    expect(eventTypes(t.runtime)).toContain("session.unstalled");
  });

  it("uses a per-provider threshold", async () => {
    const t = setup({ minutes: 10, providerMinutes: parseProviderMinutes("claude=2, codex=30 bogus") });
    expect(parseProviderMinutes("claude=2, codex=30 bogus")).toEqual({ claude: 2, codex: 30 });
    expect(stallThresholdMs({ ...DEFAULT_STALL_CONFIG, providerMinutes: { claude: 2 } }, "Claude")).toBe(2 * MIN);
    t.advance(3 * MIN);
    await t.watchdog.tick();
    expect(t.row().stalledSince).not.toBeNull();
  });

  it("does nothing when disabled and ignores idle/ended sessions", async () => {
    const off = setup({ enabled: false });
    off.advance(99 * MIN);
    await off.watchdog.tick();
    expect(off.row().stalledSince).toBeNull();

    const idle = setup();
    idle.store.sessions.setState(idle.session.id, "idle");
    idle.advance(99 * MIN);
    await idle.watchdog.tick();
    expect(idle.row().stalledSince).toBeNull();
  });

  it("optionally interrupts a stalled agent once with a continue prompt", async () => {
    const t = setup({ autoInterruptMinutes: 5 });
    t.advance(11 * MIN);
    await t.watchdog.tick(); // stalled now
    expect(t.send).not.toHaveBeenCalled();
    t.advance(6 * MIN);
    await t.watchdog.tick();
    expect(t.send).toHaveBeenCalledTimes(1);
    expect(t.send.mock.calls[0]![0]).toMatch(/继续/);
    expect(t.row().stalledSince).toBeNull(); // touchActivity after the nudge
    expect(t.store.events.list(t.card.id).some((e) => (e.body as any)?.kind === "stall_interrupted")).toBe(true);
  });
});

describe("lifecycle activity", () => {
  it("turn hooks touch activity and clear the mark; a permission request clears it too", async () => {
    const t = setup();
    const handlers = new Map<string, (e: any, c: any) => unknown>();
    const server = { on: (n: string, h: any) => (handlers.set(n, h), () => {}), before: () => () => {} } as any;
    registerLifecycle(server, { board: t.board, log: () => {} });
    const agent = { id: "a1", workspaceId: null, parentAgentId: null, provider: "claude", cwd: "x", title: null };
    const ctx = { paseo: {}, signal: new AbortController().signal };

    t.store.sessions.markStalled(t.session.id, { idleMs: 1 });
    await handlers.get("agent.turn_started")!({ agent, turnId: "t" }, ctx);
    expect(t.row().stalledSince).toBeNull();

    t.store.sessions.markStalled(t.session.id, { idleMs: 1 });
    await handlers.get("agent.permission_requested")!({ agent, request: { id: "r", kind: "tool", name: "x" } }, ctx);
    expect(t.row().state).toBe("waiting");
    expect(t.row().stalledSince).toBeNull();
  });
});

import { draftToPayload, EMPTY_PRESET_DRAFT, toggleFallback } from "../client/presets/logic";

describe("preset fallback chain editor", () => {
  it("keeps click order, removes on second click and serialises empty as null", () => {
    let chain: string[] = [];
    chain = toggleFallback(chain, "b");
    chain = toggleFallback(chain, "a");
    chain = toggleFallback(chain, "c");
    expect(chain).toEqual(["b", "a", "c"]);
    expect(toggleFallback(chain, "a")).toEqual(["b", "c"]);
    expect(draftToPayload({ ...EMPTY_PRESET_DRAFT, fallbackPresetIds: chain }).fallbackPresetIds).toEqual(["b", "a", "c"]);
    expect(draftToPayload(EMPTY_PRESET_DRAFT).fallbackPresetIds).toBeNull();
  });
});
