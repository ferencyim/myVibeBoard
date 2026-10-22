import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import contribute from "../index.server";
import { permissionRpc, sessionsRpc, statusRpc, wakeRpc } from "../shared/rpc";
import { fakePaseo, setupBoard, tempDir, tick } from "./helpers";
import { createVibeStore, migrateOwner, openVibeDb, publishEvent } from "../server/vibe/db";

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("rules", () => {
  it("the generated rules match skills/vibe-master/SKILL.md", () => {
    const run = spawnSync(process.execPath, [join(pluginDir, "scripts/gen-rules.mjs"), "--check"], {
      encoding: "utf8",
    });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
  });

  it("ships a skill with front matter and every wake reason", () => {
    const skill = readFileSync(
      join(pluginDir, "../../skills/vibe-master/SKILL.md"),
      "utf8",
    ).replace(/\r\n/g, "\n");
    expect(skill).toMatch(/^---\nname: vibe-master\n/);
    expect(skill).toContain("card_done");
    for (const removed of ["assess_draft", "session_help", "plan_discussion"]) expect(skill).not.toContain(removed);
    expect(skill).toContain("绝不自行在列之间移动卡片");
    expect(existsSync(join(pluginDir, "server/master/rules.generated.ts"))).toBe(true);
  });
});

const CONSOLIDATED = JSON.stringify({ summary: "Recorded." });

function doneCard(store: ReturnType<typeof createVibeStore>, projectId: string, title: string) {
  const card = store.cards.create({ projectId, title, description: "d" }, "user");
  store.cards.move(card.id, { to: "todo", actor: "user" });
  store.cards.dispatch({ cardId: card.id, agentId: `w-${title}`, provider: "claude", worktree: null });
  store.cards.move(card.id, { to: "verifying", actor: "lifecycle" });
  store.cards.move(card.id, { to: "done", actor: "user" });
  return card;
}
const memoryUpdated = (store: ReturnType<typeof createVibeStore>, cardId: string) =>
  store.events.list(cardId).some((e) => (e.body as { kind?: string } | null)?.kind === "memory_update");

type Handler = (input: any, context: any) => unknown;

/** Stand-in for the plugin server context: records hooks, RPC handlers and settings. */
function fakeServer(host: Record<string, unknown> = {}) {
  const handlers = new Map<string, Handler>();
  const hooks = new Map<string, Array<(e: unknown, c: unknown) => void>>();
  const server = {
    registerSettings: () => ({
      read: async () => ({ status: "ready", revision: "1", values: { enabled: true, provider: "claude", model: "", thinking: "", workspaceDir: "", quotaLowPct: 20, quotaCheckSeconds: 3600, sweepOnStart: true } }),
      subscribe: () => () => undefined,
    }),
    handle: (contract: { name: string }, handler: Handler) => void handlers.set(contract.name, handler),
    on: (name: string, cb: (e: unknown, c: unknown) => void) => {
      hooks.set(name, [...(hooks.get(name) ?? []), cb]);
      return () => undefined;
    },
    before: () => () => undefined,
    registerProvider: () => undefined,
    registerUsageSource: () => undefined,
    ...host,
  };
  return { server: server as never, handlers, hooks };
}

describe("plugin entry", () => {
  const previous = process.env.VIBE_HOME;
  afterEach(() => {
    if (previous === undefined) delete process.env.VIBE_HOME;
    else process.env.VIBE_HOME = previous;
  });

  it("registers the RPCs and hooks, learns the daemon handle from them and works end to end", async () => {
    const home = tempDir("vibe-master-home-");
    process.env.VIBE_HOME = home;
    const fake = fakePaseo(() => CONSOLIDATED);
    const { server, handlers, hooks } = fakeServer();
    const cleanup = contribute(server);
    expect([...handlers.keys()].sort()).toEqual([permissionRpc.name, sessionsRpc.name, statusRpc.name, wakeRpc.name].sort());
    expect(hooks.has("agent.created")).toBe(true);

    // seed a project and a draft in the same vibe.db the plugin opened
    const db = openVibeDb();
    migrateOwner(db, "core");
    const store = createVibeStore(db);
    const project = store.projects.create({ name: "Demo", prefix: "DEMO", repoPath: home, projectType: "web" });
    store.presets.create({ name: "Claude Opus", provider: "claude", model: "opus" });
    const card = doneCard(store, project.id, "Entry test");

    // before any hook/RPC the plugin has no daemon handle
    const context = { paseo: fake.paseo };
    const first = (await handlers.get("master.status")!({}, context)) as { paseoReady: boolean; preset: { name: string } | null };
    expect(first.paseoReady).toBe(true);
    expect(first.preset?.name).toBe("Claude Opus"); // the legacy provider setting still finds its preset

    const woken = (await handlers.get("master.wake")!({ card: card.key.toLowerCase(), reason: "card_done", force: true }, context)) as { queued: boolean };
    expect(woken.queued).toBe(true);
    for (let i = 0; i < 100 && !memoryUpdated(store, card.id); i++) await tick(20);
    expect(memoryUpdated(store, card.id)).toBe(true);
    expect(store.cards.get(card.id)!.column).toBe("done");

    const missing = (await handlers.get("master.wake")!({ card: "DEMO-99", reason: "card_done", force: true }, context)) as { queued: boolean };
    expect(missing.queued).toBe(false);

    await cleanup();
    db.close();
  });

  it("works from the start-up handle: sweeps done cards and pushes bus events with no hook or RPC", async () => {
    const home = tempDir("vibe-master-home-");
    process.env.VIBE_HOME = home;
    const db = openVibeDb();
    migrateOwner(db, "core");
    const store = createVibeStore(db);
    const project = store.projects.create({ name: "Demo", prefix: "DEMO", repoPath: home, projectType: "web" });
    store.presets.create({ name: "Claude Opus", provider: "claude", model: "opus" });
    const card = doneCard(store, project.id, "Startup test");

    const fake = fakePaseo(() => CONSOLIDATED);
    const pushed: unknown[] = [];
    const { server } = fakeServer({ paseo: fake.paseo, notify: (n: unknown) => pushed.push(n) });
    const cleanup = contribute(server);
    for (let i = 0; i < 100 && !memoryUpdated(store, card.id); i++) await tick(20);
    expect(memoryUpdated(store, card.id)).toBe(true);

    publishEvent(db, { type: "master.alert", payload: { kind: "quota_error", message: "x" } });
    for (let i = 0; i < 100 && pushed.length === 0; i++) await tick(20);
    expect(pushed).toEqual([
      { title: "Vibe Board", body: "Master: quota error", data: { event: "master.alert", kind: "quota_error" } },
    ]);

    await cleanup();
    db.close();
  });

  it("is idle without crashing when the board has nothing to do", async () => {
    process.env.VIBE_HOME = tempDir("vibe-master-home-");
    const { server } = fakeServer();
    const cleanup = contribute(server);
    await cleanup();
    expect(setupBoard().project.prefix).toBe("DEMO");
  });
});
