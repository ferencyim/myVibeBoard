import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILTIN_RULES } from "../server/config";
import {
  renderGitOutput,
  type GitLedgerRow,
  type GitReport,
} from "../server/git/check";
import {
  DEFAULT_FIX_TEMPLATE,
  DEFAULT_REVIEW_TEMPLATE,
  PLACEHOLDERS,
  SYSTEM_CONSTRAINTS,
  buildPrompt,
  renderTemplate,
  unknownPlaceholders,
  type PromptVars,
} from "../shared/prompts";
import {
  describeCheck,
  describeTrigger,
  mergeRuleLayers,
  migrateRulesV1,
  progressText,
  resolveGlobalRules,
  ymlFieldsOf,
  type RulesConfig,
  type YmlRule,
} from "../shared/rules";
import { addProject, complete, setup, sh, type Harness } from "./helpers";

const vars: PromptVars = {
  project: "Demo",
  rule: "git-health",
  trigger_reason: "已完成任务 10 个，达到阈值 10",
  check_description: "Git 体检",
  card_title: "Git 体检：发现 2 项待整理",
  summary: "SUMMARY {{project}}",
  findings_json: '[{"a":1}]',
  findings_count: "1",
  date: "2026-10-21",
};

describe("rule layers: built-in < global UI rule < project maintenance.yml", () => {
  const yml = (name: string, fields: YmlRule["fields"]): YmlRule => ({ name, fields });
  const ui = (rules: RulesConfig["rules"]): RulesConfig => ({ rules });
  const merge = (input: { ui?: RulesConfig; yml?: YmlRule[]; projectId?: string }) =>
    mergeRuleLayers({ builtin: BUILTIN_RULES, projectId: "p1", ...input });

  it("uses the built-in rule for every project and marks every field builtin", () => {
    for (const projectId of ["p1", "p2"]) {
      const { rules, errors } = merge({ projectId });
      expect(errors).toEqual([]);
      expect(rules).toHaveLength(1);
      expect(rules[0]!.origin).toBe("builtin");
      expect(Object.values(rules[0]!.sources).every((s) => s === "builtin")).toBe(true);
      expect(rules[0]!.def.daily_cap).toBe(1);
    }
  });

  it("lets the global rule override single fields and the project's yml win over it, per field", () => {
    const config = ui({
      "git-health": {
        daily_cap: 3,
        priority: "medium",
        check: { type: "git", cleanup_after_days: 30 },
        prompts: { review: "UI review" },
      },
    });
    const { rules } = merge({
      ui: config,
      yml: [yml("git-health", { priority: "high", prompts: { fix: "yml fix" } })],
    });
    const rule = rules[0]!;
    expect(rule.def).toMatchObject({
      daily_cap: 3,
      priority: "high",
      check: { type: "git", cleanup_after_days: 30 },
      prompts: { review: "UI review", fix: "yml fix" },
      dedupe_key: "git-health",
    });
    expect(rule.sources).toMatchObject({
      daily_cap: "ui",
      check: "ui",
      "prompts.review": "ui",
      priority: "yml",
      "prompts.fix": "yml",
      trigger: "builtin",
      output: "builtin",
    });
    expect(ymlFieldsOf(rule.sources)).toEqual(["priority", "prompts.fix"]);
    expect(rule.base?.priority).toBe("low");
  });

  it("replaces trigger as a whole instead of merging its parameters", () => {
    const { rules } = merge({
      ui: ui({ "git-health": { trigger: { kind: "time", cron: "0 3 * * *" } } }),
    });
    expect(rules[0]!.def.trigger).toEqual({ kind: "time", cron: "0 3 * * *" });
  });

  it("applies a global rule only to the projects in its scope", () => {
    const config = ui({
      "git-health": { daily_cap: 2, projects: ["p1"] },
      mine: {
        trigger: { kind: "time", cron: "0 3 * * *" },
        check: { type: "git" },
        projects: ["p2"],
      },
      everywhere: {
        trigger: { kind: "time", cron: "0 4 * * *" },
        check: { type: "git" },
        projects: "all",
      },
    });
    const names = (projectId: string) =>
      merge({ ui: config, projectId }).rules.map((r) => r.def.name);
    expect(names("p1")).toEqual(["git-health", "everywhere"]);
    expect(names("p2")).toEqual(["mine", "everywhere"]);
    expect(names("p3")).toEqual(["everywhere"]);
    expect(merge({ ui: config, projectId: "p1" }).rules[0]!.def.daily_cap).toBe(2);
  });

  it("keeps yml-only rules to their own project and a yml override to its own project", () => {
    const config = ui({
      mine: {
        trigger: { kind: "event", path: "logs/a.log", pattern: "ERR" },
        check: { type: "git" },
      },
    });
    const yml1 = [
      yml("mine", { enabled: false }),
      yml("from-file", { trigger: { kind: "time", cron: "0 4 * * *" }, check: { type: "git" } }),
    ];
    const p1 = merge({ ui: config, yml: yml1, projectId: "p1" });
    const p2 = merge({ ui: config, projectId: "p2" });
    expect(p1.errors).toEqual([]);
    const byName = Object.fromEntries(p1.rules.map((r) => [r.def.name, r]));
    expect(byName.mine).toMatchObject({ origin: "custom" });
    expect(byName.mine!.def.enabled).toBe(false);
    expect(byName.mine!.sources.enabled).toBe("yml");
    expect(byName.mine!.sources.trigger).toBe("ui");
    expect(byName["from-file"]).toMatchObject({ origin: "yml" });
    expect(byName["from-file"]!.base).toBeNull();
    // the other project sees neither the override nor the yml-only rule
    expect(p2.rules.map((r) => [r.def.name, r.def.enabled])).toEqual([
      ["git-health", true],
      ["mine", true],
    ]);
  });

  it("applies a yml rule written for the original name to the copy a migration split off", () => {
    const config = ui({
      "git-health": { projects: ["p1"], splitFrom: "git-health" },
      "git-health-2": {
        ...BUILTIN_RULES[0],
        name: undefined,
        daily_cap: 3,
        projects: ["p2"],
        splitFrom: "git-health",
      },
    });
    const { rules, errors } = merge({
      ui: config,
      projectId: "p2",
      yml: [yml("git-health", { priority: "high" })],
    });
    expect(errors).toEqual([]);
    expect(rules.map((r) => [r.def.name, r.def.priority, r.def.daily_cap])).toEqual([
      ["git-health-2", "high", 3],
    ]);
  });

  it("reports a broken global rule once and keeps the others", () => {
    const config = ui({ "git-health": { daily_cap: -1 }, half: { enabled: true } });
    const global = resolveGlobalRules(BUILTIN_RULES, config);
    expect(global.rules.map((r) => r.name)).toEqual(["git-health"]);
    expect(global.rules[0]!.def.daily_cap).toBe(1);
    expect(global.errors.join("\n")).toContain("daily_cap");
    expect(global.errors.join("\n")).toContain("half");
    // per project the same problems are not repeated
    const project = merge({ ui: config });
    expect(project.rules.map((r) => r.def.name)).toEqual(["git-health"]);
    expect(project.errors).toEqual([]);
  });
});

describe("migration of the per-project (v1) configuration", () => {
  const custom = { trigger: { kind: "time", cron: "0 3 * * *" }, check: { type: "git" } };
  const migrate = (projects: Record<string, unknown>, ids = ["p1", "p2", "p3"]) =>
    migrateRulesV1({ projects }, ids, BUILTIN_RULES).rules;

  it("keeps an untouched configuration empty: the built-in rule already applies to all projects", () => {
    expect(migrate({})).toEqual({});
    expect(migrate({ p1: { overrides: {}, custom: {} } })).toEqual({});
    expect(migrateRulesV1(undefined, [], BUILTIN_RULES)).toEqual({ rules: {} });
  });

  it("merges projects with identical fields into one rule and uses scope all when they cover every project", () => {
    const same = { overrides: { "git-health": { daily_cap: 3 } }, custom: { tidy: custom } };
    expect(migrate({ p1: same, p2: same, p3: same })).toEqual({
      "git-health": { daily_cap: 3, projects: "all" },
      tidy: { ...custom, projects: "all" },
    });
    // two of three projects: explicit list; the unmodified third keeps the original name
    expect(migrate({ p1: same, p2: same })).toEqual({
      "git-health": { projects: ["p3"], splitFrom: "git-health" },
      "git-health-2": {
        ...BUILTIN_RULES[0],
        name: undefined,
        daily_cap: 3,
        projects: ["p1", "p2"],
        splitFrom: "git-health",
      },
      tidy: { ...custom, projects: ["p1", "p2"] },
    });
  });

  it("splits a rule configured differently per project into name, name-2, name-3", () => {
    const out = migrate({
      p1: {
        overrides: { "git-health": { daily_cap: 3 } },
        custom: { tidy: { ...custom, daily_cap: 1 } },
      },
      p2: {
        overrides: { "git-health": { daily_cap: 5 } },
        custom: { tidy: { ...custom, daily_cap: 2 } },
      },
      p3: {
        overrides: { "git-health": { daily_cap: 3 } },
        custom: { tidy: { ...custom, daily_cap: 1 } },
      },
    });
    expect(Object.keys(out).sort()).toEqual(["git-health", "git-health-2", "tidy", "tidy-2"]);
    // no project is unmodified: the first group keeps the name (and the built-in default for the rest)
    expect(out["git-health"]).toEqual({
      daily_cap: 3,
      projects: ["p1", "p3"],
      splitFrom: "git-health",
    });
    expect(out["git-health-2"]).toMatchObject({
      daily_cap: 5,
      projects: ["p2"],
      splitFrom: "git-health",
    });
    expect(out["git-health-2"]).toHaveProperty("trigger");
    expect(out.tidy).toMatchObject({ daily_cap: 1, projects: ["p1", "p3"], splitFrom: "tidy" });
    expect(out["tidy-2"]).toMatchObject({ daily_cap: 2, projects: ["p2"], splitFrom: "tidy" });
    // every migrated rule merges into a valid definition
    expect(resolveGlobalRules(BUILTIN_RULES, { rules: out }).errors).toEqual([]);
  });

  it("does not reuse a taken name for a split copy and drops what v2 cannot represent", () => {
    const out = migrate(
      {
        p1: {
          overrides: { ghost: { enabled: false } },
          custom: { tidy: custom, "tidy-2": custom, "git-health": custom },
        },
        p2: { overrides: {}, custom: { tidy: { ...custom, daily_cap: 4 } } },
      },
      ["p1", "p2"],
    );
    expect(out["tidy-2"]).toMatchObject({ projects: ["p1"], ...custom });
    expect(out["tidy-3"]).toMatchObject({ daily_cap: 4, projects: ["p2"], splitFrom: "tidy" });
    expect(out.ghost).toBeUndefined();
    expect(out["git-health"]).toBeUndefined();
  });
});

describe("trigger text and progress", () => {
  const builtin = BUILTIN_RULES[0]!.trigger;
  it("describes the built-in trigger in words", () => {
    expect(describeTrigger(builtin)).toBe(
      "已完成任务累计达到 10 个，或已合并提交累计达到 30 个时触发（任一条件达到即触发，触发后计数清零）。",
    );
    expect(describeTrigger({ kind: "time", cron: "0 3 * * *" })).toContain("0 3 * * *");
    expect(describeTrigger({ kind: "event", path: "logs/crash.log", pattern: "Exception" })).toBe(
      "监视文件「logs/crash.log」，新增的行匹配正则「Exception」时触发。",
    );
  });

  it("computes progress against the thresholds", () => {
    expect(progressText(builtin, { cards: 7, commits: 12 })).toBe(
      "已完成任务 7/10，已合并提交 12/30",
    );
    expect(progressText(builtin, {})).toBe("已完成任务 0/10，已合并提交 0/30");
    expect(progressText({ kind: "workload", tokens: 1000 }, { tokens: 250 })).toBe(
      "已消耗 token 250/1000",
    );
    expect(progressText({ kind: "time", cron: "0 3 * * *" }, { cards: 3 })).toBeNull();
  });

  it("describes checks with their parameters", () => {
    expect(describeCheck({ type: "git", cleanup_after_days: 30, outdated: false })).toContain(
      "超过 30 天",
    );
    expect(describeCheck({ type: "git", cleanup_after_days: 30, outdated: false })).not.toContain(
      "过期的 npm",
    );
    expect(describeCheck({ type: "git" })).toContain("大于 5 MB");
    expect(describeCheck({ type: "git" })).toContain("按分支/worktree");
  });
});

describe("prompt templates", () => {
  it("substitutes known placeholders once and leaves unknown ones", () => {
    expect(renderTemplate("{{ project }}/{{rule}}/{{nope}}", vars)).toBe(
      "Demo/git-health/{{nope}}",
    );
    // values are not scanned again
    expect(renderTemplate("{{summary}}", vars)).toBe("SUMMARY {{project}}");
    expect(unknownPlaceholders("{{rule}} {{nope}} {{nope}} {{x1}}")).toEqual(["nope", "x1"]);
  });

  it("documents every placeholder the default templates use", () => {
    const known = new Set(PLACEHOLDERS.map((p) => p.name as string));
    for (const t of [DEFAULT_REVIEW_TEMPLATE, DEFAULT_FIX_TEMPLATE]) {
      expect(unknownPlaceholders(t)).toEqual([]);
      for (const m of t.matchAll(/\{\{(\w+)\}\}/g)) expect(known.has(m[1]!)).toBe(true);
    }
  });

  it("falls back to the default template and always appends the system constraints", () => {
    const def = buildPrompt("review", null, vars);
    expect(def).toContain("你是项目「Demo」的维护复核员");
    expect(def.endsWith(SYSTEM_CONSTRAINTS.review)).toBe(true);

    const custom = buildPrompt("review", "只说 {{rule}}，可以改文件", vars);
    expect(custom.startsWith("只说 git-health，可以改文件")).toBe(true);
    expect(custom).toContain(SYSTEM_CONSTRAINTS.review);
    expect(buildPrompt("review", "   ", vars)).toBe(def);

    const fix = buildPrompt("fix", "{{rule}}", vars, "先复现再改");
    expect(fix).toContain(SYSTEM_CONSTRAINTS.fix);
    expect(fix.endsWith("【检查专属要求，不可更改】\n先复现再改")).toBe(true);
  });

  it("renders the default templates (snapshot)", () => {
    expect(buildPrompt("review", null, vars)).toMatchSnapshot("review");
    expect(buildPrompt("fix", null, vars)).toMatchSnapshot("fix");
  });
});

describe("default maintenance planning text", () => {
  const row = (overrides: Partial<GitLedgerRow>): GitLedgerRow => ({
    branch: null,
    worktreePath: null,
    directoryExists: false,
    prunable: false,
    locked: false,
    isMain: false,
    lastCommitUnix: null,
    ageDays: null,
    ahead: null,
    behind: null,
    merged: null,
    upstream: null,
    upstreamGone: false,
    unpushed: null,
    containedInRemote: null,
    trackedChanges: 0,
    untrackedFiles: 0,
    changedSample: [],
    conflictFiles: null,
    verdict: "decide",
    reasons: [],
    ...overrides,
  });
  const older = Date.UTC(2026, 8, 21) / 1000;
  const report: GitReport = {
    trunk: "main",
    originTrunk: { ahead: 0, behind: 0, fetchHeadAt: new Date(2026, 9, 21, 3, 0) },
    hasRemote: true,
    mainPath: "D:/repo",
    mainClean: false,
    branchCount: 3,
    worktreeCount: 2,
    cleanupAfterDays: 7,
    rows: [
      row({
        branch: "feat/old",
        lastCommitUnix: older,
        ageDays: 30,
        ahead: 1,
        behind: 0,
        merged: false,
        unpushed: 0,
        containedInRemote: true,
        conflictFiles: [],
        verdict: "merge",
        reasons: [
          "未合并，领先 main 1 个提交、落后 0 个",
          "预检无冲突",
          "没有 worktree",
          "最近提交在 30 天前（超过 7 天）",
        ],
      }),
      row({
        branch: "feat/finished",
        worktreePath: "D:/repo-wt",
        directoryExists: true,
        lastCommitUnix: older,
        ageDays: 30,
        ahead: 0,
        behind: 0,
        merged: true,
        upstream: "origin/feat/finished",
        unpushed: 0,
        containedInRemote: true,
        verdict: "cleanup",
        reasons: [
          "已合并进 main",
          "worktree 干净",
          "没有未推送或未被远端包含的独有提交",
          "最近提交在 30 天前（超过 7 天）",
        ],
      }),
      row({
        branch: "main",
        worktreePath: "D:/repo",
        directoryExists: true,
        isMain: true,
        merged: true,
        ahead: 0,
        behind: 0,
        trackedChanges: 1,
        changedSample: ["dirty.txt"],
        verdict: "decide",
        reasons: ["主工作区有未提交改动（1 个已跟踪改动：dirty.txt）"],
      }),
    ],
    largeFiles: [],
    largeFileMb: 5,
    outdated: null,
    notes: ["未检查过期依赖。"],
  };
  const ctx = (reason: string) => ({
    rule: { name: "git-health" } as never,
    project: { name: "Demo" } as never,
    trigger: { reason },
  });

  it("orders the plan from current state to ledger, advice and safe cleanup (snapshot)", () => {
    const out = renderGitOutput(ctx("已完成任务 10 个，达到阈值 10"), report);
    expect(out.title).toBe("Git 体检：1 可清理、1 建议合并、1 需决定");
    for (const heading of [
      "当前 git 状况",
      "分支与 worktree 台账（全部 3 个对象）",
      "建议合并（1）",
      "建议清理（1）",
      "需你决定（1）",
      "保留（0）",
      "执行步骤与安全清理要求",
    ]) {
      expect(out.body).toContain(`## ${heading}`);
    }
    expect(out.body).toMatchSnapshot("body");
    expect(out.acceptance).toMatchSnapshot("acceptance");
  });

  it("words a manual run differently", () => {
    const out = renderGitOutput(ctx("手动触发"), report);
    expect(out.body).toContain("你在维护页点击了「立即运行」");
    expect(out.body).not.toContain("触发原因：手动触发");
  });
});

describe("engine: one global rule, run per project", () => {
  const dirty = (repo: string) => {
    sh(repo, ["branch", "feat/finished"]);
    writeFileSync(join(repo, "dirty.txt"), "dirty\n");
  };
  const rowOf = (h: Harness, projectId: string, name = "git-health") =>
    h.engine.status().rules.find((r) => r.rule.projectId === projectId && r.rule.name === name)!;

  it("applies a UI threshold, a custom review prompt and the new reason wording", async () => {
    let ui: RulesConfig = { rules: {} };
    const h = setup({ engine: { uiRules: () => ui } });
    dirty(h.repo);
    ui = {
      rules: {
        "git-health": {
          trigger: { kind: "workload", cards_done: 2 },
          agent: "claude/sonnet",
          prompts: { review: "规则 {{rule}}：{{trigger_reason}}" },
        },
      },
    };
    await h.engine.tick();
    expect(h.engine.listRules(h.project.id)[0]).toMatchObject({
      triggerKind: "workload",
      agent: "claude/sonnet",
    });
    h.complete(1);
    h.clock.advance(60_000);
    await h.engine.tick();
    expect(h.maintenanceTasks()).toHaveLength(0);
    h.complete(1);
    h.clock.advance(60_000);
    await h.engine.tick();

    expect(h.maintenanceTasks()).toHaveLength(1);
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]!.startsWith("规则 git-health：已完成任务 2 个，达到阈值 2")).toBe(true);
    expect(h.prompts[0]).toContain(SYSTEM_CONSTRAINTS.review);
    const status = h.engine.status().rules[0]!;
    expect(status).toMatchObject({ origin: "builtin", progressText: "已完成任务 0/2" });
    expect(status.sources).toMatchObject({ trigger: "ui", agent: "ui", output: "builtin" });
  });

  it("expands a rule over its projects with independent progress, runs and daily caps", async () => {
    const ui: RulesConfig = {
      rules: { "git-health": { trigger: { kind: "workload", cards_done: 2 }, projects: "all" } },
    };
    const h = setup({ engine: { uiRules: () => ui } });
    const p2 = addProject(h, "Other", "OTH");
    dirty(h.repo);
    dirty(p2.repo);
    await h.engine.tick();
    expect(h.engine.listRules().map((r) => [r.projectId, r.name])).toEqual(
      [
        [h.project.id, "git-health"],
        [p2.project.id, "git-health"],
      ].sort((a, b) => a[0]!.localeCompare(b[0]!)),
    );

    h.complete(2);
    h.clock.advance(60_000);
    await h.engine.tick();
    expect(h.maintenanceTasks()).toHaveLength(1);
    expect(rowOf(h, h.project.id)).toMatchObject({
      runsToday: 1,
      blocked: "daily_cap",
      progressText: "已完成任务 0/2",
    });
    // the other project is untouched: no run, its own counter
    expect(rowOf(h, p2.project.id)).toMatchObject({
      runsToday: 0,
      blocked: null,
      lastRun: null,
      progressText: "已完成任务 0/2",
    });
    complete(h, p2.project, 1);
    h.clock.advance(60_000);
    await h.engine.tick();
    expect(rowOf(h, p2.project.id)).toMatchObject({ runsToday: 0, progressText: "已完成任务 1/2" });
    complete(h, p2.project, 1);
    h.clock.advance(60_000);
    await h.engine.tick();
    expect(rowOf(h, p2.project.id)).toMatchObject({ runsToday: 1 });
    expect(rowOf(h, p2.project.id).lastRun).not.toBeNull();
  });

  it("runs only the projects in the scope and disables (never deletes) the row of a removed project", async () => {
    let ui: RulesConfig = {
      rules: {
        "git-health": { trigger: { kind: "workload", cards_done: 2 } },
        tidy: {
          trigger: { kind: "time", cron: "0 3 * * *" },
          check: { type: "git" },
          projects: "all",
        },
      },
    };
    const h = setup({ engine: { uiRules: () => ui } });
    const p2 = addProject(h, "Other", "OTH");
    await h.engine.tick();
    expect(h.engine.listRules(p2.project.id).map((r) => [r.name, r.enabled])).toEqual([
      ["git-health", true],
      ["tidy", true],
    ]);
    complete(h, p2.project, 1);
    h.clock.advance(60_000);
    await h.engine.tick();
    const before = rowOf(h, p2.project.id);
    expect(before.progressText).toBe("已完成任务 1/2");

    // remove the project from both rules
    ui = {
      rules: {
        "git-health": { trigger: { kind: "workload", cards_done: 2 }, projects: [h.project.id] },
        tidy: {
          trigger: { kind: "time", cron: "0 3 * * *" },
          check: { type: "git" },
          projects: [h.project.id],
        },
      },
    };
    await h.engine.tick();
    for (const name of ["git-health", "tidy"]) {
      const row = rowOf(h, p2.project.id, name);
      expect(row.rule.enabled).toBe(false);
      expect(row.defined).toBe(false);
      expect(rowOf(h, h.project.id, name).rule.enabled).toBe(true);
    }
    // the removed row stays in the table with its counters, and a manual run by name skips it
    expect(h.engine.listRules(p2.project.id)).toHaveLength(2);
    expect(rowOf(h, p2.project.id).counters).toMatchObject({ cards: 1 });
    await expect(h.engine.runRuleNow("git-health", p2.project.id)).rejects.toThrow("不适用于");

    // scope back: the same row is enabled again with its old progress
    ui = { rules: { ...ui.rules, "git-health": { trigger: { kind: "workload", cards_done: 2 } } } };
    await h.engine.tick();
    expect(rowOf(h, p2.project.id)).toMatchObject({
      rule: { enabled: true },
      progressText: "已完成任务 1/2",
    });
  });

  it("lets a project's maintenance.yml override only that project", async () => {
    const yml = `rules:
  - name: git-health
    daily_cap: 5
    priority: high
`;
    const h = setup({
      yml,
      engine: {
        uiRules: () => ({ rules: { "git-health": { daily_cap: 2, priority: "medium" } } }),
      },
    });
    const p2 = addProject(h, "Other", "OTH");
    await h.engine.tick();
    const mine = rowOf(h, h.project.id);
    const other = rowOf(h, p2.project.id);
    expect(mine.rule).toMatchObject({ dailyCap: 5, priority: "high" });
    expect(mine.ymlFields).toEqual(["priority", "daily_cap"]);
    expect(other.rule).toMatchObject({ dailyCap: 2, priority: "medium" });
    expect(other.ymlFields).toEqual([]);
    // the global rule (what the editor shows) is unaffected by any yml
    const global = h.engine.status().rulesGlobal.find((g) => g.name === "git-health")!;
    expect(global.def).toMatchObject({ daily_cap: 2, priority: "medium" });

    // a rule only defined in one project's yml stays in that project
    const h2 = setup({
      yml: "rules:\n  - name: only-here\n    trigger: { kind: time, cron: '0 4 * * *' }\n    check: { type: git }\n",
    });
    const q2 = addProject(h2, "Other", "OTH");
    await h2.engine.tick();
    expect(h2.engine.listRules(h2.project.id).map((r) => r.name)).toEqual([
      "git-health",
      "only-here",
    ]);
    expect(h2.engine.listRules(q2.project.id).map((r) => r.name)).toEqual(["git-health"]);
    expect(rowOf(h2, h2.project.id, "only-here").origin).toBe("yml");
  });

  it("runs now for one chosen project or for every applicable project", async () => {
    const h = setup({
      engine: { uiRules: () => ({ rules: { "git-health": { projects: "all" } } }) },
    });
    const p2 = addProject(h, "Other", "OTH");
    const p3 = addProject(h, "Third", "THI");
    await h.engine.tick();
    const only = await h.engine.runRuleNow("git-health", p2.project.id);
    expect(only.map((r) => [r.projectId, r.outcome.status])).toEqual([[p2.project.id, "fired"]]);
    expect(rowOf(h, p2.project.id).lastRun).not.toBeNull();
    expect(rowOf(h, h.project.id).lastRun).toBeNull();
    expect(rowOf(h, p3.project.id).lastRun).toBeNull();

    const every = await h.engine.runRuleNow("git-health");
    expect(every.map((r) => r.projectId).sort()).toEqual(
      [h.project.id, p2.project.id, p3.project.id].sort(),
    );
    expect(every.every((r) => r.outcome.status === "fired")).toBe(true);
    expect(rowOf(h, h.project.id).lastRun).not.toBeNull();
    expect(rowOf(h, p3.project.id).lastRun).not.toBeNull();
    // the single-row API still works
    const one = await h.engine.runNow(`${p3.project.id}:git-health`);
    expect(one.status).toBe("fired");
  });
});
