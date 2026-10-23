import { describe, expect, it } from "vitest";
import { TaskRoleSelectionsSchema, resolveTaskRoles } from "../contract/model-roles";
import { findProjectConfig } from "../db/project-config";
import { setup } from "./helpers";

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
      expect(store.modelDefaults.global()).toEqual({
        ...defaults,
        plan_reviewer: null,
        reviewer: null,
      });
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
