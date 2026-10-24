import { mkdtempSync, readFileSync, readdirSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { expectSystemTurn } from "../server/compaction/system-turn";
import * as systemTurns from "../server/compaction/system-turn";
import * as schedulerModule from "../server/compaction/scheduler";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { AgentSession } from "../server/vibe/contract";

it("registers a short-lived marker per agent in $VIBE_HOME/system-turns", () => {
  const home = mkdtempSync(join(tmpdir(), "ctx-turn-"));
  expectSystemTurn("agent/1", home);
  const dir = join(home, "system-turns");
  const files = readdirSync(dir);
  expect(files).toEqual(["agent_1.json"]);
  const { expiresAt } = JSON.parse(readFileSync(join(dir, files[0]), "utf8"));
  expect(expiresAt).toBeGreaterThan(Date.now());
  expect(expiresAt).toBeLessThanOrEqual(Date.now() + 60_000);
  unlinkSync(join(dir, files[0]));
  rmdirSync(dir);
  rmdirSync(home);
});

it("writes notes by the native session path without requiring the old card tool", async () => {
  const { notesPrompt } = await import("../server/compaction");
  const prompt = notesPrompt("/wt/.vibe/sessions/c1.md");
  expect(prompt).toContain("原生任务");
  expect(prompt).not.toContain("vibe_session_note");
  expect(prompt).toContain("/wt/.vibe/sessions/c1.md");
});

it("native task-member compaction leaves no marker to suppress the next user turn", async () => {
  let marked = false;
  let options!: schedulerModule.SchedulerOptions;
  const marker = vi.spyOn(systemTurns, "expectSystemTurn").mockImplementation(() => {
    marked = true;
  });
  vi.spyOn(systemTurns, "peekSystemTurn").mockImplementation(() => marked);
  vi.spyOn(schedulerModule, "createCompactionScheduler").mockImplementation((input) => {
    options = input;
    return {
      setNativeClaude: vi.fn(),
      onTurnStarted: vi.fn(),
      onTurnEnded: vi.fn(),
      onAgentGone: vi.fn(),
      refreshComplexity: vi.fn(async () => null),
      tick: vi.fn(async () => []),
    };
  });
  const agent = {
    id: "agent",
    refresh: vi.fn(async () => ({ agent: { status: "idle", provider: "codex", cwd: "." } })),
    waitForFinish: vi.fn(async () => ({ status: "idle" })),
    run: vi.fn(async () => ({ status: "idle" })),
  };
  const snapshot = {
    status: "active",
    members: [
      { memberId: "member", backendAgentId: "agent", lastRequestAt: "before", status: "idle" },
    ],
  };
  const conversation = {
    id: "conversation",
    current: () => snapshot,
    compact: vi.fn(async () => ({
      error: null,
      conversation: { ...snapshot, members: [{ ...snapshot.members[0], lastRequestAt: "after" }] },
    })),
  };
  const server = {
    paseo: {
      agents: { ref: () => agent },
      taskConversations: { resolve: async () => conversation },
    },
    registerSettings: (definition: { schema: { parse(value: unknown): unknown } }) => ({
      read: async () => ({ status: "ready", values: definition.schema.parse({}) }),
      subscribe: () => () => {},
    }),
    on: () => () => {},
  };
  const { registerCompaction } = await import("../server/compaction");
  const stop = registerCompaction(server as unknown as PluginServerContext, {
    dbPath: ":memory:",
    detectNative: async () => false,
    log: () => {},
  });
  try {
    const member = await options.host.taskMember!({
      workspaceId: "workspace",
      agentId: "agent",
    } as AgentSession);
    expect(await member!.compact()).toBe("after");
    expect(conversation.compact).toHaveBeenCalledWith({ memberId: "member" });
    expect(marker).not.toHaveBeenCalled();
    // The next user foreground turn is still classified as user work immediately after compact.
    expect(options.isSystemTurn!("agent")).toBe(false);
    await options.host.run("agent", "旧普通会话压缩提示");
    expect(marker).toHaveBeenCalledTimes(1);
    expect(options.isSystemTurn!("agent")).toBe(true);
  } finally {
    stop();
    vi.restoreAllMocks();
  }
});
