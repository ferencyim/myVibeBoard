import { describe, expect, it } from "vitest";
import {
  TaskPlanSchema,
  TaskSchema,
  TASK_PLAN_PROMPT,
  parseTaskPlan,
  type TaskPlan,
} from "../contract/task";
import { TaskRoleSnapshotSchema, type TaskRoleSnapshot } from "../contract/model-roles";
import { createTaskCommands, TaskCommandError } from "../db/tasks";
import { readEvents } from "../db/events";
import { openVibeDb } from "../db/sqlite";
import { setup } from "./helpers";

const plan = (): TaskPlan => ({
  goal: "新增任务合同",
  approach: "复用共享数据库",
  files: ["contract/task.ts"],
  subtasks: [
    {
      id: "s1",
      goal: "定义合同",
      method: "新增 schema",
      notes: "不改旧卡片",
      dependsOn: [],
      files: ["contract/task.ts"],
      acceptance: "通过校验",
    },
    {
      id: "s2",
      goal: "接入",
      method: "调用合同",
      notes: "",
      dependsOn: ["s1"],
      files: ["db/tasks.ts"],
      acceptance: "可读回",
      presetId: null,
    },
  ],
  checks: [{ text: "命令可读回", method: "运行单测" }],
});
const roles = (): TaskRoleSnapshot => {
  const preset = {
    presetId: "preset-1",
    source: "global" as const,
    models: [
      {
        provider: "codex",
        model: "test-model",
        thinking: "medium",
        permissionMode: "auto" as const,
      },
    ],
    environmentKind: "project-default" as const,
    runtimeEnv: null,
    instructions: "中文指令",
  };
  return TaskRoleSnapshotSchema.parse({
    scout: null,
    planner: preset,
    plan_reviewer: null,
    worker: preset,
    subagent: { ...preset, source: "worker" },
    reviewer: null,
    verifier: preset,
  });
};
const planSource = () => ({ tabNumber: 1, agentId: "anchor-1", sourceKey: "test-source" });
const output = (value: unknown) =>
  [
    "中文说明",
    "~~~".replaceAll("~", String.fromCharCode(96)) + "vibe-plan",
    JSON.stringify(value),
    "~~~".replaceAll("~", String.fromCharCode(96)),
  ].join("\n");
function tasks() {
  const s = setup();
  const commands = createTaskCommands(s.db, { now: () => new Date(s.clock.ms) });
  commands.create({ workspaceId: "workspace-1", anchorAgentId: "anchor-1" });
  commands.allocateTab("workspace-1", {
    agentId: "anchor-1",
    role: "main",
    provider: "codex",
    model: "test-model",
  });
  return { ...s, tasks: commands };
}

describe("task fixed plan format", () => {
  it("parses a complete marked plan without copying ordinary Markdown", () => {
    expect(parseTaskPlan(output(plan()))).toEqual(plan());
    expect(parseTaskPlan(output(plan()).replaceAll("\n", "\r\n"))).toEqual(plan());
    expect(TASK_PLAN_PROMPT.fixedSuffix).toContain("vibe-plan");
    expect(TaskPlanSchema.parse({ ...plan(), files: [], subtasks: [] }).subtasks).toEqual([]);
  });
  it("rejects missing, truncated, duplicate and invalid JSON sections", () => {
    for (const text of [
      JSON.stringify(plan()),
      "普通输出",
      output(plan()).slice(0, -3),
      output(plan()) + "\n" + output(plan()),
      output(plan()).replace("新增任务合同", 'bad"json'),
    ])
      expect(() => parseTaskPlan(text)).toThrow();
  });
  it("rejects incomplete plans and subtasks rather than filling defaults", () => {
    for (const key of ["goal", "approach", "files", "subtasks", "checks"] as const) {
      const value: Record<string, unknown> = plan();
      delete value[key];
      expect(() => parseTaskPlan(output(value))).toThrow(/格式不完整/);
    }
    for (const key of [
      "id",
      "goal",
      "method",
      "notes",
      "dependsOn",
      "files",
      "acceptance",
    ] as const) {
      const value = plan();
      delete (value.subtasks[0] as unknown as Record<string, unknown>)[key];
      expect(() => parseTaskPlan(output(value))).toThrow(/格式不完整/);
    }
    expect(() => parseTaskPlan(output({ ...plan(), checks: [] }))).toThrow();
    expect(() => parseTaskPlan(output({ ...plan(), checks: [{ text: "test" }] }))).toThrow();
  });
  it("rejects duplicate ids, unknown dependencies and cycles", () => {
    const duplicate = plan();
    duplicate.subtasks[1]!.id = "s1";
    const missing = plan();
    missing.subtasks[0]!.dependsOn = ["absent"];
    const cyclic = plan();
    cyclic.subtasks[0]!.dependsOn = ["s2"];
    for (const value of [duplicate, missing, cyclic])
      expect(() => parseTaskPlan(output(value))).toThrow();
  });
});

describe("workspace task commands", () => {
  it("creates one task per workspace, reads and filters it", () => {
    const s = tasks();
    expect(s.tasks.get("workspace-1")).toEqual({
      workspaceId: "workspace-1",
      anchorAgentId: "anchor-1",
      phase: "planning",
      flowLevel: "full",
      flowSource: "user",
      flowReason: "",
      plan: null,
      confirmedAt: null,
      rolesSnapshot: null,
      subtaskRuns: [],
      summary: "",
      conversationId: null,
      tabs: [
        {
          number: 1,
          agentId: "anchor-1",
          role: "main",
          provider: "codex",
          model: "test-model",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      nextTabNumber: 2,
      planSource: null,
      roleSelections: null,
      control: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(() => s.tasks.create({ workspaceId: "workspace-1", anchorAgentId: "other" })).toThrow(
      TaskCommandError,
    );
    expect(s.tasks.get("missing")).toBeUndefined();
    expect(s.tasks.list({ phase: "queued" })).toEqual([]);
    expect(s.tasks.list()).toHaveLength(1);
    expect(() => s.tasks.setSummary("missing", "x")).toThrow(/不存在/);
    s.db.close();
  });
  it("saves the complete plan and roles then atomically confirms once", () => {
    const s = tasks();
    s.tasks.savePlanOutput("workspace-1", output(plan()));
    s.tasks.saveRolesSnapshot("workspace-1", roles());
    const queued = s.tasks.confirm("workspace-1", { plan: plan(), rolesSnapshot: roles(), planSource: planSource() });
    expect(queued).toMatchObject({
      phase: "queued",
      confirmedAt: "2026-01-01T00:00:00.000Z",
      plan: plan(),
      rolesSnapshot: roles(),
    });
    s.tick();
    expect(() => s.tasks.confirm("workspace-1", { plan: plan(), rolesSnapshot: roles(), planSource: planSource() })).toThrow(/重复确认/);
    expect(s.tasks.get("workspace-1")?.confirmedAt).toBe(queued.confirmedAt);
    expect(readEvents(s.db, 0).filter((event) => event.type === "task.updated")).toHaveLength(5);
    expect(TaskSchema.parse(JSON.parse(JSON.stringify(queued)))).toEqual(queued);
    s.db.close();
  });
  it("allocates immutable tab numbers once per agent and never reuses a closed number", () => {
    const s = tasks();
    const first = s.tasks.allocateTab("workspace-1", {
      agentId: "anchor-1",
      role: "main",
      provider: "codex",
      model: "test-model",
    });
    expect(first.tab.number).toBe(1);
    const second = s.tasks.allocateTab("workspace-1", {
      agentId: "agent-2",
      role: "session",
      provider: "claude",
      model: "other-model",
    });
    expect(second.tab.number).toBe(2);
    expect(
      s.tasks.allocateTab("workspace-1", {
        agentId: "agent-2",
        role: "worker",
        provider: "claude",
        model: "other-model",
      }).tab,
    ).toEqual(second.tab);
    s.tick();
    const third = s.tasks.allocateTab("workspace-1", {
      agentId: "agent-3",
      role: "scout",
      provider: "codex",
      model: "test-model",
    });
    expect(third.tab.number).toBe(3);
    expect(s.tasks.get("workspace-1")).toMatchObject({
      nextTabNumber: 4,
      tabs: [
        { number: 1, agentId: "anchor-1" },
        { number: 2, agentId: "agent-2" },
        { number: 3, agentId: "agent-3" },
      ],
    });
    s.db.close();
  });
  it("only confirms once across independent database connections", () => {
    const s = tasks();
    const otherDb = openVibeDb({ path: s.path });
    const other = createTaskCommands(otherDb, { now: () => new Date(s.clock.ms + 1000) });
    s.tasks.confirm("workspace-1", { plan: plan(), rolesSnapshot: roles(), planSource: planSource() });
    expect(() => other.confirm("workspace-1", { plan: plan(), rolesSnapshot: roles(), planSource: planSource() })).toThrow(
      /重复确认/,
    );
    expect(other.get("workspace-1")?.confirmedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(readEvents(s.db, 0).filter((event) => event.type === "task.updated")).toHaveLength(3);
    otherDb.close();
    s.db.close();
  });

  it("requires a valid plan and all required role snapshots, including verifier", () => {
    const s = tasks();
    expect(() => s.tasks.confirm("workspace-1")).toThrow(/方案/);
    s.tasks.savePlan("workspace-1", plan());
    const incomplete = { ...roles(), verifier: null };
    expect(() =>
      s.tasks.confirm("workspace-1", { plan: plan(), rolesSnapshot: incomplete as unknown as TaskRoleSnapshot, planSource: planSource() }),
    ).toThrow(/verifier/);
    expect(s.tasks.get("workspace-1")).toMatchObject({
      phase: "awaiting_confirmation",
      confirmedAt: null,
      rolesSnapshot: null,
    });
    expect(() => s.tasks.setPhase("workspace-1", "queued")).toThrow(TaskCommandError);
    s.db.close();
  });
  it("confirms the latest supplied plan and roles in a single command", () => {
    const s = tasks();
    const frozen = roles();
    s.tasks.confirm("workspace-1", { plan: plan(), rolesSnapshot: frozen, planSource: planSource() });
    frozen.worker.instructions = "后来改动";
    expect(s.tasks.get("workspace-1")?.rolesSnapshot?.worker.instructions).toBe("中文指令");
    expect(s.tasks.list({ phase: "queued" })).toHaveLength(1);
    s.db.close();
  });
  it("requires a pause before replacement and clears confirmation and old runs", () => {
    const s = tasks();
    s.tasks.confirm("workspace-1", { plan: plan(), rolesSnapshot: roles(), planSource: planSource() });
    expect(() => s.tasks.savePlan("workspace-1", plan())).toThrow(/先停止/);
    s.tasks.setPhase("workspace-1", "executing");
    s.tasks.setSubtaskRun("workspace-1", {
      subtaskId: "s1",
      state: "running",
      agentId: "native-child",
      actualModel: { provider: "codex", model: "actual" },
    });
    s.tasks.setPhase("workspace-1", "paused");
    expect(() => s.tasks.savePlan("workspace-1", plan())).toThrow(/先停止/);
    expect(() => s.tasks.setPhase("workspace-1", "planning")).toThrow(/先停止/);
    s.tasks.setSubtaskRun("workspace-1", {
      subtaskId: "s1",
      state: "paused",
      continuation: { previousAgentId: "native-child", summary: "交接", candidateIndex: 1 },
    });
    expect(() => s.tasks.saveRolesSnapshot("workspace-1", roles())).toThrow(/已确认/);
    const changed = s.tasks.savePlan("workspace-1", { ...plan(), goal: "新目标" });
    expect(changed).toMatchObject({
      phase: "awaiting_confirmation",
      confirmedAt: null,
      rolesSnapshot: null,
      subtaskRuns: [],
      plan: { goal: "新目标" },
    });
    expect(() => s.tasks.setPhase("workspace-1", "executing")).toThrow();
    s.db.close();
  });
  it("restores awaiting confirmation after a context handoff pause", () => {
    const s = tasks();
    s.tasks.savePlan("workspace-1", plan());
    s.tasks.setPhase("workspace-1", "paused");
    expect(s.tasks.setPhase("workspace-1", "awaiting_confirmation")).toMatchObject({
      phase: "awaiting_confirmation",
      plan: plan(),
    });
    s.tasks.setPhase("workspace-1", "paused");
    expect(() => s.tasks.setPhase("workspace-1", "queued")).toThrow(/不能从 paused/);
    s.db.close();
  });
  it("keeps a saved plan unchanged if the newest output is incomplete", () => {
    const s = tasks();
    s.tasks.savePlan("workspace-1", plan());
    expect(() => s.tasks.savePlanOutput("workspace-1", output({ goal: "残缺" }))).toThrow();
    expect(s.tasks.get("workspace-1")?.plan).toEqual(plan());
    s.db.close();
  });
  it("stores native subtask identities, dependencies, actual model and continuation", () => {
    const s = tasks();
    expect(() =>
      s.tasks.setSubtaskRun("workspace-1", { subtaskId: "s1", state: "running" }),
    ).toThrow();
    s.tasks.confirm("workspace-1", { plan: plan(), rolesSnapshot: roles(), planSource: planSource() });
    s.tasks.setPhase("workspace-1", "executing");
    expect(() =>
      s.tasks.setSubtaskRun("workspace-1", { subtaskId: "s1", state: "running" }),
    ).toThrow(/实际模型/);
    expect(() =>
      s.tasks.setSubtaskRun("workspace-1", { subtaskId: "missing", state: "pending" }),
    ).toThrow(/没有子任务/);
    s.tasks.setSubtaskRun("workspace-1", {
      subtaskId: "s2",
      state: "running",
      agentId: "child-2",
      actualModel: { provider: "claude", model: "actual-2", thinking: "high" },
      continuation: { previousAgentId: "child-1", summary: "旧会话已停止", candidateIndex: 1 },
    });
    expect(s.tasks.get("workspace-1")?.subtaskRuns[0]).toMatchObject({
      subtaskId: "s2",
      dependsOn: ["s1"],
      state: "running",
      agentId: "child-2",
      actualModel: { provider: "claude", model: "actual-2" },
      continuation: { previousAgentId: "child-1", candidateIndex: 1 },
    });
    s.tasks.setSubtaskRun("workspace-1", {
      subtaskId: "s2",
      state: "completed",
      continuation: null,
      summary: "完成",
    });
    expect(s.tasks.get("workspace-1")?.subtaskRuns[0]).toMatchObject({
      continuation: null,
      summary: "完成",
      agentId: "child-2",
    });
    s.db.close();
  });
  it("preserves confirmed snapshots over reads and phase changes and records a conclusion", () => {
    const s = tasks();
    const queued = s.tasks.confirm("workspace-1", { plan: plan(), rolesSnapshot: roles(), planSource: planSource() });
    for (const phase of [
      "executing",
      "reviewing",
      "verifying",
      "awaiting_acceptance",
      "completed",
    ] as const)
      s.tasks.setPhase("workspace-1", phase);
    expect(s.tasks.setSummary("workspace-1", "验证通过并完成")).toMatchObject({
      summary: "验证通过并完成",
      confirmedAt: queued.confirmedAt,
      rolesSnapshot: queued.rolesSnapshot,
    });
    expect(s.tasks.setPhase("workspace-1", "planning")).toMatchObject({
      phase: "planning",
      confirmedAt: null,
      rolesSnapshot: null,
    });
    s.db.close();
  });
  it("rolls back the task mutation if bus publishing fails", () => {
    const s = tasks();
    s.db.exec(
      "CREATE TRIGGER fail_task_bus BEFORE INSERT ON vibe_event WHEN NEW.type = 'task.updated' BEGIN SELECT RAISE(ABORT, 'synthetic bus failure'); END",
    );
    expect(() => s.tasks.savePlan("workspace-1", plan())).toThrow(/synthetic bus failure/);
    expect(s.tasks.get("workspace-1")).toMatchObject({ phase: "planning", plan: null });
    s.db.close();
  });
});


describe("task flow levels", () => {
  it("persists changes and clears earlier local and creation authorizations", () => {
    const state = tasks();
    state.tasks.setControl("workspace-1", { enabledRoles: ["reviewer"], simpleAutoExecute: true });
    const changed = state.tasks.setFlow("workspace-1", { level: "medium", source: "user", reason: "调整" });
    expect(changed).toMatchObject({ flowLevel: "medium", flowSource: "user", flowReason: "调整" });
    expect(changed.control).not.toHaveProperty("enabledRoles");
    expect(changed.control).not.toHaveProperty("simpleAutoExecute");
    state.tasks.updateControl("workspace-1", { highRiskFlow: true });
    expect(() => state.tasks.setFlow("workspace-1", { level: "simple", source: "user", reason: "调整" })).toThrow("高风险任务不得使用简单流程");
    state.db.close();
  });
});
