import { createContextResources } from "../server/runtime/resources";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTaskContinuation,
  continuationFailure,
  createTaskWatchdog,
  createTaskContextService,
  registerTaskContext,
} from "../server/runtime";
import { readState, writeState } from "../server/complexity";
import { createCompactionScheduler } from "../server/compaction";
import { persistCachePolicy } from "../server/compaction/cache-policy";
import { isTaskContinuationChain } from "../server/runtime/continuation-chain";
import {
  createVibeStore,
  createTaskRuntimeCommands,
  migrateOwner,
  openVibeDb,
  publishEvent,
  readEvents,
} from "../server/vibe/db";
import { createContextPrompts } from "../server/prompts";
import { injectContext, buildContextBlock } from "../server/inject";
import { createMemoryStore } from "../server/memory";
import type { SessionRole, TaskPresetSnapshot } from "../server/vibe/contract";

const handles: ReturnType<typeof openVibeDb>[] = [];
afterEach(() => {
  for (const db of handles.splice(0)) db.close();
});
const preset: TaskPresetSnapshot = {
  presetId: "p",
  source: "task",
  models: [
    { provider: "codex", model: "first", thinking: "high", permissionMode: "auto" },
    { provider: "claude", model: "second", thinking: "", permissionMode: "auto" },
    { provider: "codex", model: "third", thinking: "low", permissionMode: "auto" },
  ],
  environmentKind: "new-worktree",
  runtimeEnv: "env",
  instructions: "保留用户指令",
};
function setup(role: SessionRole = "worker") {
  const db = openVibeDb({ path: ":memory:" });
  handles.push(db);
  migrateOwner(db, "core");
  const store = createVibeStore(db);
  const runtime = createTaskRuntimeCommands(db);
  const task = store.tasks.create({ workspaceId: "workspace", anchorAgentId: "anchor" });
  const roles = {
    scout: preset,
    planner: preset,
    plan_reviewer: preset,
    worker: preset,
    subagent: preset,
    reviewer: preset,
    verifier: preset,
  };
  store.tasks.confirm(task.workspaceId, {
    rolesSnapshot: roles,
    plan: {
      goal: "目标",
      approach: "做法",
      files: ["src/**"],
      subtasks: [],
      checks: [{ text: "测试", method: "运行测试" }],
    },
  });
  store.tasks.setPhase(task.workspaceId, "executing");
  const current = store.tasks.get(task.workspaceId)!;
  const session = runtime.registerSession({
    workspaceId: task.workspaceId,
    agentId: "agent",
    role,
    provider: "codex",
    model: "first",
    thinking: "high",
    candidateIndex: 0,
    confirmedAt: current.confirmedAt,
  });
  store.sessions.setState(session.id, "working");
  return { db, store, runtime, task: current, session };
}

describe("task continuation", () => {
  it("continues after the active candidate following an owner cold context handoff", async () => {
    const s = setup();
    const active = s.runtime.recordContinuation({
      fromSessionId: s.session.id,
      agentId: "active-second",
      ...preset.models[1]!,
      candidateIndex: 1,
      reason: "quota exhausted",
    }).to;
    const cold = s.runtime.recordContinuation({
      fromSessionId: active.id,
      agentId: "cold-second",
      ...preset.models[1]!,
      candidateIndex: 1,
      reason: "context",
    }).to;
    const start = vi.fn(async () => ({
      status: "started" as const,
      agentId: "next-third",
      actualModel: preset.models[2]!,
    }));
    const result = await createTaskContinuation({
      store: s.store,
      runtime: s.runtime,
      host: { stop: async () => true, start },
      report: vi.fn(),
    }).continue(cold.id, { preset, message: "quota exhausted", summary: "冷上下文交接摘要" });
    expect(result).toMatchObject({ status: "continued", candidateIndex: 2 });
    expect(start).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ candidateIndex: 2, candidate: preset.models[2] }),
    );
    expect(s.runtime.getSelection(s.runtime.getContinuation(cold.id)!.id)).toEqual({
      candidateIndex: 2,
      actualModel: { provider: "codex", model: "third", thinking: "low" },
    });
  });

  it("does not treat subprocess/test failures as unavailable models", () => {
    for (const text of [
      "Tests failed: exited with code 1",
      "process exited",
      "ENOENT test fixture",
      "spawn test failed",
      "assertion failed",
    ])
      expect(continuationFailure(text)).toBe("other");
    expect(continuationFailure("provider unavailable")).toBe("unavailable");
    expect(continuationFailure("login expired")).toBe("auth");
  });
  it.each([
    "master",
    "scout",
    "planner",
    "plan_reviewer",
    "worker",
    "subagent",
    "reviewer",
    "verifier",
  ] as const)("continues %s in order and replay does not create another session", async (role) => {
    const s = setup(role);
    const stop = vi.fn(async () => true);
    const start = vi.fn(async ({ candidateIndex }: { candidateIndex: number }) =>
      candidateIndex === 1
        ? { status: "failed" as const, message: "login expired", stopped: true }
        : {
            status: "started" as const,
            agentId: "next",
            actualModel: { provider: "codex", model: "actual-third", thinking: "low" },
          },
    );
    const report = vi.fn();
    const options = { store: s.store, runtime: s.runtime, host: { stop, start }, report };
    const result = await createTaskContinuation(options).continue(s.session.id, {
      preset,
      message: "quota exhausted",
      summary: "方案、进度与原生会话链接",
    });
    expect(result.status).toBe("continued");
    expect(start.mock.calls.map(([input]) => input.candidateIndex)).toEqual([1, 2]);
    expect(s.runtime.getSelection(s.runtime.getContinuation(s.session.id)!.id)).toEqual({
      candidateIndex: 2,
      actualModel: { provider: "codex", model: "actual-third", thinking: "low" },
    });
    await createTaskContinuation(options).continue(s.session.id, {
      preset,
      message: "quota exhausted",
      summary: "重复事件",
    });
    expect(start).toHaveBeenCalledTimes(2);
    expect(readEvents(s.db, 0, { types: ["session.reassigned"] })).toHaveLength(1);
  });
  it("ordinary failures and uncertain cancellation never start a new writer", async () => {
    const s = setup();
    const start = vi.fn();
    const report = vi.fn();
    const stop = vi.fn(async () => false);
    const control = createTaskContinuation({
      store: s.store,
      runtime: s.runtime,
      host: { stop, start },
      report,
    });
    expect(
      (await control.continue(s.session.id, { preset, message: "test failed", summary: "" }))
        .status,
    ).toBe("ignored");
    expect(stop).not.toHaveBeenCalled();
    expect(
      (await control.continue(s.session.id, { preset, message: "quota exhausted", summary: "" }))
        .status,
    ).toBe("paused");
    expect(start).not.toHaveBeenCalled();
    expect(s.store.sessions.get(s.session.id)!.state).toBe("working");
    expect(report).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("停止结果不明"));
  });
  it("reports exhaustion and stops when a candidate start result is uncertain", async () => {
    const s = setup();
    const report = vi.fn();
    const start = vi.fn(async () => ({
      status: "failed" as const,
      message: "model not found",
      stopped: true,
    }));
    const control = createTaskContinuation({
      store: s.store,
      runtime: s.runtime,
      host: { stop: async () => true, start },
      report,
    });
    expect(
      (await control.continue(s.session.id, { preset, message: "quota exhausted", summary: "" }))
        .status,
    ).toBe("exhausted");
    start.mockImplementation(async () => {
      throw new Error("unknown create receipt");
    });
    expect(
      (await control.continue(s.session.id, { preset, message: "login expired", summary: "" }))
        .status,
    ).toBe("paused");
    expect(start).toHaveBeenCalledTimes(3);
  });
});

describe("workspace runtime wiring", () => {
  it("accepts a continued result through the real rejected-candidate chain", async () => {
    const s = setup();
    const report = vi.fn();
    const service = createTaskContextService({ ...s, report });
    writeState(s.db, s.session.id, {
      windows: [],
      baselineTs: null,
      longCompactions: 2,
      floor: "multi",
    });
    s.store.sessions.setComplexity(s.session.id, "long");
    await service.requestContinuation(s.session, "context", "需要压缩", "接续提示");
    const request = readEvents(s.db, 0, { types: ["context.continuation_requested"] })[0]!
      .payload as { requestId: string };
    const rejected = s.runtime.recordContinuation({
      fromSessionId: s.session.id,
      agentId: "rejected",
      provider: "codex",
      model: "second",
      candidateIndex: 1,
      reason: "context",
    }).to;
    const next = s.runtime.recordContinuation({
      fromSessionId: rejected.id,
      agentId: "accepted",
      provider: "codex",
      model: "third",
      candidateIndex: 2,
      reason: "context",
    }).to;
    await service.completeContinuation({
      requestId: request.requestId,
      workspaceId: "workspace",
      status: "continued",
      reason: "候选已接手",
      sessionId: next.id,
      agentId: next.agentId,
    });
    expect(report).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: next.id }),
      "会话已接续：候选已接手",
    );
    expect(readState(s.db, next.id)).toMatchObject({ longCompactions: 3, floor: "multi" });
    expect(s.runtime.getSession(next.id)?.previousSessionId).toBe(rejected.id);
  });
  it("rejects crossed task identity, stale confirmation and cyclic continuation ancestry", () => {
    const s = setup();
    const middle = { ...s.session, id: "middle", previousSessionId: s.session.id };
    const next = { ...s.session, id: "next", previousSessionId: middle.id };
    const ancestry = new Map([
      [middle.id, middle],
      [s.session.id, s.session],
    ]);
    const lookup = (id: string) => ancestry.get(id);
    expect(isTaskContinuationChain(s.session, next, lookup)).toBe(true);
    for (const foreign of [
      { ...middle, workspaceId: "other" },
      { ...middle, role: "reviewer" as const },
      { ...middle, confirmedAt: "other-confirmation" },
      { ...middle, previousSessionId: next.id },
    ]) {
      const sessions = new Map([
        [next.id, next],
        [middle.id, foreign],
        [s.session.id, s.session],
      ]);
      expect(isTaskContinuationChain(s.session, next, (id) => sessions.get(id))).toBe(false);
    }
    expect(isTaskContinuationChain(s.session, s.session, lookup)).toBe(false);
    expect(
      isTaskContinuationChain(s.session, { ...next, previousSessionId: "missing" }, lookup),
    ).toBe(false);
  });
  it("queues a deduplicated request, freezes dispatch and exposes the missing owner", async () => {
    const s = setup("reviewer");
    const report = vi.fn();
    const service = createTaskContextService({ ...s, report });
    await service.requestContinuation(s.session, "failure", "quota exhausted", undefined, "turn-1");
    await service.requestContinuation(s.session, "failure", "quota exhausted", undefined, "turn-1");
    const requests = readEvents(s.db, 0, { types: ["context.continuation_requested"] });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.payload).toMatchObject({
      workspaceId: "workspace",
      role: "reviewer",
      candidateIndex: 0,
      confirmedAt: s.task.confirmedAt,
    });
    expect(s.store.tasks.get("workspace")).toMatchObject({
      phase: "paused",
      summary: expect.stringContaining("升级插件"),
    });
    expect(
      readEvents(s.db, 0, { types: ["scheduler.task_resource_request"] }).at(-1)!.payload,
    ).toMatchObject({ action: "freeze" });
  });
  it("inherits context once after an owner result without resetting subsequent turns", async () => {
    const s = setup();
    const service = createTaskContextService(s);
    s.store.sessions.setComplexity(s.session.id, "long");
    writeState(s.db, s.session.id, {
      windows: [[1, 2]],
      baselineTs: null,
      longCompactions: 2,
      floor: null,
    });
    await service.requestContinuation(s.session, "context", "长上下文", "交接提示");
    const request = readEvents(s.db, 0, { types: ["context.continuation_requested"] })[0]!
      .payload as { requestId: string };
    const next = s.runtime.recordContinuation({
      fromSessionId: s.session.id,
      agentId: "next",
      provider: "codex",
      model: "first",
      candidateIndex: 0,
      reason: "context",
    }).to;
    const result = {
      requestId: request.requestId,
      workspaceId: "workspace",
      status: "continued" as const,
      reason: "已确认停止并接续",
      sessionId: next.id,
      agentId: next.agentId,
    };
    await service.completeContinuation(result);
    expect(readState(s.db, next.id)).toMatchObject({
      longCompactions: 3,
      floor: "multi",
      windows: [],
    });
    writeState(s.db, next.id, { ...readState(s.db, next.id), windows: [[3, 4]] });
    await service.completeContinuation(result);
    expect(readState(s.db, next.id).windows).toEqual([[3, 4]]);
    expect(readEvents(s.db, 0, { types: ["session.compacted"] })).toHaveLength(1);
  });
  it("the registered native failure hook queues provider errors and pauses ordinary failures", async () => {
    const s = setup();
    const hooks = new Map<string, Function>();
    const server = {
      registerSettings: () => ({
        read: async () => ({
          status: "ready",
          values: { watchdogEnabled: false, watchdogMinutes: 10, watchdogProviderMinutes: {} },
        }),
        subscribe: () => () => {},
      }),
      on: (name: string, fn: Function) => {
        hooks.set(name, fn);
        return () => hooks.delete(name);
      },
    };
    const registration = registerTaskContext(server as unknown as PluginServerContext, s);
    try {
      const context = { paseo: { agents: { ref: () => ({ timeline: { append: vi.fn() } }) } } };
      await hooks.get("agent.turn_ended")!(
        {
          agent: { id: "agent" },
          turnId: "t",
          outcome: { kind: "failed", error: { message: "login expired" } },
        },
        context,
      );
      expect(readEvents(s.db, 0, { types: ["context.continuation_requested"] })).toHaveLength(1);
      expect(s.store.sessions.get(s.session.id)?.state).toBe("error");
    } finally {
      await registration.close();
    }
  });
  it("workspace cold compaction requests owner handoff instead of creating or archiving writers", async () => {
    const s = setup();
    s.store.sessions.setState(s.session.id, "idle");
    const cwd = mkdtempSync(join(tmpdir(), "vibe-task-context-"));
    const handoff = vi.fn();
    const requestHandoff = vi.fn();
    const archive = vi.fn();
    const scheduler = createCompactionScheduler({
      store: s.store,
      usageDb: s.db,
      config: () => ({ enabled: true, ttlSeconds: {} }),
      buildContext: () => "记忆",
      now: () => 1000,
      host: { run: async () => ({ status: "idle" }), handoff, requestHandoff, archive },
    });
    scheduler.onTurnEnded({ id: "agent", provider: "kimi", cwd });
    s.store.sessions.touch(s.session.id, { cacheExpiresAt: new Date(2000).toISOString() });
    expect((await scheduler.tick())[0]?.action).toBe("requested");
    expect(requestHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "workspace" }),
      expect.stringContaining(s.session.id + ".md"),
    );
    expect(handoff).not.toHaveBeenCalled();
    expect(archive).not.toHaveBeenCalled();
  });
  it("does not record a timed out compact command as success", async () => {
    const s = setup();
    s.store.sessions.setState(s.session.id, "idle");
    const cwd = mkdtempSync(join(tmpdir(), "vibe-task-compact-"));
    const scheduler = createCompactionScheduler({
      store: s.store,
      usageDb: s.db,
      now: () => 1000,
      config: () => ({ enabled: true, ttlSeconds: {} }),
      buildContext: () => "记忆",
      host: {
        run: async (_id, text) => ({ status: text === "/compact" ? "timeout" : "idle" }),
        handoff: vi.fn(),
        archive: vi.fn(),
      },
    });
    scheduler.onTurnEnded({ id: "agent", provider: "codex", cwd });
    s.store.sessions.touch(s.session.id, { cacheExpiresAt: new Date(2000).toISOString() });
    expect((await scheduler.tick())[0]).toMatchObject({ action: "skipped", reason: "failed" });
    expect(readEvents(s.db, 0, { types: ["session.compacted"] })).toEqual([]);
  });
  it("compacts a managed member by its request time and preserves deduplication on restart", async () => {
    const s = setup();
    s.store.sessions.setState(s.session.id, "idle");
    let requestAt = new Date(0).toISOString();
    let now = 250_000;
    const compact = vi.fn(async () => {
      requestAt = new Date(now).toISOString();
      return requestAt;
    });
    const run = vi.fn();
    const handoff = vi.fn();
    const config = { enabled: true, ttlSeconds: {} };
    const create = () =>
      createCompactionScheduler({
        store: s.store,
        usageDb: s.db,
        now: () => now,
        config: () => config,
        buildContext: () => null,
        host: {
          describeIdleAgent: async () => ({ id: "agent", provider: "codex", cwd: "." }),
          taskMember: async () => ({
            conversationId: "conversation",
            memberId: "member",
            lastRequestAt: requestAt,
            idle: true,
            compact,
          }),
          run,
          handoff,
          archive: vi.fn(),
        },
      });
    // The legacy session timestamp disagrees: the member request is authoritative.
    s.store.sessions.touch(s.session.id, { cacheExpiresAt: new Date(9_999_999).toISOString() });
    expect((await create().tick())[0]?.action).toBe("compact");
    now += 250_000;
    expect((await create().tick())[0]).toMatchObject({ reason: "already-compacted" });
    // An actual subsequent request reopens the compaction window.
    requestAt = new Date(now - 249_000).toISOString();
    expect((await create().tick())[0]?.action).toBe("compact");
    config.enabled = false;
    expect(await create().tick()).toEqual([]);
    expect(compact).toHaveBeenCalledTimes(2);
    expect(run).not.toHaveBeenCalled();
    expect(handoff).not.toHaveBeenCalled();
  });
  it("reconciles an interrupted managed compact request without replaying it", async () => {
    const s = setup();
    s.store.sessions.setState(s.session.id, "idle");
    let requestAt = new Date(0).toISOString();
    let now = 250_000;
    const compact = vi.fn(async () => {
      requestAt = new Date(now).toISOString();
      throw new Error("投递结果未知");
    });
    const create = () =>
      createCompactionScheduler({
        store: s.store,
        usageDb: s.db,
        now: () => now,
        config: () => ({ enabled: true, ttlSeconds: {} }),
        buildContext: () => null,
        host: {
          describeIdleAgent: async () => ({ id: "agent", provider: "codex", cwd: "." }),
          taskMember: async () => ({
            conversationId: "conversation",
            memberId: "member",
            lastRequestAt: requestAt,
            idle: true,
            compact,
          }),
          run: vi.fn(),
          handoff: vi.fn(),
          archive: vi.fn(),
        },
      });
    expect((await create().tick())[0]).toMatchObject({ reason: "failed" });
    now += 250_000;
    expect((await create().tick())[0]).toMatchObject({ reason: "already-compacted" });
    expect(compact).toHaveBeenCalledTimes(1);
    expect(readEvents(s.db, 0, { types: ["session.compacted"] })).toEqual([]);
  });
  it("publishes the existing compaction settings as a read-only task-panel policy", () => {
    const s = setup();
    persistCachePolicy(s.db, { enabled: true, ttlSeconds: {} });
    const read = () =>
      JSON.parse(
        s.db
          .prepare<{ value: string }>(
            "SELECT value FROM vibe_meta WHERE key = 'context:compaction_policy'",
          )
          .get()!.value,
      );
    expect(read()).toMatchObject({
      enabled: true,
      ttlSeconds: { claude: 3600, codex: 300 },
      fallbackTtlSeconds: 300,
    });
    persistCachePolicy(s.db, { enabled: false, ttlSeconds: { codex: 900 }, marginSeconds: 45 });
    expect(read()).toMatchObject({
      enabled: false,
      ttlSeconds: { claude: 3600, codex: 900 },
      marginSeconds: 45,
    });
  });
  it("resolves a project override through the agent.create injection callback", async () => {
    const s = setup();
    const project = s.store.projects.create({ name: "项目", prefix: "P", repoPath: "" });
    const prompts = createContextPrompts(s.store);
    prompts.register();
    s.store.prompts.setOverride("context.inject_frame", "项目专用提示词", {
      projectId: project.id,
    });
    const cwd = mkdtempSync(join(tmpdir(), "vibe-project-inject-"));
    const memory = createMemoryStore({
      projectRoot: cwd,
      userHome: cwd,
      contextWindowTokens: 200000,
    });
    memory.writeProjectState({ role: "master" }, "历史状态");
    const projectIdFor = vi.fn(async () => project.id);
    const patch = await injectContext(
      { config: { cwd, provider: "claude" } },
      { prompts, userHome: cwd, projectIdFor },
    );
    expect(projectIdFor).toHaveBeenCalledWith(cwd);
    expect(patch?.systemPrompt).toContain("项目专用提示词");
  });
  it("keeps global and project prompt overrides when defaults register again", () => {
    const s = setup();
    const project = s.store.projects.create({ name: "示例", prefix: "DEMO", repoPath: "" });
    const prompts = createContextPrompts(s.store);
    prompts.register();
    s.store.prompts.setOverride("context.inject_frame", "历史全局指令");
    s.store.prompts.setOverride("context.inject_frame", "历史项目指令", { projectId: project.id });
    prompts.register();
    const cwd = mkdtempSync(join(tmpdir(), "vibe-task-memory-"));
    const memory = createMemoryStore({
      projectRoot: cwd,
      userHome: cwd,
      contextWindowTokens: 200000,
    });
    memory.writeProjectState({ role: "master" }, "历史项目状态");
    expect(buildContextBlock(memory, { prompts, projectId: project.id })).toContain("历史项目指令");
    expect(buildContextBlock(memory, { prompts })).toContain("历史全局指令");
    expect(buildContextBlock(memory, { prompts })).toContain("历史项目状态");
  });
});

describe("all role watchdog", () => {
  it("marks no-output sessions once, ignores user waits, and clears on actual output", async () => {
    const s = setup("scout");
    const report = vi.fn();
    let activity: number | null = null;
    const stale = "2026-01-01T00:00:00.000Z";
    s.store.sessions.touch(s.session.id, { lastActivityAt: stale });
    const watchdog = createTaskWatchdog({
      store: s.store,
      config: () => ({ enabled: true, minutes: 1, providerMinutes: {} }),
      activity: async () => activity,
      report,
      now: () => Date.parse(stale) + 120000,
    });
    await watchdog.tick();
    await watchdog.tick();
    expect(report).toHaveBeenCalledTimes(1);
    activity = Date.parse(stale) + 120000;
    await watchdog.tick();
    expect(s.store.sessions.get(s.session.id)?.stalledSince).toBeNull();
    s.store.sessions.setState(s.session.id, "waiting");
    s.store.sessions.touch(s.session.id, { lastActivityAt: stale });
    activity = null;
    await watchdog.tick();
    expect(report).toHaveBeenCalledTimes(1);
  });
});

describe("compaction resource ownership", () => {
  it("defers when the ordinary worker still owns a compute slot without running or yielding it", async () => {
    const s = setup();
    const turn = vi.fn(async () => ({ status: "idle" as const }));
    const resources = createContextResources({ ...s, report: vi.fn() });
    try {
      const operation = resources.run(s.runtime.getSession(s.session.id)!, "workspace", turn);
      const request = readEvents(s.db, 0, { types: ["scheduler.task_resource_request"] }).at(
        -1,
      )!.payload;
      publishEvent(s.db, {
        type: "scheduler.task_resource_result",
        payload: { ...request, ok: false, reason: "同一角色/子任务已有准入" },
      });
      await resources.poll();
      expect((await operation).status).toBe("permission");
      expect(turn).not.toHaveBeenCalled();
      expect(
        readEvents(s.db, 0, { types: ["scheduler.task_resource_request"] }).map(
          (event) => (event.payload as { action: string }).action,
        ),
      ).toEqual(["acquire"]);
    } finally {
      await resources.close();
    }
  });
  it("binds the current native agent and yields only its newly acquired reservation", async () => {
    const s = setup();
    const turn = vi.fn(async () => ({ status: "idle" as const }));
    const resources = createContextResources({ ...s, report: vi.fn() });
    try {
      const operation = resources.run(s.runtime.getSession(s.session.id)!, "workspace", turn);
      for (const action of ["acquire", "bind", "yield"]) {
        const request = readEvents(s.db, 0, { types: ["scheduler.task_resource_request"] }).at(-1)!
          .payload as {
          requestId: string;
          workspaceId: string;
          action: string;
          reservationId?: string;
          agentId?: string;
        };
        expect(request.action).toBe(action);
        if (action !== "acquire") expect(request.reservationId).toBe("compaction-reservation");
        if (action === "bind") expect(request.agentId).toBe("agent");
        publishEvent(s.db, {
          type: "scheduler.task_resource_result",
          payload: {
            requestId: request.requestId,
            workspaceId: "workspace",
            ok: true,
            reason: "准入",
            provider: "codex",
            model: "first",
            reservationId: "compaction-reservation",
          },
        });
        await resources.poll();
        await Promise.resolve();
        await Promise.resolve();
      }
      expect((await operation).status).toBe("idle");
      expect(turn).toHaveBeenCalledTimes(1);
    } finally {
      await resources.close();
    }
  });
  it("a stop or changed confirmation during admission freezes the result without running", async () => {
    const s = setup();
    const turn = vi.fn(async () => ({ status: "idle" as const }));
    const resources = createContextResources({ ...s, report: vi.fn() });
    try {
      const operation = resources.run(s.runtime.getSession(s.session.id)!, "workspace", turn);
      const request = readEvents(s.db, 0, { types: ["scheduler.task_resource_request"] }).at(-1)!
        .payload as { requestId: string };
      s.store.tasks.setPhase("workspace", "paused");
      publishEvent(s.db, {
        type: "scheduler.task_resource_result",
        payload: {
          requestId: request.requestId,
          workspaceId: "workspace",
          ok: true,
          reason: "准入",
          provider: "codex",
          model: "first",
          reservationId: "compaction-reservation",
        },
      });
      await resources.poll();
      expect((await operation).status).toBe("permission");
      expect(turn).not.toHaveBeenCalled();
      expect(
        readEvents(s.db, 0, { types: ["scheduler.task_resource_request"] }).at(-1)!.payload,
      ).toMatchObject({ action: "freeze" });
    } finally {
      await resources.close();
    }
  });
});
