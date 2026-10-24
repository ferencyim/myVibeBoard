import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMaintenanceEngine } from "../server/engine";
import { createMaintenanceCommands, createUsageCommands } from "../server/vibe/db";
import type { CheckOutput } from "../server/types";
import { DAY, setup, tempDir, plan, roles, confirmTask } from "./helpers";

const finding = (subject = "新发现") => ({ category: "test", subject, detail: "需要处理" });
const output = (subject = "新发现"): CheckOutput => ({
  title: "维护检查",
  body: "检查发现问题",
  findings: [finding(subject)],
  notes: [],
});
const git = async () => ({ code: 0, stdout: "main\n", stderr: "" });
const yml = (mode = "suggest", extra = "") =>
  "rules:\n  - name: tidy\n    trigger: { kind: workload, cards_done: 2 }\n    check: { type: test }\n    output: " +
  mode +
  "\n    daily_cap: 1\n" +
  extra;
const fixture = (
  mode = "suggest",
  check: () => Promise<CheckOutput | null> = async () => output(),
) => setup({ repo: tempDir(), yml: yml(mode), engine: { git, checks: { test: check } } });
const ruleId = (h: ReturnType<typeof fixture>) => h.project.id + ":tidy";

describe("维护规则接入原生任务", () => {
  it.each(["suggest", "fix"])("%s 输出也只规划，等待用户显式执行", async (mode) => {
    const h = fixture(mode);
    await h.engine.tick();
    h.complete(1);
    await h.engine.tick();
    expect(h.maintenanceTasks()).toHaveLength(0);
    h.complete(1);
    await h.engine.tick();
    expect(h.maintenanceTasks()).toHaveLength(1);
    expect(h.maintenanceTasks()[0]).toMatchObject({
      phase: "planning",
      confirmedAt: null,
      rolesSnapshot: null,
    });
    expect(h.prompts[0]).toContain("/执行");
    expect(h.prompts[0]).toContain("不得修改");
    expect(h.legacyCardTables()).toEqual([]);
    expect(h.engine.listRuns(ruleId(h))[0]).toMatchObject({
      status: "done",
      cardIds: [],
      workspaceIds: [h.maintenanceTasks()[0]!.workspaceId],
    });
  });

  it("同规则项目未完成任务只补充新发现，不重复发送旧发现", async () => {
    let out = output("旧发现");
    const h = fixture("fix", async () => out);
    await h.engine.syncRules();
    await h.engine.runNow(ruleId(h));
    await h.engine.runNow(ruleId(h));
    expect(h.prompts).toHaveLength(1);
    out = { ...out, dedupeKey: "另一个调用点", findings: [...out.findings, finding("新增调用点")] };
    await h.engine.runNow(ruleId(h));
    expect(h.maintenanceTasks()).toHaveLength(1);
    expect(h.prompts).toHaveLength(2);
    expect(h.prompts[1]).toContain("新增调用点");
    expect(h.prompts[1]).not.toContain("旧发现");
    expect(createMaintenanceCommands(h.db).links()[0]!.findings).toHaveLength(2);
    expect(h.engine.listRuns(ruleId(h))).toHaveLength(3);
  });

  it("方案变化先等待真正停止，再清除确认并重新规划", async () => {
    let out = output("旧发现");
    const h = fixture("fix", async () => out);
    await h.engine.syncRules();
    await h.engine.runNow(ruleId(h));
    const task = h.maintenanceTasks()[0]!;
    confirmTask(h.store, task.workspaceId, plan, roles);
    const engine = createMaintenanceEngine({
      db: h.db,
      store: h.store,
      now: h.clock.now,
      git,
      checks: { test: async () => out },
      taskLauncher: {
        launch: async () => {
          throw new Error("不应重复创建");
        },
        append: async ({ prompt }) => {
          h.prompts.push(prompt);
        },
      },
      stopTask: async (workspaceId) => {
        expect(h.store.tasks.get(workspaceId)?.confirmedAt).not.toBeNull();
        h.store.tasks.setPhase(workspaceId, "paused");
        return true;
      },
    });
    out = output("新增发现");
    await engine.runNow(ruleId(h));
    expect(h.store.tasks.get(task.workspaceId)).toMatchObject({
      phase: "planning",
      confirmedAt: null,
      rolesSnapshot: null,
    });
    expect(h.prompts[1]).toContain("新增发现");
  });

  it("停止不确定保留发现和旧状态，下一次检查可重试", async () => {
    let out = output("旧发现");
    const h = fixture("fix", async () => out);
    await h.engine.syncRules();
    await h.engine.runNow(ruleId(h));
    const task = h.maintenanceTasks()[0]!;
    confirmTask(h.store, task.workspaceId, plan, roles);
    let stopped = false;
    const engine = createMaintenanceEngine({
      db: h.db,
      store: h.store,
      now: h.clock.now,
      git,
      checks: { test: async () => out },
      taskLauncher: {
        launch: async () => {
          throw new Error("不应重复创建");
        },
        append: async ({ prompt }) => {
          h.prompts.push(prompt);
        },
      },
      stopTask: async () => {
        if (stopped) h.store.tasks.setPhase(task.workspaceId, "paused");
        return stopped;
      },
    });
    out = output("尚未送达的发现");
    const failed = await engine.runNow(ruleId(h));
    expect(failed.status === "fired" && failed.run.status).toBe("failed");
    expect(h.store.tasks.get(task.workspaceId)).toMatchObject({
      phase: "paused",
      confirmedAt: task.confirmedAt ?? expect.any(String),
    });
    expect(h.store.tasks.get(task.workspaceId)?.summary).toContain("尚未送达的发现");
    expect(h.prompts).toHaveLength(1);
    expect(h.store.tasks.list({ phase: "queued" })).toEqual([]);
    expect(h.events("scheduler.task_resource_request").at(-1)?.payload).toMatchObject({
      workspaceId: task.workspaceId,
      action: "freeze",
    });
    stopped = true;
    await engine.runNow(ruleId(h));
    expect(h.prompts).toHaveLength(2);
    expect(h.store.tasks.get(task.workspaceId)?.confirmedAt).toBeNull();
  });

  it("每日上限保留未触发工作量，次日可运行，手动运行仍计数", async () => {
    const h = fixture();
    await h.engine.tick();
    h.complete(2);
    await h.engine.tick();
    h.complete(2);
    await h.engine.tick();
    expect(h.engine.listRuns(ruleId(h))).toHaveLength(1);
    const row = () => h.engine.status().rules.find((r) => r.rule.id === ruleId(h))!;
    expect(row()).toMatchObject({ runsToday: 1, blocked: "daily_cap", counters: { cards: 2 } });
    h.clock.advance(DAY);
    await h.engine.tick();
    expect(h.engine.listRuns(ruleId(h))).toHaveLength(2);
    await h.engine.runNow(ruleId(h));
    expect(row().runsToday).toBe(2);
  });

  it("归档驳回按任务只计一次，连续驳回暂停，手动可运行并恢复", async () => {
    const h = fixture();
    await h.engine.syncRules();
    for (let i = 0; i < 3; i++) {
      await h.engine.runNow(ruleId(h));
      const link = createMaintenanceCommands(h.db)
        .links()
        .find((item) => !item.rejectedAt)!;
      h.engine.rejectWorkspace(link.workspaceId);
      h.engine.rejectWorkspace(link.workspaceId);
    }
    expect(h.engine.getRule(ruleId(h))?.pausedAt).not.toBeNull();
    expect(h.engine.status().rules.find((r) => r.rule.id === ruleId(h))!.counters.rejects).toBe(3);
    expect(h.events("maintenance.paused")).toHaveLength(1);
    h.engine.resume(ruleId(h));
    expect(h.engine.getRule(ruleId(h))?.pausedAt).toBeNull();
  });

  it("驳回后的摘要事件不会重置连续驳回计数", async () => {
    const h = fixture();
    await h.engine.syncRules();
    for (let index = 0; index < 3; index++) {
      await h.engine.runNow(ruleId(h));
      const link = createMaintenanceCommands(h.db)
        .links()
        .find((item) => !item.rejectedAt)!;
      confirmTask(h.store, link.workspaceId, plan, roles);
      await h.engine.consumer.poll();
      h.engine.rejectWorkspace(link.workspaceId);
      h.store.tasks.setSummary(link.workspaceId, "用户驳回后的说明");
      await h.engine.consumer.poll();
      expect(
        h.engine.status().rules.find((row) => row.rule.id === ruleId(h))!.counters.rejects,
      ).toBe(index + 1);
    }
    expect(h.engine.getRule(ruleId(h))?.pausedAt).not.toBeNull();
  });

  it("同workspace新一轮确认完成会再次计数，摘要事件不重复", async () => {
    const h = fixture();
    await h.engine.syncRules();
    h.complete(1);
    await h.engine.consumer.poll();
    const completed = h.store.tasks.list({ phase: "completed" })[0]!;
    h.clock.advance(1000);
    h.store.tasks.setPhase(completed.workspaceId, "planning");
    confirmTask(h.store, completed.workspaceId, plan, roles);
    for (const phase of ["executing", "verifying", "awaiting_acceptance", "completed"] as const)
      h.store.tasks.setPhase(completed.workspaceId, phase);
    await h.engine.consumer.poll();
    h.store.tasks.setSummary(completed.workspaceId, "补充完成说明");
    await h.engine.consumer.poll();
    expect(h.engine.status().rules.find((row) => row.rule.id === ruleId(h))!.counters.cards).toBe(
      2,
    );
  });

  it("完成事件重放和重启不会重复累计", async () => {
    const h = fixture();
    h.complete(1);
    await h.engine.tick();
    await h.engine.tick();
    const count = () =>
      h.engine.status().rules.find((r) => r.rule.id === ruleId(h))!.counters.cards;
    expect(count()).toBe(1);
    const reloaded = createMaintenanceEngine({
      db: h.db,
      store: h.store,
      git,
      checks: {},
      now: h.clock.now,
    });
    await reloaded.syncRules();
    await reloaded.consumer.poll();
    expect(count()).toBe(1);
  });

  it("维护提示词按项目覆盖优先于全局，系统约束始终保留", async () => {
    const h = fixture();
    h.store.prompts.setOverride("maintenance.review", "全局 {{rule}}");
    h.store.prompts.setOverride("maintenance.review", "项目 {{rule}} {{findings_json}}", {
      projectId: h.project.id,
    });
    await h.engine.syncRules();
    await h.engine.runNow(ruleId(h));
    expect(h.prompts[0]).toContain("项目 tidy");
    expect(h.prompts[0]).not.toContain("全局 tidy");
    expect(h.prompts[0]).toContain("不得修改任何文件");
  });

  it("检查无发现不创建任务，失败发现仍保留在运行记录", async () => {
    const h = fixture("fix", async () => null);
    await h.engine.syncRules();
    await h.engine.runNow(ruleId(h));
    expect(h.maintenanceTasks()).toEqual([]);
    const broken = createMaintenanceEngine({
      db: h.db,
      store: h.store,
      git,
      checks: { test: async () => output() },
      taskLauncher: {
        launch: async () => {
          throw new Error("没有daemon");
        },
        append: async () => {},
      },
    });
    const result = await broken.runNow(ruleId(h));
    expect(result.status === "fired" && result.run.findings).toEqual([
      finding(),
      { error: "没有daemon" },
    ]);
    expect(h.legacyCardTables()).toEqual([]);
  });

  it("commit和token触发使用项目归因，不再依赖旧card", async () => {
    const h = setup({
      repo: tempDir(),
      yml: "rules:\n  - name: commits\n    trigger: { kind: workload, commits_merged: 3 }\n    check: { type: test }\n  - name: tokens\n    trigger: { kind: workload, tokens: 50 }\n    check: { type: test }\n",
      engine: {
        git: async (args) => ({
          code: 0,
          stdout: args[0] === "rev-list" ? "3" : "main",
          stderr: "",
        }),
        commitPollSeconds: 0,
        checks: { test: async () => output() },
      },
    });
    await h.engine.syncRules();
    const usage = createUsageCommands(h.db);
    usage.putEvent({
      ts: h.clock.now().toISOString(),
      provider: "codex",
      model: "test",
      sessionId: "usage-session",
      tokensIn: 40,
      tokensOut: 20,
      tokensCacheRead: 0,
      tokensCacheWrite: 0,
      durationMs: null,
      cost: null,
      dedupeKey: "maintenance-workload",
    });
    usage.relink([
      {
        provider: "codex",
        sessionId: "usage-session",
        projectId: h.project.id,
        workspaceId: null,
        role: null,
        agentId: null,
      },
    ]);
    await h.engine.tick();
    expect(h.engine.listRuns(h.project.id + ":commits")).toHaveLength(1);
    expect(h.engine.listRuns(h.project.id + ":tokens")).toHaveLength(1);
  });

  it("cron 和文件触发保留各自去重游标", async () => {
    const h = setup({
      repo: tempDir(),
      start: new Date(2026, 9, 19, 0, 30).getTime(),
      yml: "rules:\n  - name: nightly\n    trigger: { kind: time, cron: '0 3 * * *' }\n    check: { type: test }\n    daily_cap: 5\n  - name: crash\n    trigger: { kind: event, path: crash.log, pattern: Exception }\n    check: { type: test }\n    daily_cap: 5\n",
      engine: { git, checks: { test: async () => output() } },
    });
    writeFileSync(join(h.repo, "crash.log"), "old Exception\n");
    await h.engine.tick();
    h.clock.advance(3 * 3_600_000);
    appendFileSync(join(h.repo, "crash.log"), "new Exception\n");
    await h.engine.tick();
    await h.engine.tick();
    expect(h.engine.listRuns(h.project.id + ":nightly")).toHaveLength(1);
    expect(h.engine.listRuns(h.project.id + ":crash")).toHaveLength(1);
  });
});
