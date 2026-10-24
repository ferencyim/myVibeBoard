import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MasterError } from "../server/types";
import { createMasterRuntime } from "../server/runtime";
import { createFileMemoryPort } from "../server/memory/files";
import { createStateFile } from "../server/subscription/state";
import { TaskRoleSnapshotSchema } from "../server/vibe/contract";
import { publishEvent, type GitRunner } from "../server/vibe/db";
import { defaultSettings, fakePaseo, setupBoard, tempDir, tick, type Script } from "./helpers";

function setup(script: Script, git?: GitRunner) {
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
  const build = () =>
    createMasterRuntime({
      db: board.db,
      store: board.store,
      getPaseo: () => fake.paseo,
      settings: () => settings,
      dataDir,
      git,
      admitMemory: async (_id, files) => {
        writeAdmission.calls.push(files);
        if (!writeAdmission.allowed) throw new MasterError("unavailable", "文件冲突");
        return async () => {
          writeAdmission.released++;
        };
      },
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
const reply = (value: unknown) => JSON.stringify(value);
async function waitFor(fn: () => boolean) {
  for (let i = 0; i < 100 && !fn(); i++) await tick(10);
  expect(fn()).toBe(true);
}
function complete(t: ReturnType<typeof setup>, id: string) {
  for (const phase of ["executing", "verifying", "awaiting_acceptance", "completed"] as const)
    t.store.tasks.setPhase(id, phase);
}

describe("task master runtime", () => {
  it("receives task sorting events, filters unconfirmed/unknown/duplicate choices and leaves admission to scheduler", async () => {
    const t = setup(() =>
      reply({ order: ["b", "b", "unconfirmed", "unknown", "a"], reason: "先处理依赖" }),
    );
    t.task("a");
    t.task("b");
    t.task("unconfirmed", false);
    const runtime = t.build();
    publishEvent(t.db, {
      type: "scheduler.task_dispatch_wanted",
      payload: { requestId: "r", slots: 1, workspaceIds: ["a", "b", "unconfirmed"] },
    });
    await runtime.triggers.consumer.poll();
    await waitFor(() => t.answers().length > 0);
    expect(t.answers()[0]).toMatchObject({
      type: "master.task_dispatch_chosen",
      workspaceIds: ["b"],
    });
    expect(t.store.tasks.get("b")?.phase).toBe("queued");
    expect(t.fake.agents[0]!.prompts[0]).toContain("[task_dispatch]");
    expect(t.fake.agents[0]!.sourceAgentIds).toEqual([t.fake.agents[0]!.id]);
    expect(t.fake.agents[0]!.prompts[0]).not.toContain("unconfirmed目标");
    await runtime.dispose();
  });
  it("reports disabled/unavailable for FIFO and rechecks a changed task after the model turn", async () => {
    const t = setup(() => {
      t.store.tasks.setPhase("a", "paused");
      return reply({ order: ["a"] });
    });
    t.task("a");
    const runtime = t.build();
    await runtime.taskDispatcher.handle({ requestId: "changed", slots: 1, workspaceIds: ["a"] });
    expect(t.answers()[0].type).toBe("master.task_dispatch_failed");
    t.settings.dispatch = false;
    await runtime.taskDispatcher.handle({ requestId: "off", slots: 1, workspaceIds: ["a"] });
    expect(t.answers()[1].reason).toContain("关闭");
    expect(t.fake.agents).toHaveLength(1);
    await runtime.dispose();
  });
  it("honours task prompt overrides", async () => {
    const t = setup(() => reply({ order: ["a"] }));
    t.task("a");
    const runtime = t.build();
    t.store.prompts.setOverride("master.task_dispatch", "自定义排序 {{candidates}}");
    await runtime.taskDispatcher.handle({ requestId: "r", slots: 1, workspaceIds: ["a"] });
    expect(t.fake.agents[0]!.prompts[0]).toContain("自定义排序");
    expect(t.fake.agents[0]!.prompts[0]).toContain("workspaceId 必须来自候选");
    await runtime.dispose();
  });
  it("consolidates completion events and restart sweep without duplicate memory or requirements commits", async () => {
    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push(args);
      if (args[0] === "check-ignore") return { code: 1, stdout: "", stderr: "" };
      let stdout = "";
      if (args[0] === "status") stdout = " M PRODUCT-REQUIREMENTS.md";
      if (args[0] === "rev-parse") stdout = args[1] === "HEAD" ? "abc123" : ".git";
      return { code: 0, stdout, stderr: "" };
    };
    const t = setup(
      () =>
        reply({
          summary: "记录可靠做法",
          lessons: [{ tag: "test", body: "验证当前提交" }],
          requirementsUpdate: { content: "# 新需求", summary: "更新任务要求" },
        }),
      git,
    );
    writeFileSync(join(t.repoPath, "PRODUCT-REQUIREMENTS.md"), "# 旧需求");
    t.task("a");
    const runtime = t.build();
    complete(t, "a");
    await runtime.triggers.consumer.poll();
    await runtime.queue.idle();
    expect(readFileSync(join(t.repoPath, "PRODUCT-REQUIREMENTS.md"), "utf8")).toBe("# 新需求\n");
    expect(calls.filter((args) => args[0] === "commit")).toEqual([
      ["commit", "-m", "文档：更新任务要求", "--", "PRODUCT-REQUIREMENTS.md"],
    ]);
    expect(calls.some((args) => args[0] === "push")).toBe(false);
    expect(createFileMemoryPort().snapshot(t.repoPath)["LESSONS.md"]).toHaveLength(1);
    expect(t.store.tasks.get("a")!.summary).toContain("项目记忆已整理");
    expect(t.writeAdmission.calls).toEqual([[".vibe/**", "PRODUCT-REQUIREMENTS.md"]]);
    expect(t.writeAdmission.released).toBe(1);
    await runtime.dispose();
    const again = t.build();
    expect(again.sweep()).toBe(0);
    await again.queue.idle();
    expect(t.fake.agents[0]!.prompts).toHaveLength(1);
    expect(calls.filter((args) => args[0] === "commit")).toHaveLength(1);
    await again.dispose();
  });
  it("resumes a persisted pending memory answer after restart without asking the model again", async () => {
    const t = setup(() => {
      throw new Error("不得再次调用模型");
    });
    const task = t.task("a");
    complete(t, "a");
    createStateFile(t.dataDir).update((state) => ({
      ...state,
      taskConsolidations: {
        ["a:" + task.confirmedAt]: {
          status: "pending",
          update: {
            summary: "恢复整理",
            lessons: [{ tag: "r", body: "持久保存结果" }],
            decisions: [],
            index: [],
            archive: [],
          },
          repoPath: t.repoPath,
          requirementsPath: "PRODUCT-REQUIREMENTS.md",
          requirementsAllowed: false,
        },
      },
    }));
    const runtime = t.build();
    runtime.sweep();
    await runtime.queue.idle();
    expect(createFileMemoryPort().snapshot(t.repoPath)["LESSONS.md"]).toHaveLength(1);
    expect(t.fake.agents).toHaveLength(0);
    await runtime.dispose();
  });
  it("keeps the validated memory answer pending until the file writer is admitted", async () => {
    const t = setup(() =>
      reply({ summary: "等待文件锁", lessons: [{ tag: "lock", body: "写入先准入" }] }),
    );
    t.task("a");
    complete(t, "a");
    t.writeAdmission.allowed = false;
    const runtime = t.build();
    await expect(runtime.taskConsolidator.consolidate("a")).rejects.toThrow("文件冲突");
    expect(createFileMemoryPort().snapshot(t.repoPath)["LESSONS.md"]).toHaveLength(0);
    t.writeAdmission.allowed = true;
    await runtime.taskConsolidator.consolidate("a");
    expect(createFileMemoryPort().snapshot(t.repoPath)["LESSONS.md"]).toHaveLength(1);
    expect(t.fake.agents[0]!.prompts).toHaveLength(1);
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
