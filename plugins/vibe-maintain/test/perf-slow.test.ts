import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPerfSlowCheck } from "../server/checks/perf-slow";
import { createBackendCollector } from "../../vibe-verify/server/collectors/backend";
import { createNodeRunner, loadVerifyConfig } from "../../vibe-verify/server/collectors/common";
import { setup, tempDir, plan, roles, confirmTask } from "./helpers";

const RULE =
  "rules:\n  - name: perf-slow\n    trigger: { kind: time, cron: '0 4 * * *' }\n    check:\n      type: perf-slow\n      sources:\n        - { name: api, kind: jsonl, path: slow.jsonl, threshold_ms: 200 }\n      repro: { command: node, args: [bench.js, '{site}'], runs: 2, threshold_ms: 600 }\n    output: fix\n    daily_cap: 5\n";
const line = (route: string, ms: number) =>
  JSON.stringify({ route, duration_ms: ms, method: "GET" }) + "\n";
const fixture = () => {
  const repo = tempDir();
  writeFileSync(join(repo, "slow.jsonl"), line("/items/1", 900));
  writeFileSync(
    join(repo, "bench.js"),
    "require('node:fs').writeFileSync('unexpected-execution', '错误');",
  );
  const h = setup({
    repo,
    yml: RULE,
    engine: {
      git: async () => ({ code: 0, stdout: "", stderr: "" }),
      checks: { "perf-slow": createPerfSlowCheck() },
    },
  });
  return h;
};

describe("性能维护先确认与前后对比证据", () => {
  it("fix也先规划；确认前不执行任何配置复现命令", async () => {
    const h = fixture();
    await h.engine.syncRules();
    await h.engine.runNow(h.project.id + ":perf-slow");
    expect(existsSync(join(h.repo, "unexpected-execution"))).toBe(false);
    expect(h.maintenanceTasks()[0]).toMatchObject({ phase: "planning", confirmedAt: null });
    expect(h.prompts[0]).toContain("等待用户 /执行");
    expect(h.prompts[0]).toContain("perf-compare.json");
    expect(h.prompts[0]).toContain('"command": "node"');
    expect(h.legacyCardTables()).toEqual([]);
  });

  it("同规则新调用点补充已有任务，日志游标不重复发送", async () => {
    const h = fixture();
    await h.engine.syncRules();
    const ruleId = h.project.id + ":perf-slow";
    await h.engine.runNow(ruleId);
    await h.engine.runNow(ruleId);
    expect(h.prompts).toHaveLength(1);
    appendFileSync(join(h.repo, "slow.jsonl"), line("/orders", 1000));
    await h.engine.runNow(ruleId);
    expect(h.maintenanceTasks()).toHaveLength(1);
    expect(h.prompts).toHaveLength(2);
    expect(h.prompts[1]).toContain("GET /orders");
    expect(h.prompts[1]).not.toContain("GET /items/:id");
  });

  it("确认后使用规划中的配置接入真实backend collector，测量baseline与after", async () => {
    const h = fixture();
    await h.engine.syncRules();
    await h.engine.runNow(h.project.id + ":perf-slow");
    const task = h.maintenanceTasks()[0]!;
    confirmTask(h.store, task.workspaceId, plan, roles);
    h.store.tasks.setPhase(task.workspaceId, "executing");
    h.store.tasks.setPhase(task.workspaceId, "verifying");
    const configJson = /~~~json\n([\s\S]*?)~~~/.exec(
      h.prompts[0]!.replaceAll(String.fromCharCode(96), "~"),
    )![1]!;
    const after = tempDir("perf-after-");
    const before = tempDir("perf-before-");
    const evidence = tempDir("perf-evidence-");
    mkdirSync(join(after, ".vibe"));
    writeFileSync(join(after, ".vibe", "verify.json"), configJson);
    writeFileSync(
      join(before, "bench.js"),
      "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,900);\n",
    );
    writeFileSync(join(after, "bench.js"), "console.log('完成');\n");
    const config = loadVerifyConfig(after);
    config.backend!.perf!.baseline = { path: before, commitHash: "fixture-before" };
    const result = await createBackendCollector({ loadConfig: () => config }).collect({
      workspaceId: h.maintenanceTasks()[0]!.workspaceId,
      verificationId: "verification-fixture",
      projectType: "backend",
      projectPath: h.repo,
      worktreePath: after,
      commitHash: "fixture-after",
      outputDir: evidence,
      runner: createNodeRunner(),
      now: () => new Date(),
      log: () => {},
    });
    const report = JSON.parse(
      readFileSync(
        result.artifacts.find((item) => item.path.endsWith("perf-compare.json"))!.path,
        "utf8",
      ),
    );
    expect(report.before.source).toBe("baseline");
    expect(report.before.medianMs).toBeGreaterThanOrEqual(900);
    expect(report.after.medianMs).toBeLessThan(600);
    expect(result.judgement).toBe("pass");
  }, 20_000);
});
