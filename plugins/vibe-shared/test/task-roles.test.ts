import { describe, expect, it } from "vitest";
import {
  TaskRoleSelectionsSchema,
  resolveTaskRoles,
  freezeTaskSubtaskPresets,
  validateTaskSubtaskPresets,
  findTaskActualPreset,
} from "../contract/model-roles";
import type { TaskPlan } from "../contract/task";
import { findProjectConfig } from "../db/project-config";
import { setup } from "./helpers";

describe("frozen actual task role overrides", () => {
  const confirmedAt = "2026-10-23T12:00:00.000Z";
  const snapshot = (presetId: string) => ({
    presetId,
    source: "task" as const,
    models: [
      { provider: "codex", model: presetId, thinking: "low", permissionMode: "auto" as const },
    ],
    environmentKind: "project-default" as const,
    runtimeEnv: null,
    instructions: "冻结的中文指令",
  });
  it("finds the newest matching identity and role only within the current confirmation round", () => {
    const task = {
      confirmedAt,
      control: {
        actualModels: [
          {
            confirmedAt,
            agentId: "agent",
            memberId: "member",
            role: "worker",
            presetSnapshot: snapshot("first"),
          },
          {
            confirmedAt,
            agentId: "agent",
            memberId: "member",
            role: "worker",
            presetSnapshot: snapshot("latest"),
          },
          {
            confirmedAt: "older-round",
            agentId: "agent",
            memberId: "member",
            role: "worker",
            presetSnapshot: snapshot("old-round"),
          },
          {
            confirmedAt,
            agentId: "other",
            memberId: "member",
            role: "worker",
            presetSnapshot: snapshot("other-agent"),
          },
          {
            confirmedAt,
            agentId: "agent",
            memberId: "other",
            role: "worker",
            presetSnapshot: snapshot("other-member"),
          },
          {
            confirmedAt,
            agentId: "agent",
            memberId: "member",
            role: "reviewer",
            presetSnapshot: snapshot("other-role"),
          },
        ],
      },
    };
    expect(
      findTaskActualPreset(task, { agentId: "agent", memberId: "member", role: "worker" }),
    ).toEqual(snapshot("latest"));
    expect(findTaskActualPreset(task, { agentId: "missing" })).toBeUndefined();
    expect(findTaskActualPreset({ confirmedAt: null }, { role: "worker" })).toBeUndefined();
  });
  it("isolates subtask overrides and optionally requires admission without excluding legacy admitted entries", () => {
    const task = {
      confirmedAt,
      control: {
        actualModels: [
          {
            confirmedAt,
            role: "subagent",
            subtaskId: "one",
            presetSnapshot: snapshot("legacy-admitted"),
          },
          {
            confirmedAt,
            role: "subagent",
            subtaskId: "two",
            admitted: true,
            presetSnapshot: snapshot("other-subtask"),
          },
          {
            confirmedAt,
            role: "subagent",
            subtaskId: "one",
            admitted: false,
            presetSnapshot: snapshot("prepared"),
          },
        ],
      },
    };
    expect(findTaskActualPreset(task, { role: "subagent", subtaskId: "one" })).toEqual(
      snapshot("prepared"),
    );
    expect(
      findTaskActualPreset(task, { role: "subagent", subtaskId: "one", admittedOnly: true }),
    ).toEqual(snapshot("legacy-admitted"));
    expect(
      findTaskActualPreset(task, { role: "subagent", subtaskId: "two", admittedOnly: true }),
    ).toEqual(snapshot("other-subtask"));
    expect(findTaskActualPreset(task, { subtaskId: "missing" })).toBeUndefined();
  });
  it("skips missing snapshots but rejects a malformed matching snapshot instead of falling back", () => {
    const task = {
      confirmedAt: null,
      control: {
        actualModels: [
          { confirmedAt: null, role: "planner", presetSnapshot: snapshot("frozen") },
          null,
          { confirmedAt: null, role: "planner", presetId: "legacy" },
        ] as unknown[],
      },
    };
    expect(findTaskActualPreset(task, { role: "planner" })).toEqual(snapshot("frozen"));
    task.control.actualModels.push({
      confirmedAt: null,
      role: "planner",
      presetSnapshot: { presetId: "broken" },
    });
    expect(() => findTaskActualPreset(task, { role: "planner" })).toThrow(/预设快照无效/);
    expect(findTaskActualPreset(task, { role: "worker" })).toBeUndefined();
  });
});

describe("task roles and native project extensions", () => {
  it("resolves task -> project -> global, preserving candidate order and execution inputs", () => {
    const { store, db } = setup();
    try {
      const global = store.presets.create({
        name: "全局",
        provider: "claude",
        model: "first",
        models: [
          { provider: "claude", model: "first", thinking: "high", permissionMode: "auto" },
          { provider: "codex", model: "second", thinking: "low", permissionMode: "accept-edits" },
        ],
        runtimeEnv: "test-env",
        instructions: "按检查清单验证",
      });
      const project = store.presets.create({ name: "项目", provider: "codex", model: "project" });
      const own = store.presets.create({ name: "临时", provider: "claude", model: "own" });
      store.modelDefaults.setGlobal({
        planner: global.id,
        worker: global.id,
        verifier: global.id,
        scout: global.id,
        reviewer: global.id,
      });
      store.projects.create({
        name: "项目",
        prefix: "TASK",
        repoPath: "repo",
        paseoProjectId: "native-p",
        defaultPresets: { planner: project.id, plan_reviewer: project.id, scout: null },
      });
      store.tasks.create({ workspaceId: "role-workspace", anchorAgentId: "role-anchor" });
      expect(
        store.prompts.list().find((prompt) => prompt.key === "task.plan_format")?.fixedSuffix,
      ).toContain("vibe-plan");
      const roles = store.modelDefaults.resolveTask(
        {
          planner: { mode: "inherit" },
          worker: { mode: "preset", presetId: own.id },
          reviewer: { mode: "disabled" },
        },
        "native-p",
      );
      expect(roles.planner.presetId).toBe(project.id);
      expect(roles.planner.source).toBe("project");
      expect(roles.worker.presetId).toBe(own.id);
      expect(roles.worker.source).toBe("task");
      expect(roles.subagent).toEqual({ ...roles.worker, source: "worker" });
      expect(roles.scout).toBeNull();
      expect(roles.reviewer).toBeNull();
      expect(roles.plan_reviewer?.presetId).toBe(project.id);
      expect(roles.verifier.models.map((m) => m.model)).toEqual(["first", "second"]);
      expect(roles.verifier.instructions).toBe("按检查清单验证");
      expect(roles.verifier.runtimeEnv).toBe("test-env");
      store.presets.update(global.id, { model: "changed", instructions: "新指令" });
      expect(roles.verifier.models[0]?.model).toBe("first");
      expect(roles.verifier.instructions).toBe("按检查清单验证");
      expect(store.projects.list()[0]?.defaultPresets.scout).toBeNull();
    } finally {
      db.close();
    }
  });

  it("only scout and the two reviewers may be disabled; required jobs report a clear error", () => {
    const { store, db } = setup();
    try {
      const preset = store.presets.create({ name: "必需", provider: "codex", model: "m" });
      const defaults = { planner: preset.id, worker: preset.id, verifier: preset.id };
      for (const role of ["planner", "worker", "subagent", "verifier"])
        expect(() => TaskRoleSelectionsSchema.parse({ [role]: { mode: "disabled" } })).toThrow(
          role,
        );
      for (const role of ["scout", "plan_reviewer", "reviewer"]) {
        const resolved = resolveTaskRoles(
          { [role]: { mode: "disabled" } },
          undefined,
          defaults,
          store.presets.get,
        );
        expect(resolved[role as "scout" | "plan_reviewer" | "reviewer"]).toBeNull();
      }
      for (const role of ["planner", "worker", "verifier"] as const) {
        const missing = { ...defaults };
        delete (missing as Partial<typeof defaults>)[role];
        expect(() => resolveTaskRoles({}, {}, missing, store.presets.get)).toThrow(role);
      }
      expect(() =>
        resolveTaskRoles(
          { verifier: { mode: "preset", presetId: "deleted" } },
          defaults,
          defaults,
          store.presets.get,
        ),
      ).toThrow(/verifier.*deleted/);
      expect(() => store.modelDefaults.setGlobal({ verifier: null } as never)).toThrow();
      expect(() =>
        store.projects.create({
          name: "坏配置",
          prefix: "BAD",
          repoPath: "r",
          defaultPresets: { verifier: "deleted" },
        }),
      ).toThrow(/Preset not found/);
      store.modelDefaults.setGlobal({ ...defaults, plan_reviewer: null, reviewer: null });
      // Round 8: the planning roles are stored as the #2 方案 list.
      expect(store.modelDefaults.global()).toEqual({
        planners: [preset.id],
        worker: preset.id,
        verifier: preset.id,
        reviewer: null,
      });
    } finally {
      db.close();
    }
  });

  it("freezes custom subtask candidates, permissions, environment and instructions", () => {
    const { store, db } = setup();
    try {
      const main = store.presets.create({
        name: "默认子代理",
        provider: "codex",
        model: "default",
      });
      const custom = store.presets.create({
        name: "自定子代理",
        provider: "claude",
        model: "custom",
        models: [
          { provider: "claude", model: "custom", thinking: "high", permissionMode: "accept-edits" },
          { provider: "codex", model: "fallback", thinking: "low", permissionMode: "auto" },
        ],
        environmentKind: "new-worktree",
        runtimeEnv: "task-env",
        instructions: "自定义指令",
      });
      const roles = resolveTaskRoles(
        {},
        null,
        { planner: main.id, worker: main.id, verifier: main.id },
        store.presets.get,
      );
      const plan: TaskPlan = {
        goal: "测试",
        approach: "冻结子任务预设",
        files: [],
        checks: [{ text: "通过", method: "测试" }],
        subtasks: [
          {
            id: "custom",
            goal: "自定",
            method: "执行",
            notes: "",
            dependsOn: [],
            files: [],
            acceptance: "完成",
            presetId: custom.id,
          },
          {
            id: "default",
            goal: "默认",
            method: "执行",
            notes: "",
            dependsOn: [],
            files: [],
            acceptance: "完成",
            presetId: main.id,
          },
        ],
      };
      expect(() => validateTaskSubtaskPresets(plan, roles)).toThrow("缺少自定预设快照");
      const frozen = freezeTaskSubtaskPresets(plan, roles, store.presets.get);
      expect(frozen.subtaskPresets?.custom).toMatchObject({
        presetId: custom.id,
        source: "task",
        environmentKind: "new-worktree",
        runtimeEnv: "task-env",
        instructions: "自定义指令",
        models: [
          { provider: "claude", model: "custom", thinking: "high", permissionMode: "accept-edits" },
          { provider: "codex", model: "fallback", thinking: "low", permissionMode: "auto" },
        ],
      });
      expect(frozen.subtaskPresets?.default).toBeUndefined();
      expect(() => validateTaskSubtaskPresets(plan, frozen)).not.toThrow();
      store.presets.update(custom.id, {
        models: [{ provider: "codex", model: "changed", thinking: "", permissionMode: "full" }],
        runtimeEnv: "changed",
        instructions: "更改后的指令",
      });
      expect(frozen.subtaskPresets?.custom?.models[0]?.model).toBe("custom");
      expect(frozen.subtaskPresets?.custom?.instructions).toBe("自定义指令");
      expect(frozen.subtaskPresets?.custom?.runtimeEnv).toBe("task-env");
      expect(() =>
        validateTaskSubtaskPresets(plan, { ...frozen, subtaskPresets: { custom: roles.subagent } }),
      ).toThrow("快照与方案不匹配");
      const missingPreset = () => undefined;
      expect(() => freezeTaskSubtaskPresets(plan, roles, missingPreset)).toThrow("预设不存在");
      expect(() =>
        validateTaskSubtaskPresets({ ...plan, subtasks: [plan.subtasks[1]!] }, roles),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("reuses a retained row by native ID or repository path and reports ambiguous identities", () => {
    const { store, db } = setup();
    try {
      const project = store.projects.create({
        name: "旧项目",
        prefix: "OLD",
        repoPath: "synthetic-repo",
        description: "保留简介",
        devices: ["test-device"],
        concurrencyLimit: 2,
      });
      const linked = store.projectConfigs.link("native", "synthetic-repo/.");
      expect(linked?.id).toBe(project.id);
      expect(store.projectConfigs.get("native")?.description).toBe("保留简介");
      expect(store.projectConfigs.update("native", { description: "新简介" }).devices).toEqual([
        "test-device",
      ]);
      expect(store.projects.list()).toHaveLength(1);
      expect(() => store.projectConfigs.link("other", "synthetic-repo")).toThrow(/已经关联/);
      const duplicate = { ...project, id: "duplicate" };
      expect(() => findProjectConfig([project, duplicate], "unlinked", "synthetic-repo")).toThrow(
        /歧义/,
      );
      expect(() =>
        findProjectConfig(
          [
            { ...project, paseoProjectId: "native" },
            { ...duplicate, paseoProjectId: "native" },
          ],
          "native",
        ),
      ).toThrow(/歧义/);
      expect(
        findProjectConfig([{ ...project, paseoProjectId: "native" }, duplicate], "native")?.id,
      ).toBe(project.id);
      expect(() => store.projectConfigs.get(" ")).toThrow(/不能为空/);
    } finally {
      db.close();
    }
  });
});
