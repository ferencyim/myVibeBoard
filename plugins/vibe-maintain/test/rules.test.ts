import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILTIN_RULES } from "../server/config";
import { renderGitOutput } from "../server/git/check";
import type { Finding } from "../server/types";
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
  progressText,
  type YmlRule,
} from "../shared/rules";
import { setup, sh } from "./helpers";

const vars: PromptVars = {
  project: "Demo",
  rule: "git-health",
  trigger_reason: "已完成卡片 10 张，达到阈值 10",
  check_description: "Git 体检",
  card_title: "Git 体检：发现 2 项待整理",
  summary: "SUMMARY {{project}}",
  findings_json: '[{"a":1}]',
  findings_count: "1",
  date: "2026-10-21",
};

describe("rule layers: built-in < UI < maintenance.yml", () => {
  const yml = (name: string, fields: YmlRule["fields"]): YmlRule => ({ name, fields });

  it("uses the built-in rule as is and marks every field builtin", () => {
    const { rules, errors } = mergeRuleLayers({ builtin: BUILTIN_RULES });
    expect(errors).toEqual([]);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.origin).toBe("builtin");
    expect(Object.values(rules[0]!.sources).every((s) => s === "builtin")).toBe(true);
    expect(rules[0]!.def.daily_cap).toBe(1);
  });

  it("lets the UI override single fields and yml win over the UI, per field", () => {
    const { rules } = mergeRuleLayers({
      builtin: BUILTIN_RULES,
      ui: {
        overrides: {
          "git-health": {
            daily_cap: 3,
            priority: "medium",
            check: { type: "git", stale_days: 30 },
            prompts: { review: "UI review" },
          },
        },
        custom: {},
      },
      yml: [yml("git-health", { priority: "high", prompts: { fix: "yml fix" } })],
    });
    const rule = rules[0]!;
    expect(rule.def).toMatchObject({
      daily_cap: 3,
      priority: "high",
      check: { type: "git", stale_days: 30 },
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
    expect(rule.base?.priority).toBe("low");
  });

  it("replaces trigger as a whole instead of merging its parameters", () => {
    const { rules } = mergeRuleLayers({
      builtin: BUILTIN_RULES,
      ui: { overrides: { "git-health": { trigger: { kind: "time", cron: "0 3 * * *" } } }, custom: {} },
    });
    expect(rules[0]!.def.trigger).toEqual({ kind: "time", cron: "0 3 * * *" });
  });

  it("builds custom UI rules and yml-only rules with the right origin", () => {
    const { rules, errors } = mergeRuleLayers({
      builtin: BUILTIN_RULES,
      ui: {
        overrides: {},
        custom: {
          mine: { trigger: { kind: "event", path: "logs/a.log", pattern: "ERR" }, check: { type: "git" } },
        },
      },
      yml: [
        yml("mine", { enabled: false }),
        yml("from-file", { trigger: { kind: "time", cron: "0 4 * * *" }, check: { type: "git" } }),
      ],
    });
    expect(errors).toEqual([]);
    const byName = Object.fromEntries(rules.map((r) => [r.def.name, r]));
    expect(byName.mine).toMatchObject({ origin: "custom" });
    expect(byName.mine!.def.enabled).toBe(false);
    expect(byName.mine!.sources.enabled).toBe("yml");
    expect(byName.mine!.sources.trigger).toBe("ui");
    expect(byName["from-file"]).toMatchObject({ origin: "yml" });
    expect(byName["from-file"]!.sources.trigger).toBe("yml");
    expect(byName["from-file"]!.base).toBeNull();
  });

  it("drops incomplete or invalid rules with an error and keeps the others", () => {
    const { rules, errors } = mergeRuleLayers({
      builtin: BUILTIN_RULES,
      ui: { overrides: { "git-health": { daily_cap: -1 } }, custom: { half: { enabled: true } } },
    });
    expect(rules.map((r) => r.def.name)).toEqual(["git-health"]);
    expect(rules[0]!.def.daily_cap).toBe(1);
    expect(errors.join("\n")).toContain("daily_cap");
    expect(errors.join("\n")).toContain("half");
  });
});

describe("trigger text and progress", () => {
  const builtin = BUILTIN_RULES[0]!.trigger;
  it("describes the built-in trigger in words", () => {
    expect(describeTrigger(builtin)).toBe(
      "已完成卡片累计达到 10 张，或已合并提交累计达到 30 个时触发（任一条件达到即触发，触发后计数清零）。",
    );
    expect(describeTrigger({ kind: "time", cron: "0 3 * * *" })).toContain("0 3 * * *");
    expect(describeTrigger({ kind: "event", path: "logs/crash.log", pattern: "Exception" })).toBe(
      "监视文件「logs/crash.log」，新增的行匹配正则「Exception」时触发。",
    );
  });

  it("computes progress against the thresholds", () => {
    expect(progressText(builtin, { cards: 7, commits: 12 })).toBe("已完成卡片 7/10，已合并提交 12/30");
    expect(progressText(builtin, {})).toBe("已完成卡片 0/10，已合并提交 0/30");
    expect(progressText({ kind: "workload", tokens: 1000 }, { tokens: 250 })).toBe("已消耗 token 250/1000");
    expect(progressText({ kind: "time", cron: "0 3 * * *" }, { cards: 3 })).toBeNull();
  });

  it("describes checks with their parameters", () => {
    expect(describeCheck({ type: "git", stale_days: 30, outdated: false })).toContain("超过 30 天");
    expect(describeCheck({ type: "git", stale_days: 30, outdated: false })).not.toContain("过期的 npm");
    expect(describeCheck({ type: "git" })).toContain("大于 5 MB");
  });
});

describe("prompt templates", () => {
  it("substitutes known placeholders once and leaves unknown ones", () => {
    expect(renderTemplate("{{ project }}/{{rule}}/{{nope}}", vars)).toBe("Demo/git-health/{{nope}}");
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

describe("default draft card text", () => {
  const findings: Finding[] = [
    { category: "stale_branch", subject: "feat/old", detail: "领先 main 1 个提交，最后提交于 30 天前" },
    { category: "merged_branch", subject: "feat/finished", detail: "已合并进 main，可以删除" },
    { category: "uncommitted", subject: "主工作区", detail: "1 个文件有未提交改动：dirty.txt" },
  ];
  const ctx = (reason: string) => ({
    rule: { name: "git-health" } as never,
    project: { name: "Demo" } as never,
    trigger: { reason },
  });

  it("explains which rule fired, why, what was found, impact, advice and verification (snapshot)", () => {
    const out = renderGitOutput(ctx("已完成卡片 10 张，达到阈值 10"), findings, ["未检查过期依赖。"], {
      maxPerCategory: 15,
    });
    expect(out.title).toBe("Git 体检：发现 3 项待整理");
    for (const heading of ["为什么出现这张卡", "发现了什么", "影响", "建议怎么做", "怎么验证"]) {
      expect(out.body).toContain(`## ${heading}`);
    }
    expect(out.body).toMatchSnapshot("body");
    expect(out.acceptance).toMatchSnapshot("acceptance");
  });

  it("words a manual run differently", () => {
    const out = renderGitOutput(ctx("手动触发"), findings, [], { maxPerCategory: 15 });
    expect(out.body).toContain("你在维护页点击了「立即运行」");
    expect(out.body).not.toContain("触发原因：手动触发");
  });
});

describe("engine uses the layered config", () => {
  const dirty = (repo: string) => {
    sh(repo, ["branch", "feat/finished"]);
    writeFileSync(join(repo, "dirty.txt"), "dirty\n");
  };
  const reviewer = () => {
    const prompts: string[] = [];
    return {
      prompts,
      run: async ({ prompt }: { prompt: string }) => {
        prompts.push(prompt);
        return "ok";
      },
    };
  };

  it("applies a UI threshold, a custom review prompt and the new reason wording", async () => {
    const subAgent = reviewer();
    let ui = { projects: {} } as import("../shared/rules").RulesConfig;
    const h = setup({ engine: { subAgent, uiRules: () => ui } });
    dirty(h.repo);
    ui = {
      projects: {
        [h.project.id]: {
          overrides: {
            "git-health": {
              trigger: { kind: "workload", cards_done: 2 },
              agent: "claude/sonnet",
              prompts: { review: "规则 {{rule}}：{{trigger_reason}}" },
            },
          },
          custom: {},
        },
      },
    };
    await h.engine.tick();
    expect(h.engine.listRules(h.project.id)[0]).toMatchObject({ triggerKind: "workload", agent: "claude/sonnet" });
    h.complete(1);
    h.clock.advance(60_000);
    await h.engine.tick();
    expect(h.maintenanceCards()).toHaveLength(0);
    h.complete(1);
    h.clock.advance(60_000);
    await h.engine.tick();

    expect(h.maintenanceCards()).toHaveLength(1);
    expect(subAgent.prompts).toHaveLength(1);
    expect(subAgent.prompts[0]!.startsWith("规则 git-health：已完成卡片 2 张，达到阈值 2")).toBe(true);
    expect(subAgent.prompts[0]).toContain(SYSTEM_CONSTRAINTS.review);
    const status = h.engine.status().rules[0]!;
    expect(status).toMatchObject({ origin: "builtin", progressText: "已完成卡片 0/2" });
    expect(status.sources).toMatchObject({ trigger: "ui", agent: "ui", output: "builtin" });
  });

  it("lets maintenance.yml win over the UI and runs a custom UI rule; removing it disables it", async () => {
    const yml = `rules:
  - name: git-health
    daily_cap: 5
`;
    let ui = { projects: {} } as import("../shared/rules").RulesConfig;
    const h = setup({ yml, engine: { uiRules: () => ui } });
    ui = {
      projects: {
        [h.project.id]: {
          overrides: { "git-health": { daily_cap: 2, priority: "medium" } },
          custom: { tidy: { trigger: { kind: "time", cron: "0 3 * * *" }, check: { type: "git" } } },
        },
      },
    };
    await h.engine.tick();
    const rules = Object.fromEntries(h.engine.listRules(h.project.id).map((r) => [r.name, r]));
    expect(rules["git-health"]).toMatchObject({ dailyCap: 5, priority: "medium" });
    expect(rules.tidy).toMatchObject({ triggerKind: "time", enabled: true });
    expect(h.engine.status().rules.find((r) => r.rule.name === "tidy")?.origin).toBe("custom");

    ui = { projects: {} };
    await h.engine.tick();
    const after = h.engine.status().rules.find((r) => r.rule.name === "tidy")!;
    expect(after.rule.enabled).toBe(false);
    expect(after.defined).toBe(false);
    expect(h.engine.listRules(h.project.id).find((r) => r.name === "git-health")).toMatchObject({
      dailyCap: 5,
      priority: "low",
    });
  });
});
