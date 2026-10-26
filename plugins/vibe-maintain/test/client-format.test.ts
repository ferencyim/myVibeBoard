import { describe, expect, it } from "vitest";
import {
  addCustomRule,
  applyRuleEdit,
  draftFromDef,
  draftToFields,
  emptyDef,
  removeCustomRule,
} from "../client/edit";
import { lastRunText, parseStatus } from "../client/format";
import { BUILTIN_RULES } from "../server/config";
import { mergeRuleLayers, resolveGlobalRules, type RulesConfig } from "../shared/rules";

const builtin = BUILTIN_RULES[0]!;
const target = { name: "git-health", origin: "builtin" as const, base: builtin };
const empty: RulesConfig = { rules: {} };

describe("maintenance screen helpers", () => {
  it("reads the loose status record", () => {
    const view = parseStatus({
      rules: [
        {
          rule: {
            id: "r1",
            name: "git-health",
            projectId: "p1",
            triggerKind: "workload",
            trigger: { kind: "workload", cards_done: 10 },
            check: { type: "git" },
            outputMode: "suggest",
            agent: null,
            priority: "low",
            dailyCap: 1,
            enabled: true,
            pausedAt: "2026-10-01T00:00:00Z",
          },
          counters: { cards: 4 },
          runsToday: 1,
          lastRun: {
            status: "done",
            triggeredAt: "2026-10-01T03:00:00.000Z",
            workspaceIds: ["c1"],
            findings: [],
          },
          blocked: "paused",
          ymlFields: ["priority", "bogus"],
          projectName: "Demo",
          origin: "builtin",
          sources: { trigger: "ui", priority: "yml" },
          triggerText: "x",
          progressText: "已完成卡片 4/10",
          prompts: { review: "R", fix: null },
        },
        { rule: { id: "gone", name: "gone" }, defined: false },
        {
          rule: {
            id: "p1:only",
            name: "only",
            projectId: "p1",
            triggerKind: "time",
            trigger: { cron: "0 4 * * *" },
            check: { type: "git" },
          },
          origin: "yml",
          projectName: "Demo",
        },
      ],
      rulesGlobal: [
        {
          name: "git-health",
          origin: "builtin",
          def: { ...builtin, prompts: { review: "R" } },
          sources: { trigger: "ui" },
          base: builtin,
          scope: ["p1", "p2"],
          splitFrom: "git-health",
        },
        {
          name: "idle",
          origin: "custom",
          def: { ...builtin, name: "idle" },
          sources: {},
          scope: [],
        },
      ],
      configErrors: { p1: ["bad yaml"] },
      projects: [{ id: "p1", name: "Demo" }],
      presets: [{ id: "x", name: "Sonnet", spec: "claude/sonnet" }],
    });
    // global rules come first (also the one that applies nowhere), then each project's yml-only rule
    expect(view.groups.map((g) => [g.key, g.readOnly, g.rows.length])).toEqual([
      ["git-health", false, 1],
      ["idle", false, 0],
      ["p1:only", true, 1],
    ]);
    expect(view.groups[0]).toMatchObject({
      scope: ["p1", "p2"],
      splitFrom: "git-health",
      origin: "builtin",
    });
    expect(view.groups[0]!.def.prompts.review).toBe("R");
    expect(view.groups[0]!.sources).toMatchObject({ trigger: "ui", priority: "builtin" });
    expect(view.groups[1]!.scope).toEqual([]);
    expect(view.groups[2]!.sources.trigger).toBe("yml");
    const row = view.groups[0]!.rows[0]!;
    expect(row.ymlFields).toEqual(["priority"]);
    expect(row).toMatchObject({
      name: "git-health",
      projectName: "Demo",
      origin: "builtin",
      paused: true,
      blocked: "paused",
      counters: { cards: 4 },
      progressText: "已完成卡片 4/10",
      lastRun: { status: "done", tasks: 1 },
    });
    expect(row.sources).toMatchObject({ trigger: "ui", priority: "yml", agent: "builtin" });
    expect(row.def).toMatchObject({
      trigger: { kind: "workload", cards_done: 10 },
      prompts: { review: "R", fix: null },
    });
    expect(view.configErrors).toEqual([{ project: "p1", errors: ["bad yaml"] }]);
    expect(view.projects).toEqual([{ id: "p1", name: "Demo" }]);
    expect(parseStatus(null)).toEqual({ groups: [], configErrors: [], projects: [], presets: [] });
  });

  it("words the last run", () => {
    expect(lastRunText(null)).toBe("从未运行");
    const run = {
      status: "done",
      at: "2026-10-21T03:00:12.000Z",
      finishedAt: "",
      tasks: 1,
      error: null,
    };
    expect(lastRunText(run)).toBe("2026-10-21 03:00 · 完成 · 生成或更新了 1 个任务");
    expect(lastRunText({ ...run, tasks: 0 })).toContain("没有发现需要处理的问题");
    expect(lastRunText({ ...run, status: "failed", error: "boom" })).toBe(
      "2026-10-21 03:00 · 失败 · 原因：boom",
    );
  });
});

describe("rule editor logic", () => {
  it("round-trips the built-in rule through the form", () => {
    const draft = draftFromDef(builtin);
    expect(draft).toMatchObject({
      triggerKind: "workload",
      cardsDone: "10",
      commitsMerged: "30",
      checkType: "git",
      dailyCap: "1",
    });
    const { fields, errors } = draftToFields(draft);
    expect(errors).toEqual([]);
    expect(fields).toMatchObject({
      trigger: { kind: "workload", cards_done: 10, commits_merged: 30 },
      check: { type: "git" },
      agent: null,
      output: "suggest",
      daily_cap: 1,
      dedupe_key: "git-health",
      prompts: {},
    });
  });

  it("validates trigger, cron, regex, cap and check JSON in Chinese", () => {
    const base = draftFromDef(builtin);
    const errs = (patch: Partial<typeof base>) =>
      draftToFields({ ...base, ...patch }).errors.join("|");
    expect(errs({ cardsDone: "", commitsMerged: "" })).toContain("至少要填一个阈值");
    expect(errs({ cardsDone: "abc" })).toContain("正整数");
    expect(errs({ triggerKind: "time", cron: "0 3 *" })).toContain("5 段");
    expect(errs({ triggerKind: "event", eventPath: "", eventPattern: "(" })).toContain("文件路径");
    expect(errs({ triggerKind: "event", eventPath: "a.log", eventPattern: "(" })).toContain("正则");
    expect(errs({ dailyCap: "-1" })).toContain("每日上限");
    expect(errs({ checkExtra: "[1]" })).toContain("JSON");
    expect(errs({ cleanupAfterDays: "0" })).toContain("大于 0");
  });

  it("warns about unknown placeholders without blocking the save", () => {
    const r = draftToFields({ ...draftFromDef(builtin), reviewPrompt: "看看 {{rulee}}" });
    expect(r.errors).toEqual([]);
    expect(r.warnings.join()).toContain("{{rulee}}");
  });

  it("stores only differences from the built-in default and merges back to the edited rule", () => {
    const draft = {
      ...draftFromDef(builtin),
      cardsDone: "3",
      cleanupAfterDays: "30",
      agent: "claude/sonnet",
      reviewPrompt: "自定义 {{rule}}",
    };
    const { fields } = draftToFields(draft);
    const config = applyRuleEdit(empty, target, fields!, "all");
    expect(config.rules["git-health"]).toEqual({
      trigger: { kind: "workload", cards_done: 3, commits_merged: 30 },
      check: { type: "git", cleanup_after_days: 30 },
      agent: "claude/sonnet",
      prompts: { review: "自定义 {{rule}}" },
      projects: "all",
    });
    const merged = mergeRuleLayers({ builtin: BUILTIN_RULES, ui: config, projectId: "p1" });
    expect(merged.errors).toEqual([]);
    expect(merged.rules[0]!.def).toMatchObject({
      agent: "claude/sonnet",
      prompts: { review: "自定义 {{rule}}" },
    });

    // restoring the defaults for all projects removes the entry again
    const restored = applyRuleEdit(
      config,
      target,
      draftToFields(draftFromDef(builtin)).fields!,
      "all",
    );
    expect(restored.rules).toEqual({});
  });

  it("keeps a built-in rule's project scope even when every field is the default", () => {
    const fields = draftToFields(draftFromDef(builtin)).fields!;
    const config = applyRuleEdit(empty, target, fields, ["p1"]);
    expect(config.rules["git-health"]).toEqual({ projects: ["p1"] });
    expect(mergeRuleLayers({ builtin: BUILTIN_RULES, ui: config, projectId: "p2" }).rules).toEqual(
      [],
    );
    expect(
      mergeRuleLayers({ builtin: BUILTIN_RULES, ui: config, projectId: "p1" }).rules,
    ).toHaveLength(1);
  });

  it("keeps the migration marker when a split rule is edited", () => {
    const start: RulesConfig = {
      rules: { "git-health": { projects: ["p1"], splitFrom: "git-health" } },
    };
    const draft = { ...draftFromDef(builtin), dailyCap: "4" };
    const config = applyRuleEdit(start, target, draftToFields(draft).fields!, ["p1", "p2"]);
    expect(config.rules["git-health"]).toEqual({
      daily_cap: 4,
      projects: ["p1", "p2"],
      splitFrom: "git-health",
    });
  });

  it("creates and removes custom rules without touching others", () => {
    const fields = draftToFields({ ...draftFromDef(emptyDef("x")), cardsDone: "5" }).fields!;
    expect(addCustomRule(empty, " ", [], fields, "all").error).toContain("不能为空");
    expect(addCustomRule(empty, "git-health", ["git-health"], fields, "all").error).toContain(
      "已有",
    );
    const added = addCustomRule(empty, "tidy", ["git-health"], fields, ["p1"]);
    expect(added.error).toBeUndefined();
    const global = resolveGlobalRules(BUILTIN_RULES, added.config);
    expect(global.errors).toEqual([]);
    expect(global.rules.map((r) => [r.name, r.origin, r.scope])).toEqual([
      ["git-health", "builtin", "all"],
      ["tidy", "custom", ["p1"]],
    ]);

    const edited = applyRuleEdit(
      added.config,
      { name: "tidy", origin: "custom", base: null },
      draftToFields({ ...draftFromDef(global.rules[1]!.def), dailyCap: "7" }).fields!,
      "all",
    );
    expect(edited.rules.tidy).toMatchObject({ daily_cap: 7, projects: "all" });

    expect(removeCustomRule(edited, "tidy").rules).toEqual({});
  });

  it("round-trips a disabled rule and a project list through the stored table", () => {
    const draft = { ...draftFromDef(builtin), enabled: false };
    const config = applyRuleEdit(empty, target, draftToFields(draft).fields!, ["p1", "p2"]);
    expect(config.rules["git-health"]).toEqual({ enabled: false, projects: ["p1", "p2"] });
    const g = resolveGlobalRules(BUILTIN_RULES, JSON.parse(JSON.stringify(config)) as RulesConfig);
    expect(g.errors).toEqual([]);
    expect(g.rules[0]).toMatchObject({ scope: ["p1", "p2"], def: { enabled: false } });
    expect(draftFromDef(g.rules[0]!.def).enabled).toBe(false);
  });
});
