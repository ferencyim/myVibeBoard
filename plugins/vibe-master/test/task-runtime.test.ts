import { describe, expect, it } from "vitest";
import { createMasterRuntime } from "../server/runtime";
import { TaskRoleSnapshotSchema } from "../server/vibe/contract";
import { publishEvent } from "../server/vibe/db";
import { defaultSettings, fakePaseo, setupBoard, tempDir, tick, type Script } from "./helpers";

function setup(script: Script) {
  const board = setupBoard();
  board.store.projects.update(board.project.id, { paseoProjectId: "native-project" });
  const fake = fakePaseo(script);
  fake.paseo.workspaces = {
    ref: () => ({
      refresh: async () => ({ projectId: "native-project", workspaceDirectory: board.repoPath }),
    }),
  };
  const settings = defaultSettings();
  const dataDir = tempDir();
  const writeAdmission = { allowed: true, calls: [] as string[][], released: 0 };
  const build = (managedByBots = false) =>
    createMasterRuntime({
      managedByBots,
      db: board.db,
      store: board.store,
      getPaseo: () => fake.paseo,
      settings: () => settings,
      dataDir,
      admitMaster: async () => async () => undefined,
      pollIntervalMs: 3600000,
      log: () => undefined,
    });
  const preset = {
    presetId: board.presets.claude.id,
    source: "global",
    models: [{ provider: "claude", model: "opus-x", thinking: "high", permissionMode: "auto" }],
    environmentKind: "project-default",
    runtimeEnv: null,
    instructions: "中文",
  };
  const roles = TaskRoleSnapshotSchema.parse({
    scout: null,
    planner: preset,
    plan_reviewer: null,
    worker: preset,
    subagent: { ...preset, source: "worker" },
    reviewer: null,
    verifier: preset,
  });
  function task(id: string, confirm = true) {
    board.store.tasks.create({ workspaceId: id, anchorAgentId: "anchor-" + id });
    board.store.tasks.savePlan(id, {
      goal: id + "目标",
      approach: "实现并验证",
      files: ["src/" + id],
      subtasks: [],
      checks: [{ text: "测试通过", method: "单测" }],
    });
    if (confirm) {
      const created = board.store.tasks.get(id)!;
      const tab =
        created.tabs.find((item) => item.agentId === created.anchorAgentId) ??
        board.store.tasks.allocateTab(id, {
          agentId: created.anchorAgentId,
          role: "main",
          provider: "codex",
          model: "test",
        }).tab;
      board.store.tasks.confirm(id, {
        rolesSnapshot: roles,
        planSource: { tabNumber: tab.number, agentId: tab.agentId, sourceKey: "test-" + id },
      });
    }
    return board.store.tasks.get(id)!;
  }
  const answers = () =>
    board.db
      .prepare<{ type: string; payload_json: string }>(
        "SELECT type, payload_json FROM vibe_event WHERE type IN ('master.task_dispatch_chosen','master.task_dispatch_failed') ORDER BY seq",
      )
      .all()
      .map((row) => Object.assign({ type: row.type }, JSON.parse(row.payload_json)));
  return { ...board, fake, settings, dataDir, build, task, answers, writeAdmission };
}
async function waitFor(fn: () => boolean) {
  for (let i = 0; i < 100 && !fn(); i++) await tick(10);
  expect(fn()).toBe(true);
}
function complete(t: ReturnType<typeof setup>, id: string) {
  for (const phase of ["executing", "verifying", "awaiting_acceptance", "completed"] as const)
    t.store.tasks.setPhase(id, phase);
}

describe("task master runtime", () => {
  it("ignores legacy dispatch requests and never starts a sorting turn", async () => {
    const t = setup(() => { throw new Error("独立 bot 不应自动排序"); });
    t.task("a");
    const runtime = t.build();
    publishEvent(t.db, {
      type: "scheduler.task_dispatch_wanted",
      payload: { requestId: "legacy", slots: 1, workspaceIds: ["a"] },
    });
    await runtime.triggers.consumer.poll();
    await runtime.queue.idle();
    expect(t.fake.agents).toHaveLength(0);
    expect(t.answers()).toEqual([]);
    expect(t.store.prompts.list().some((prompt) => prompt.key === "master.task_dispatch")).toBe(false);
    await runtime.dispose();
  });
  it("bot 服务接管后，旧单例设置、权限和接续不再新建 agent", async () => {
    const t = setup(() => "ok");
    const original = t.build();
    await original.session.ask("旧总 agent 历史");
    const previous = original.session.liveSession()!;
    await original.dispose();
    const runtime = t.build(true);
    await runtime.onSettingsChanged();
    await expect(runtime.setPermission("auto")).rejects.toThrow("具体 bot");
    publishEvent(t.db, {
      type: "context.continuation_requested",
      payload: { requestId: "managed", workspaceId: null, sessionId: previous.id,
        agentId: previous.agentId, role: "master", reason: "context", message: "接续",
        summary: "摘要", candidateIndex: 0, confirmedAt: null, prompt: "" },
    });
    await runtime.triggers.consumer.poll();
    await runtime.queue.idle();
    expect(t.fake.agents).toHaveLength(1);
    expect(t.store.sessions.get(previous.id)?.state).not.toBe("ended");
    await runtime.dispose();
  });
  it("导出旧预设候选进度、有效说明与权限，不包含环境或工作目录", async () => {
    const t = setup(() => "ok");
    const models = [
      { provider: "claude", model: "first", thinking: "high", permissionMode: "auto" as const },
      { provider: "codex", model: "second", thinking: "xhigh", permissionMode: "full" as const },
    ];
    t.store.presets.update(t.presets.claude.id, { models });
    t.settings.presetId = t.presets.claude.id;
    const runtime = t.build(true);
    runtime.state.update((previous) => ({ ...previous,
      permissionMode: "full-access",
      presetSelection: { key: JSON.stringify([t.presets.claude.id, models]), index: 1 },
      agent: { agentId: "preserved", sessionId: "session-preserved", target: {
        provider: "codex", model: "second", thinking: "xhigh",
      } },
    }));
    t.store.prompts.setOverride("master.rules", "保留用户规则");
    t.store.prompts.setOverride("master.rules_supplement", "保留用户补充");
    const snapshot = runtime.botMigrationSnapshot();
    expect(snapshot).toMatchObject({ presetId: t.presets.claude.id, provider: "codex",
      model: "second", candidateIndex: 1, permissionMode: "full", models,
      backupModels: [{ provider: "codex", model: "second", thinking: "xhigh" }],
    });
    expect(snapshot.instructions).toContain("保留用户规则");
    expect(snapshot.instructions).toContain("保留用户补充");
    expect(snapshot).not.toHaveProperty("workspaceDir");
    expect(snapshot).not.toHaveProperty("env");
    runtime.state.update((previous) => ({ ...previous, presetSelection: { key: "stale", index: 1 } }));
    expect(runtime.botMigrationSnapshot().candidateIndex).toBe(0);
    await runtime.dispose();
  });
  it("leaves completion and manual consolidation exclusively to the project agent", async () => {
    const t = setup(() => {
      throw new Error("总 agent 不应收到任务完成整理");
    });
    t.task("a");
    const runtime = t.build();
    complete(t, "a");
    await runtime.triggers.consumer.poll();
    expect(runtime.sweep()).toBe(0);
    expect(runtime.wake("a", true)).toMatchObject({
      queued: false,
      message: expect.stringContaining("项目 agent"),
    });
    await runtime.queue.idle();
    expect(t.fake.agents).toHaveLength(0);
    expect(t.store.prompts.list().some((prompt) => prompt.key === "master.wake.task_done")).toBe(
      false,
    );
    await runtime.dispose();
  });
  it("records the actual master model and continues context on the same candidate while preserving native history", async () => {
    const t = setup(() => "ok");
    t.task("completed");
    complete(t, "completed");
    const runtime = t.build();
    await runtime.session.ask("先记住当前任务");
    const previous = runtime.session.liveSession()!;
    expect(previous).toMatchObject({
      cardId: null,
      workspaceId: null,
      model: "opus-x",
      candidateIndex: 0,
    });
    publishEvent(t.db, {
      type: "context.continuation_requested",
      payload: {
        requestId: "continue",
        workspaceId: null,
        sessionId: previous.id,
        agentId: previous.agentId,
        role: "master",
        reason: "context",
        message: "上下文接近上限",
        summary: "继续整理任务结果",
        candidateIndex: 0,
        confirmedAt: null,
        prompt: "",
      },
    });
    await runtime.triggers.consumer.poll();
    await waitFor(() => t.store.sessions.get(previous.id)?.state === "ended");
    const next = runtime.session.liveSession()!;
    expect(next).toMatchObject({
      previousSessionId: previous.id,
      model: "opus-x",
      candidateIndex: 0,
    });
    expect(t.fake.agents[0]!.archived).toBe(false);
    await runtime.session.ask("继续");
    expect(t.fake.agents[1]!.prompts[0]).toContain("继续整理任务结果");
    expect(t.fake.agents[1]!.prompts[0]).toContain("completed目标");
    await runtime.dispose();
  });
});
