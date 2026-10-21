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
import { mergeRuleLayers, type FieldKey, type FieldSource, type RulesConfig } from "../shared/rules";

const builtin = BUILTIN_RULES[0]!;
const allBuiltin = (over: Partial<Record<FieldKey, FieldSource>> = {}) =>
  ({
    enabled: "builtin",
    trigger: "builtin",
    check: "builtin",
    agent: "builtin",
    output: "builtin",
    priority: "builtin",
    dedupe_key: "builtin",
    daily_cap: "builtin",
    "prompts.review": "builtin",
    "prompts.fix": "builtin",
    ...over,
  }) as Record<FieldKey, FieldSource>;
const target = (over: Partial<Record<FieldKey, FieldSource>> = {}) => ({
  projectId: "p1",
  name: "git-health",
  origin: "builtin" as const,
  sources: allBuiltin(over),
  base: builtin,
});
const empty: RulesConfig = { projects: {} };

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
          lastRun: { status: "done", triggeredAt: "2026-10-01T03:00:00.000Z", cardIds: ["c1"], findings: [] },
          blocked: "paused",
          projectName: "Demo",
          origin: "builtin",
          sources: { trigger: "ui", priority: "yml" },
          triggerText: "x",
          progressText: "已完成卡片 4/10",
          prompts: { review: "R", fix: null },
        },
        { rule: { id: "gone", name: "gone" }, defined: false },
      ],
      configErrors: { p1: ["bad yaml"] },
      projects: [{ id: "p1", name: "Demo" }],
      presets: [{ id: "x", name: "Sonnet", spec: "claude/sonnet" }],
    });
    expect(view.rules).toHaveLength(1);
    expect(view.rules[0]).toMatchObject({
      name: "git-health",
      projectName: "Demo",
      origin: "builtin",
      paused: true,
      blocked: "paused",
      counters: { cards: 4 },
      progressText: "已完成卡片 4/10",
      lastRun: { status: "done", cards: 1 },
    });
    expect(view.rules[0]!.sources).toMatchObject({ trigger: "ui", priority: "yml", agent: "builtin" });
    expect(view.rules[0]!.def).toMatchObject({
      trigger: { kind: "workload", cards_done: 10 },
      prompts: { review: "R", fix: null },
    });
    expect(view.configErrors).toEqual([{ project: "p1", errors: ["bad yaml"] }]);
    expect(view.projects).toEqual([{ id: "p1", name: "Demo" }]);
    expect(parseStatus(null)).toEqual({ rules: [], configErrors: [], projects: [], presets: [] });
  });

  it("words the last run", () => {
    expect(lastRunText(null)).toBe("从未运行");
    const run = { status: "done", at: "2026-10-21T03:00:12.000Z", finishedAt: "", cards: 1, error: null };
    expect(lastRunText(run)).toBe("2026-10-21 03:00 · 完成 · 生成或更新了 1 张卡");
    expect(lastRunText({ ...run, cards: 0 })).toContain("没有发现需要处理的问题");
    expect(lastRunText({ ...run, status: "failed", error: "boom" })).toBe("2026-10-21 03:00 · 失败 · 原因：boom");
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
    const errs = (patch: Partial<typeof base>) => draftToFields({ ...base, ...patch }).errors.join("|");
    expect(errs({ cardsDone: "", commitsMerged: "" })).toContain("至少要填一个阈值");
    expect(errs({ cardsDone: "abc" })).toContain("正整数");
    expect(errs({ triggerKind: "time", cron: "0 3 *" })).toContain("5 段");
    expect(errs({ triggerKind: "event", eventPath: "", eventPattern: "(" })).toContain("文件路径");
    expect(errs({ triggerKind: "event", eventPath: "a.log", eventPattern: "(" })).toContain("正则");
    expect(errs({ dailyCap: "-1" })).toContain("每日上限");
    expect(errs({ checkExtra: "[1]" })).toContain("JSON");
    expect(errs({ staleDays: "0" })).toContain("大于 0");
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
      staleDays: "30",
      agent: "claude/sonnet",
      reviewPrompt: "自定义 {{rule}}",
    };
    const { fields } = draftToFields(draft);
    const config = applyRuleEdit(empty, target(), fields!);
    expect(config.projects.p1!.overrides["git-health"]).toEqual({
      trigger: { kind: "workload", cards_done: 3, commits_merged: 30 },
      check: { type: "git", stale_days: 30 },
      agent: "claude/sonnet",
      prompts: { review: "自定义 {{rule}}" },
    });
    const merged = mergeRuleLayers({ builtin: BUILTIN_RULES, ui: config.projects.p1 });
    expect(merged.errors).toEqual([]);
    expect(merged.rules[0]!.def).toMatchObject({
      agent: "claude/sonnet",
      prompts: { review: "自定义 {{rule}}" },
    });

    // restoring the defaults removes the entry again
    const restored = applyRuleEdit(
      config,
      target({ trigger: "ui", check: "ui", agent: "ui", "prompts.review": "ui" }),
      draftToFields(draftFromDef(builtin)).fields!,
    );
    expect(restored.projects.p1!.overrides).toEqual({});
  });

  it("never writes fields that maintenance.yml supplies", () => {
    const draft = { ...draftFromDef(builtin), priority: "high", dailyCap: "4" };
    const config = applyRuleEdit(empty, target({ priority: "yml" }), draftToFields(draft).fields!);
    expect(config.projects.p1!.overrides["git-health"]).toEqual({ daily_cap: 4 });
  });

  it("creates and removes custom rules without touching others", () => {
    const fields = draftToFields({ ...draftFromDef(emptyDef("x")), cardsDone: "5" }).fields!;
    expect(addCustomRule(empty, "p1", " ", [], fields).error).toContain("不能为空");
    expect(addCustomRule(empty, "p1", "git-health", ["git-health"], fields).error).toContain("已有");
    const added = addCustomRule(empty, "p1", "tidy", ["git-health"], fields);
    expect(added.error).toBeUndefined();
    const merged = mergeRuleLayers({ builtin: BUILTIN_RULES, ui: added.config.projects.p1 });
    expect(merged.errors).toEqual([]);
    expect(merged.rules.map((r) => [r.def.name, r.origin])).toEqual([
      ["git-health", "builtin"],
      ["tidy", "custom"],
    ]);

    const edited = applyRuleEdit(
      added.config,
      { projectId: "p1", name: "tidy", origin: "custom", sources: allBuiltin({ trigger: "ui" }), base: null },
      draftToFields({ ...draftFromDef(merged.rules[1]!.def), dailyCap: "7" }).fields!,
    );
    expect(edited.projects.p1!.custom.tidy).toMatchObject({ daily_cap: 7 });

    const removed = removeCustomRule(edited, "p1", "tidy");
    expect(removed.projects.p1!.custom).toEqual({});
  });
});
