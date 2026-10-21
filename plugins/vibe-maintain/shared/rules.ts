// Rule model shared by the server (engine, maintenance.yml loader) and the client (editor).
// Pure: no node or react imports.
//
// A rule's final value is layered per field: built-in default < UI config (plugin settings, per
// project) < `<repo>/.vibe/maintenance.yml`. Each field remembers which layer supplied it, so the UI
// can show yml-provided fields read-only.

import { z } from "zod";

const TriggerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("workload"),
    cards_done: z.number().int().positive().optional(),
    commits_merged: z.number().int().positive().optional(),
    tokens: z.number().int().positive().optional(),
  }),
  z.object({ kind: z.literal("time"), cron: z.string().min(1) }),
  z.object({
    kind: z.literal("event"),
    /** Relative to the repository root unless absolute. */
    path: z.string().min(1),
    /** Regular expression; only appended lines that match fire the rule. Default: any append. */
    pattern: z.string().optional(),
  }),
]);
export type RuleTrigger = z.output<typeof TriggerSchema>;

const CheckSchema = z.object({ type: z.string().min(1) }).passthrough();

/** Prompt templates (`{{placeholder}}`); absent/null = the built-in default. */
export const PromptsSchema = z.object({
  review: z.string().nullish(),
  fix: z.string().nullish(),
});

export const RuleDefSchema = z
  .object({
    name: z.string().min(1),
    enabled: z.boolean().default(true),
    trigger: TriggerSchema,
    check: CheckSchema,
    agent: z.string().nullish(),
    output: z.enum(["suggest", "fix"]).default("suggest"),
    priority: z.string().default("low"),
    dedupe_key: z.string().nullish(),
    daily_cap: z.number().int().min(0).default(1),
    prompts: PromptsSchema.default({}),
  })
  .superRefine((rule, ctx) => {
    if (rule.trigger.kind === "workload") {
      const t = rule.trigger;
      if (!t.cards_done && !t.commits_merged && !t.tokens) {
        ctx.addIssue({
          code: "custom",
          message: "workload trigger needs cards_done, commits_merged or tokens",
        });
      }
    }
  });
export type RuleDef = z.output<typeof RuleDefSchema>;

/** A layer's partial view of a rule: only the fields that layer sets. */
export const RuleFieldsSchema = z
  .object({
    enabled: z.boolean(),
    trigger: TriggerSchema,
    check: CheckSchema,
    agent: z.string().nullable(),
    output: z.enum(["suggest", "fix"]),
    priority: z.string(),
    dedupe_key: z.string().nullable(),
    daily_cap: z.number().int().min(0),
    prompts: z.object({ review: z.string(), fix: z.string() }).partial(),
  })
  .partial();
export type RuleFields = z.output<typeof RuleFieldsSchema>;

export const FIELD_KEYS = [
  "enabled",
  "trigger",
  "check",
  "agent",
  "output",
  "priority",
  "dedupe_key",
  "daily_cap",
  "prompts.review",
  "prompts.fix",
] as const;
export type FieldKey = (typeof FIELD_KEYS)[number];
export type FieldSource = "builtin" | "ui" | "yml";
export type RuleOrigin = "builtin" | "custom" | "yml";

// ---- UI layer (plugin settings, keyed by project id) ---------------------------------------------

/** Stored loosely so one bad entry never invalidates the whole settings object; validated on merge. */
const LooseFields = z.record(z.string(), z.unknown());
export const RulesConfigSchema = z.object({
  projects: z
    .record(
      z.string(),
      z.object({
        /** Field overrides of built-in rules (or yml-defined rules), by rule name. */
        overrides: z.record(z.string(), LooseFields).default({}),
        /** Complete user-created rules, by name. */
        custom: z.record(z.string(), LooseFields).default({}),
      }),
    )
    .default({}),
});
export type RulesConfig = z.output<typeof RulesConfigSchema>;
export type ProjectRulesConfig = RulesConfig["projects"][string];
export const EMPTY_RULES_CONFIG: RulesConfig = { projects: {} };

export interface YmlRule {
  name: string;
  fields: RuleFields;
}

export interface LayeredRule {
  def: RuleDef;
  origin: RuleOrigin;
  sources: Record<FieldKey, FieldSource>;
  /** The built-in default (for "restore default" in the editor); null for non-built-in rules. */
  base: RuleDef | null;
}

const get = (fields: RuleFields | undefined, key: FieldKey): unknown => {
  if (!fields) return undefined;
  if (key === "prompts.review") return fields.prompts?.review;
  if (key === "prompts.fix") return fields.prompts?.fix;
  return fields[key];
};

/**
 * Combines the three layers into final rules. `trigger` and `check` are replaced as a whole (their
 * parameters only make sense together); `prompts.review` and `prompts.fix` layer separately.
 * A rule whose merged result is invalid is dropped with an error.
 */
export function mergeRuleLayers(input: {
  builtin: RuleDef[];
  ui?: ProjectRulesConfig;
  yml?: YmlRule[];
}): { rules: LayeredRule[]; errors: string[] } {
  const errors: string[] = [];
  const ui = input.ui ?? { overrides: {}, custom: {} };
  const builtin = new Map(input.builtin.map((r) => [r.name, r]));
  const parseFields = (raw: unknown, where: string): RuleFields => {
    const parsed = RuleFieldsSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    errors.push(`${where}: ${parsed.error.issues.map((x) => `${x.path.join(".")} ${x.message}`).join("; ")}`);
    return {};
  };
  const names: string[] = [];
  const add = (name: string) => void (names.includes(name) || names.push(name));
  for (const name of builtin.keys()) add(name);
  for (const name of Object.keys(ui.custom)) add(name);
  for (const y of input.yml ?? []) add(y.name);

  const rules: LayeredRule[] = [];
  for (const name of names) {
    const base = builtin.get(name) ?? null;
    const custom = base ? undefined : ui.custom[name];
    const origin: RuleOrigin = base ? "builtin" : custom ? "custom" : "yml";
    const layers: Array<{ source: FieldSource; fields: RuleFields }> = [];
    if (base) layers.push({ source: "builtin", fields: base as unknown as RuleFields });
    if (custom) layers.push({ source: "ui", fields: parseFields(custom, `界面规则「${name}」`) });
    const override = ui.overrides[name];
    if (override && !custom) layers.push({ source: "ui", fields: parseFields(override, `界面配置「${name}」`) });
    for (const y of (input.yml ?? []).filter((r) => r.name === name)) {
      layers.push({ source: "yml", fields: y.fields });
    }

    const sources = Object.fromEntries(FIELD_KEYS.map((k) => [k, "builtin"])) as Record<FieldKey, FieldSource>;
    const merged: Record<string, unknown> = { name, prompts: {} };
    for (const key of FIELD_KEYS) {
      for (const layer of layers) {
        const value = get(layer.fields, key);
        if (value === undefined) continue;
        sources[key] = layer.source;
        if (key.startsWith("prompts.")) (merged.prompts as Record<string, unknown>)[key.slice(8)] = value;
        else merged[key] = value;
      }
    }
    const parsed = RuleDefSchema.safeParse(merged);
    if (!parsed.success) {
      errors.push(
        `规则「${name}」配置不完整或无效：${parsed.error.issues.map((x) => `${x.path.join(".")} ${x.message}`).join("; ")}`,
      );
      continue;
    }
    rules.push({ def: parsed.data, origin, sources, base });
  }
  return { rules, errors };
}

// ---- natural-language description and progress -----------------------------------------------------

export const COUNTER_LABELS = { cards: "已完成卡片", commits: "已合并提交", tokens: "已消耗 token" } as const;

/** One sentence: when does this rule fire. */
export function describeTrigger(trigger: RuleTrigger): string {
  if (trigger.kind === "workload") {
    const parts = [
      trigger.cards_done ? `已完成卡片累计达到 ${trigger.cards_done} 张` : "",
      trigger.commits_merged ? `已合并提交累计达到 ${trigger.commits_merged} 个` : "",
      trigger.tokens ? `token 消耗累计达到 ${trigger.tokens}` : "",
    ].filter(Boolean);
    return `${parts.join("，或")}时触发（任一条件达到即触发，触发后计数清零）。`;
  }
  if (trigger.kind === "time") return `按定时计划触发：cron「${trigger.cron}」（本地时间，5 段）。`;
  return `监视文件「${trigger.path}」，新增的行${
    trigger.pattern ? `匹配正则「${trigger.pattern}」` : "（任意内容）"
  }时触发。`;
}

/** "已完成卡片 7/10，已合并提交 12/30"; null when the trigger has no counters. */
export function progressText(trigger: RuleTrigger, counters: Record<string, number>): string | null {
  if (trigger.kind !== "workload") return null;
  const parts: string[] = [];
  const entry = (kind: keyof typeof COUNTER_LABELS, target: number | undefined) => {
    if (target) parts.push(`${COUNTER_LABELS[kind]} ${counters[kind] ?? 0}/${target}`);
  };
  entry("cards", trigger.cards_done);
  entry("commits", trigger.commits_merged);
  entry("tokens", trigger.tokens);
  return parts.length ? parts.join("，") : null;
}

/** What the check looks at, in words. */
export function describeCheck(check: { type: string } & Record<string, unknown>): string {
  const num = (a: string, b: string, d: number) => {
    const v = check[a] ?? check[b];
    return typeof v === "number" && v > 0 ? v : d;
  };
  if (check.type === "git") {
    return (
      `Git 体检（不调用模型）：超过 ${num("stale_days", "staleDays", 14)} 天未合并的分支、已合并但未删除的分支、` +
      `遗留的 worktree、未提交或未推送的改动、会与主干冲突的分支、大于 ${num("large_file_mb", "largeFileMb", 5)} MB 的文件` +
      `${check.outdated === false ? "" : "、过期的 npm 依赖"}。`
    );
  }
  if (check.type === "perf-slow") {
    return "慢调用检查：读取配置的日志或基准结果，找出超过阈值的调用点，尝试复现后再报告。";
  }
  return `自定义检查「${check.type}」。`;
}
