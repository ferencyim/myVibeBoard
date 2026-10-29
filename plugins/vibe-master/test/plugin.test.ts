import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import contribute from "../index.server";
import { setupBoard, tempDir } from "./helpers";

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("rules", () => {
  it("the generated rules match skills/vibe-master/SKILL.md", () => {
    const run = spawnSync(process.execPath, [join(pluginDir, "scripts/gen-rules.mjs"), "--check"], {
      encoding: "utf8",
    });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
  });

  it("ships a skill that only adjusts queue order on user request", () => {
    const skill = readFileSync(
      join(pluginDir, "../../skills/vibe-master/SKILL.md"),
      "utf8",
    ).replace(/\r\n/g, "\n");
    expect(skill).toMatch(/^---\nname: vibe-master\n/);
    expect(skill).toContain("仅在用户明确要求调整顺序时");
    expect(skill).toContain("vibe_queue_reorder");
    for (const removed of ["assess_draft", "session_help", "plan_discussion"])
      expect(skill).not.toContain(removed);
    expect(skill).toContain("跨项目排队派发只由调度器规则执行");
    expect(existsSync(join(pluginDir, "server/master/rules.generated.ts"))).toBe(true);
  });
});

type Handler = (input: unknown, context: unknown) => unknown;

/** Stand-in for the plugin server context: records hooks, RPC handlers and settings. */
function fakeServer(host: Record<string, unknown> = {}) {
  const handlers = new Map<string, Handler>();
  const hooks = new Map<string, Array<(e: unknown, c: unknown) => void>>();
  const server = {
    registerSettings: () => ({
      read: async () => ({
        status: "ready",
        revision: "1",
        values: {
          enabled: true,
          provider: "claude",
          model: "",
          thinking: "",
          workspaceDir: "",
          quotaLowPct: 20,
          quotaCheckSeconds: 3600,
          sweepOnStart: true,
        },
      }),
      subscribe: () => () => undefined,
    }),
    handle: (contract: { name: string }, handler: Handler) =>
      void handlers.set(contract.name, handler),
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

  it("rejects agent callers before forwarding bot RPCs", async () => {
    process.env.VIBE_HOME = tempDir("vibe-master-proxy-");
    const { server, handlers } = fakeServer();
    const cleanup = contribute(server);
    const calls: unknown[] = [];
    const context = { callerAgentId: "project-bot-agent", paseo: { plugins: {
      invoke: async (...args: unknown[]) => { calls.push(args); return {}; },
    } } };
    for (const method of ["bots.list", "bots.create", "bots.open", "bots.archive", "vibe.master.bot_migration"]) {
      await expect(handlers.get(method)!({ id: "bot_other", kind: "independent", name: "绕过" }, context)).rejects.toThrow();
    }
    expect(calls).toEqual([]);
    await cleanup();
  });

  it("exposes only public legacy master configuration to the user", async () => {
    process.env.VIBE_HOME = tempDir("vibe-master-migration-");
    const { server, handlers } = fakeServer();
    const cleanup = contribute(server);
    const snapshot = await handlers.get("vibe.master.bot_migration")!({}, { callerAgentId: null });
    expect(snapshot).toMatchObject({ presetId: null, provider: "claude", candidateIndex: 0,
      backupModels: [], notifications: { enabled: true, completed: true, failed: true },
    });
    expect(snapshot).not.toHaveProperty("workspaceDir");
    expect(snapshot).not.toHaveProperty("env");
    await cleanup();
  });

  it("is idle without crashing when the board has nothing to do", async () => {
    process.env.VIBE_HOME = tempDir("vibe-master-home-");
    const { server, handlers } = fakeServer();
    const cleanup = contribute(server);
    expect(handlers.has("master.task.wake")).toBe(true);
    expect(handlers.has("master.wake")).toBe(false);
    await cleanup();
    expect(setupBoard().project.prefix).toBe("DEMO");
  });
});
