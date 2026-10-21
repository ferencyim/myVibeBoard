// Rule model shared by the server (engine, maintenance.yml loader) and the client (editor).
// Pure: no node or react imports.
//
// A rule is defined once (built-in default < the global UI table) and applies to the projects named on
// it; a project's `<repo>/.vibe/maintenance.yml` is only a local override on top. Each field remembers
// which layer supplied it, so the UI can show yml-provided fields read-only.

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

// ---- UI layer (plugin settings): one global table, each rule says which projects it applies to ------

/** Which projects a rule applies to: every project (also future ones) or an explicit list. */
export type RuleScope = "all" | string[];

/**
 * Stored loosely so one bad entry never invalidates the whole settings object; validated on merge.
 * An entry holds the rule's fields (built-in rules: only the ones that differ from the built-in
 * default; custom rules: the complete definition) plus `projects` (default "all") and, on rules
 * created by the v1 -> v2 migration split, `splitFrom` (the original name).
 */
export const RulesConfigSchema = z.object({
  rules: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
});
export type RulesConfig = z.output<typeof RulesConfigSchema>;
export const EMPTY_RULES_CONFIG: RulesConfig = { rules: {} };

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

export const scopeIncludes = (scope: RuleScope, projectId: string) => scope === "all" || scope.includes(projectId);

function parseScope(raw: unknown): RuleScope {
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === "string");
  return "all";
}

interface Layer {
  source: FieldSource;
  fields: RuleFields;
}

/** Applies the layers per field. `trigger` and `check` are replaced as a whole; prompts layer separately. */
function layerMerge(
  name: string,
  layers: Layer[],
): { def?: RuleDef; sources: Record<FieldKey, FieldSource>; error?: string } {
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
  if (parsed.success) return { def: parsed.data, sources };
  return {
    sources,
    error: `规则「${name}」配置不完整或无效：${parsed.error.issues.map((x) => `${x.path.join(".")} ${x.message}`).join("; ")}`,
  };
}

interface GlobalEntry {
  name: string;
  origin: "builtin" | "custom";
  base: RuleDef | null;
  layers: Layer[];
  scope: RuleScope;
  splitFrom: string | null;
}

function globalEntries(builtin: RuleDef[], ui: RulesConfig | undefined): { entries: GlobalEntry[]; errors: string[] } {
  const errors: string[] = [];
  const stored = ui?.rules ?? {};
  const base = new Map(builtin.map((r) => [r.name, r]));
  const names = [...base.keys(), ...Object.keys(stored).filter((n) => !base.has(n))];
  const entries = names.map((name): GlobalEntry => {
    const raw = stored[name];
    const layers: Layer[] = [];
    const b = base.get(name) ?? null;
    if (b) layers.push({ source: "builtin", fields: b as unknown as RuleFields });
    if (raw) {
      const parsed = RuleFieldsSchema.safeParse(raw);
      if (parsed.success) layers.push({ source: "ui", fields: parsed.data });
      else
        errors.push(`界面规则「${name}」：${parsed.error.issues.map((x) => `${x.path.join(".")} ${x.message}`).join("; ")}`);
    }
    return {
      name,
      origin: b ? "builtin" : "custom",
      base: b,
      layers,
      scope: parseScope(raw?.projects),
      splitFrom: typeof raw?.splitFrom === "string" ? raw.splitFrom : null,
    };
  });
  return { entries, errors };
}

export interface GlobalRule {
  name: string;
  origin: "builtin" | "custom";
  /** Built-in default merged with the UI entry (no maintenance.yml: that only exists per project). */
  def: RuleDef;
  sources: Record<FieldKey, FieldSource>;
  base: RuleDef | null;
  scope: RuleScope;
  /** Set on rules the v1 -> v2 migration had to split: the original name. */
  splitFrom: string | null;
}

/** The rules defined once in the UI (built-in + custom), independent of any project. */
export function resolveGlobalRules(
  builtin: RuleDef[],
  ui: RulesConfig | undefined,
): { rules: GlobalRule[]; errors: string[] } {
  const { entries, errors } = globalEntries(builtin, ui);
  const rules: GlobalRule[] = [];
  for (const e of entries) {
    const m = layerMerge(e.name, e.layers);
    if (!m.def) {
      errors.push(m.error!);
      continue;
    }
    rules.push({
      name: e.name,
      origin: e.origin,
      def: m.def,
      sources: m.sources,
      base: e.base,
      scope: e.scope,
      splitFrom: e.splitFrom,
    });
  }
  return { rules, errors };
}

/**
 * The rules of one project: every global rule whose scope includes the project, with that
 * project's `maintenance.yml` on top (per field). A yml rule whose name is not an applicable global
 * rule (or the copy a migration split off a rule of that name) belongs to this project only (origin
 * "yml", must be complete). A merged result that is
 * invalid is dropped with an error, unless the global rule itself is already reported as invalid.
 */
export function mergeRuleLayers(input: {
  builtin: RuleDef[];
  ui?: RulesConfig;
  projectId: string;
  yml?: YmlRule[];
}): { rules: LayeredRule[]; errors: string[] } {
  const errors: string[] = [];
  const yml = input.yml ?? [];
  const { entries } = globalEntries(input.builtin, input.ui);
  const applicable = new Map(entries.filter((e) => scopeIncludes(e.scope, input.projectId)).map((e) => [e.name, e]));
  // A yml rule overrides the applicable rule of that name; failing that, the applicable copy the
  // migration split off a rule of that name (its project's yml was written for the original name).
  const target = (y: YmlRule) =>
    applicable.has(y.name) ? y.name : [...applicable.values()].find((e) => e.splitFrom === y.name)?.name;
  const names = [...applicable.keys()];
  for (const y of yml) if (!target(y) && !names.includes(y.name)) names.push(y.name);

  const rules: LayeredRule[] = [];
  for (const name of names) {
    const entry = applicable.get(name);
    const layers: Layer[] = [...(entry?.layers ?? [])];
    for (const y of yml.filter((r) => target(r) === name || (!target(r) && r.name === name))) {
      layers.push({ source: "yml", fields: y.fields });
    }
    const m = layerMerge(name, layers);
    if (!m.def) {
      // A broken global rule is reported once by resolveGlobalRules; only new problems count here.
      if (!entry || layerMerge(name, entry.layers).def) errors.push(m.error!);
      continue;
    }
    rules.push({
      def: m.def,
      origin: entry ? entry.origin : "yml",
      sources: m.sources,
      base: entry?.base ?? null,
    });
  }
  return { rules, errors };
}

/** Fields of a rule that a project's maintenance.yml sets (its local overrides). */
export const ymlFieldsOf = (sources: Record<FieldKey, FieldSource>): FieldKey[] =>
  FIELD_KEYS.filter((k) => sources[k] === "yml");

// ---- v1 -> v2 migration --------------------------------------------------------------------------

const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : x,
  );

const StoredFields = z.record(z.string(), z.unknown());
const LegacyConfigSchema = z.object({
  projects: z
    .record(
      z.string(),
      z.object({
        overrides: z.record(z.string(), StoredFields).default({}),
        custom: z.record(z.string(), StoredFields).default({}),
      }),
    )
    .default({}),
});

/**
 * Converts the v1 per-project configuration (`projects[id].overrides/custom`) into the global table.
 * Projects whose configuration of a rule is identical share one entry; a rule configured differently
 * per project is split into "name", "name-2", "name-3", ... (each marked `splitFrom`). A group
 * covering every project gets scope "all". Split copies of a built-in rule are stored complete,
 * because only the original name inherits the built-in default.
 * Dropped (v1 allowed them, v2 cannot represent them): overrides of rules that only a project's
 * maintenance.yml defines, and custom rules named like a built-in rule (those never took effect).
 */
export function migrateRulesV1(old: unknown, projectIds: string[], builtin: RuleDef[]): RulesConfig {
  const legacy = LegacyConfigSchema.safeParse(old ?? {});
  const projects = legacy.success ? legacy.data.projects : {};
  const universe = projectIds.length ? projectIds : Object.keys(projects);
  const builtinByName = new Map(builtin.map((r) => [r.name, r]));
  const rules: RulesConfig["rules"] = {};
  const taken = new Set<string>(builtinByName.keys());
  for (const id of universe) for (const n of Object.keys(projects[id]?.custom ?? {})) taken.add(n);
  const scopeOf = (ids: string[]): RuleScope =>
    universe.length > 0 && universe.every((id) => ids.includes(id)) ? "all" : ids;

  type Group = { fields: Record<string, unknown>; ids: string[] };
  const group = (items: Array<{ id: string; fields: Record<string, unknown> }>): Group[] => {
    const groups = new Map<string, Group>();
    for (const { id, fields } of items) {
      const key = stable(fields);
      const g = groups.get(key) ?? { fields, ids: [] };
      g.ids.push(id);
      groups.set(key, g);
    }
    return [...groups.values()];
  };
  const emit = (name: string, groups: Group[], isBuiltin: boolean) => {
    const split = groups.length > 1;
    groups.forEach((g, i) => {
      let target = name;
      if (i > 0) {
        let n = i + 1;
        while (taken.has(`${name}-${n}`)) n++;
        target = `${name}-${n}`;
        taken.add(target);
      }
      const scope = scopeOf(g.ids);
      // Only the original built-in name inherits the default; copies and custom rules are complete.
      const complete = !isBuiltin || i > 0;
      const merged = isBuiltin && i > 0 ? { ...builtinByName.get(name), ...g.fields } : g.fields;
      const { name: _name, ...fields } = merged as Record<string, unknown>;
      if (isBuiltin && !complete && !split && Object.keys(fields).length === 0 && scope === "all") return;
      rules[target] = { ...fields, projects: scope, ...(split ? { splitFrom: name } : {}) };
    });
  };

  for (const name of builtinByName.keys()) {
    const items = universe.map((id) => ({ id, fields: projects[id]?.overrides[name] ?? {} }));
    // The unmodified group goes first: it keeps the original name and inherits future default changes.
    const groups = group(items).sort(
      (a, b) => Number(Object.keys(a.fields).length > 0) - Number(Object.keys(b.fields).length > 0),
    );
    emit(name, groups, true);
  }
  const customNames = new Set<string>();
  for (const id of universe) for (const n of Object.keys(projects[id]?.custom ?? {})) customNames.add(n);
  for (const name of customNames) {
    if (builtinByName.has(name)) continue;
    const items = universe
      .filter((id) => projects[id]?.custom[name])
      .map((id) => ({ id, fields: projects[id]!.custom[name]! }));
    emit(name, group(items), false);
  }
  return { rules };
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
