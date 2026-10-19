import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import contribute from "../index.server";
import { permissionRpc, statusRpc, switchRpc, wakeRpc } from "../shared/rpc";
import { assessmentJson, fakePaseo, setupBoard, tempDir, tick } from "./helpers";
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
    for (const reason of ["assess_draft", "card_done", "session_help"]) expect(skill).toContain(reason);
    expect(skill).toContain("Never move a card");
    expect(existsSync(join(pluginDir, "server/master/rules.generated.ts"))).toBe(true);
  });
});

type Handler = (input: any, context: any) => unknown;

/** Stand-in for the plugin server context: records hooks, RPC handlers and settings. */
function fakeServer(host: Record<string, unknown> = {}) {
  const handlers = new Map<string, Handler>();
  const hooks = new Map<string, Array<(e: unknown, c: unknown) => void>>();
  const server = {
    registerSettings: () => ({
      read: async () => ({ status: "ready", revision: "1", values: { enabled: true, provider: "claude", model: "", thinking: "", debounceSeconds: 1, workspaceDir: "", quotaLowPct: 20, quotaCheckSeconds: 3600, sweepOnStart: false } }),
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
    const fake = fakePaseo(() => assessmentJson());
    const { server, handlers, hooks } = fakeServer();
    const cleanup = contribute(server);
    expect([...handlers.keys()].sort()).toEqual([permissionRpc.name, statusRpc.name, switchRpc.name, wakeRpc.name].sort());
    expect(hooks.has("agent.created")).toBe(true);

    // seed a project and a draft in the same vibe.db the plugin opened
    const db = openVibeDb();
    migrateOwner(db, "core");
    const store = createVibeStore(db);
    const project = store.projects.create({ name: "Demo", prefix: "DEMO", repoPath: home, projectType: "web" });
    store.presets.create({ name: "Claude Opus", provider: "claude", model: "opus" });
    const card = store.cards.create({ projectId: project.id, title: "Entry test", description: "d" });

    // before any hook/RPC the plugin has no daemon handle
    const context = { paseo: fake.paseo };
    const first = (await handlers.get("master.status")!({ includeProviders: false }, context)) as { paseoReady: boolean };
    expect(first.paseoReady).toBe(true);

    const woken = (await handlers.get("master.wake")!({ card: card.key.toLowerCase(), reason: "assess_draft", force: true }, context)) as { queued: boolean };
    expect(woken.queued).toBe(true);
    for (let i = 0; i < 100 && store.events.list(card.id).every((e) => e.type !== "evaluation"); i++) await tick(20);
    expect(store.events.list(card.id).some((e) => e.type === "evaluation")).toBe(true);
    expect(store.cards.get(card.id)!.column).toBe("draft");

    const switched = (await handlers.get("master.switch")!({ provider: "claude", model: "sonnet-x" }, context)) as { changed: boolean; target: { model: string } };
    expect(switched).toMatchObject({ changed: true, target: { model: "sonnet-x" } });

    const missing = (await handlers.get("master.wake")!({ card: "DEMO-99", reason: "assess_draft", force: true }, context)) as { queued: boolean };
    expect(missing.queued).toBe(false);

    await cleanup();
    db.close();
  });

  it("works from the start-up handle: sweeps drafts and pushes bus events with no hook or RPC", async () => {
    const home = tempDir("vibe-master-home-");
    process.env.VIBE_HOME = home;
    const db = openVibeDb();
    migrateOwner(db, "core");
    const store = createVibeStore(db);
    const project = store.projects.create({ name: "Demo", prefix: "DEMO", repoPath: home, projectType: "web" });
    store.presets.create({ name: "Claude Opus", provider: "claude", model: "opus" });
    const card = store.cards.create({ projectId: project.id, title: "Startup test", description: "d" });

    const fake = fakePaseo(() => assessmentJson());
    const pushed: unknown[] = [];
    const { server } = fakeServer({ paseo: fake.paseo, notify: (n: unknown) => pushed.push(n) });
    const cleanup = contribute(server);
    for (let i = 0; i < 100 && store.events.list(card.id).every((e) => e.type !== "evaluation"); i++) await tick(20);
    expect(store.events.list(card.id).some((e) => e.type === "evaluation")).toBe(true);

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
