import { createTaskFlow } from "../server/tabs/flow";
import { describe, expect, it, vi } from "vitest";
import { createProjectCompletion } from "../server/project-agent/completion";
import { createVibeStore, migrateOwner, openVibeDb } from "../server/vibe/db";
import { migrateProjectMaintenance } from "../server/project-agent/settings-migration";
import { boardSettings } from "../shared/settings";

describe("项目完成整理归属", () => {
  it("preserves retired owner switches once without replacing explicit board settings", () => {
    const old = { consolidateOnDone: false, maintainRequirements: false, sweepOnStart: false };
    expect(migrateProjectMaintenance({}, old)).toMatchObject({
      projectConsolidateOnDone: false,
      projectMaintainRequirements: false,
      projectSweepOnStart: false,
      projectMaintenanceMigrated: true,
    });
    expect(
      migrateProjectMaintenance({ projectConsolidateOnDone: true }, old).projectConsolidateOnDone,
    ).toBe(true);
    expect(
      migrateProjectMaintenance(
        { projectMaintenanceMigrated: true, projectConsolidateOnDone: true },
        old,
      ).projectConsolidateOnDone,
    ).toBe(true);
  });
  it("delivers once across sweeps/restarts and obeys project maintenance switches", async () => {
    const db = openVibeDb({ path: ":memory:" });
    migrateOwner(db, "core");
    const store = createVibeStore(db);
    const projectId = store.projects.create({
      name: "Demo",
      prefix: "DEMO",
      repoPath: ".",
      projectType: "web",
    }).id;
    store.tasks.create({ workspaceId: "w", anchorAgentId: "a" });
    db.prepare("UPDATE task SET phase = 'completed' WHERE workspace_id = ?").run("w");
    const settings = boardSettings.schema.parse({ projectMaintainRequirements: false });
    const sendProject = vi.fn(async () => {});
    const options = {
      db,
      store,
      settings: () => settings,
      sendProject,
      getPaseo: () =>
        ({ workspaces: { ref: () => ({ refresh: async () => ({ projectId }) }) } }) as never,
    };
    store.prompts.register([
      {
        key: "master.wake.task_done",
        plugin: "vibe-master",
        role: "master",
        title: "旧完成整理",
        defaultText: "旧正文",
      },
    ]);
    store.prompts.setOverride("master.wake.task_done", "自定义整理 {{summary}}");
    store.prompts.setOverride("master.wake.task_done", "项目整理 {{summary}}", { projectId });
    const first = createProjectCompletion(options);
    // Real startup registers completion first, then the deferred full board registry prunes.
    const flow = createTaskFlow({
      ...options,
      tabs: {} as never,
      progress: { report: async () => {}, tabTurnEnded: async () => {} },
    });
    flow.registerPrompts();
    expect(store.prompts.body("project.agent.role").text).toContain("长期项目 bot");
    expect(store.prompts.body("project.agent.task_done").text).toBe("自定义整理 {{summary}}");
    expect(store.prompts.body("project.agent.task_done", { projectId }).text).toBe(
      "项目整理 {{summary}}",
    );
    await first.completed("w");
    await first.sweep();
    expect(sendProject).toHaveBeenCalledTimes(1);
    expect(sendProject.mock.calls[0]).toEqual([
      projectId,
      expect.stringContaining("需求维护关闭时不得修改 PRODUCT-REQUIREMENTS.md"),
    ]);
    await first.close();
    const next = createProjectCompletion(options);
    await next.sweep();
    expect(sendProject).toHaveBeenCalledTimes(1);
    store.tasks.updateControl("w", { projectCompletionDelivered: null });
    settings.projectConsolidateOnDone = false;
    await next.completed("w");
    expect(sendProject).toHaveBeenCalledTimes(1);
    await next.close();
    await flow.close();
    db.close();
  });
});
