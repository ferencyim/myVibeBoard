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

  it("ships a skill with front matter and every wake reason", () => {
    const skill = readFileSync(
      join(pluginDir, "../../skills/vibe-master/SKILL.md"),
      "utf8",
    ).replace(/\r\n/g, "\n");
    expect(skill).toMatch(/^---\nname: vibe-master\n/);
    expect(skill).toContain("task_done");
    expect(skill).toContain("### task_dispatch");
    for (const removed of ["assess_draft", "session_help", "plan_discussion"])
      expect(skill).not.toContain(removed);
    expect(skill).toContain("绝不修改任务、方案、角色快照或验收结论");
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
