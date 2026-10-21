// Pure editing logic of the rule editor: form draft <-> rule fields, and how an edit lands in the
// global rule table (plugin settings, see shared/rules.ts).

import { unknownPlaceholders } from "../shared/prompts";
import {
  FIELD_KEYS,
  RuleDefSchema,
  type FieldKey,
  type RuleDef,
  type RuleFields,
  type RuleScope,
  type RulesConfig,
} from "../shared/rules";

export const CHECK_TYPES = ["git", "perf-slow"] as const;
export const PRIORITIES = ["urgent", "high", "medium", "low", "none"] as const;
const GIT_PARAMS = ["stale_days", "staleDays", "large_file_mb", "largeFileMb", "outdated"];

export interface RuleDraft {
  enabled: boolean;
  triggerKind: "workload" | "time" | "event";
  cardsDone: string;
  commitsMerged: string;
  tokens: string;
  cron: string;
  eventPath: string;
  eventPattern: string;
  checkType: string;
  staleDays: string;
  largeFileMb: string;
  outdated: boolean;
  /** Remaining check parameters as a JSON object (perf-slow sources, ...). */
  checkExtra: string;
  agent: string;
  output: "suggest" | "fix";
  priority: string;
  dailyCap: string;
  dedupeKey: string;
  /** null = the default template. */
  reviewPrompt: string | null;
  fixPrompt: string | null;
}

const text = (v: unknown) => (typeof v === "number" || typeof v === "string" ? String(v) : "");

export function emptyDef(name: string): RuleDef {
  return RuleDefSchema.parse({
    name,
    trigger: { kind: "workload", cards_done: 10 },
    check: { type: "git" },
  });
}

export function draftFromDef(def: RuleDef): RuleDraft {
  const t = def.trigger;
  const check = def.check as Record<string, unknown>;
  const extra = Object.fromEntries(
    Object.entries(check).filter(([k]) => k !== "type" && !GIT_PARAMS.includes(k)),
  );
  return {
    enabled: def.enabled,
    triggerKind: t.kind,
    cardsDone: t.kind === "workload" ? text(t.cards_done) : "",
    commitsMerged: t.kind === "workload" ? text(t.commits_merged) : "",
    tokens: t.kind === "workload" ? text(t.tokens) : "",
    cron: t.kind === "time" ? t.cron : "0 3 * * *",
    eventPath: t.kind === "event" ? t.path : "",
    eventPattern: t.kind === "event" ? (t.pattern ?? "") : "",
    checkType: def.check.type,
    staleDays: text(check.stale_days ?? check.staleDays),
    largeFileMb: text(check.large_file_mb ?? check.largeFileMb),
    outdated: check.outdated !== false,
    checkExtra: Object.keys(extra).length ? JSON.stringify(extra, null, 2) : "",
    agent: def.agent ?? "",
    output: def.output,
    priority: def.priority,
    dailyCap: String(def.daily_cap),
    dedupeKey: def.dedupe_key ?? "",
    reviewPrompt: def.prompts.review ?? null,
    fixPrompt: def.prompts.fix ?? null,
  };
}

export interface DraftResult {
  /** Complete field values (every editable field), absent when `errors` is not empty. */
  fields?: Required<Omit<RuleFields, "prompts">> & { prompts: { review?: string; fix?: string } };
  errors: string[];
  warnings: string[];
}

const positiveInt = (s: string) => (/^\d+$/.test(s.trim()) && Number(s) > 0 ? Number(s) : null);

export function draftToFields(draft: RuleDraft): DraftResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  let trigger: RuleFields["trigger"];
  if (draft.triggerKind === "workload") {
    const parse = (label: string, s: string) => {
      if (!s.trim()) return undefined;
      const n = positiveInt(s);
      if (n === null) errors.push(`${label}要填正整数`);
      return n ?? undefined;
    };
    const cards = parse("完成卡片数阈值", draft.cardsDone);
    const commits = parse("合并提交数阈值", draft.commitsMerged);
    const tokens = parse("token 阈值", draft.tokens);
    if (!cards && !commits && !tokens && errors.length === 0) {
      errors.push("按工作量触发至少要填一个阈值（完成卡片数、合并提交数或 token）");
    }
    trigger = {
      kind: "workload",
      ...(cards ? { cards_done: cards } : {}),
      ...(commits ? { commits_merged: commits } : {}),
      ...(tokens ? { tokens } : {}),
    };
  } else if (draft.triggerKind === "time") {
    if (draft.cron.trim().split(/\s+/).length !== 5) errors.push("cron 要写 5 段，例如 0 3 * * *（每天 3 点）");
    trigger = { kind: "time", cron: draft.cron.trim() };
  } else {
    if (!draft.eventPath.trim()) errors.push("要填写监视的文件路径");
    try {
      if (draft.eventPattern.trim()) new RegExp(draft.eventPattern);
    } catch {
      errors.push("匹配正则不合法");
    }
    trigger = {
      kind: "event",
      path: draft.eventPath.trim(),
      ...(draft.eventPattern.trim() ? { pattern: draft.eventPattern.trim() } : {}),
    };
  }

  const check: Record<string, unknown> = { type: draft.checkType.trim() || "git" };
  if (draft.checkType === "git" || !draft.checkType) {
    const numeric = (label: string, key: string, s: string) => {
      if (!s.trim()) return;
      const n = Number(s);
      if (Number.isFinite(n) && n > 0) check[key] = n;
      else errors.push(`${label}要填大于 0 的数字`);
    };
    numeric("多少天算长期未合并", "stale_days", draft.staleDays);
    numeric("大文件阈值（MB）", "large_file_mb", draft.largeFileMb);
    if (!draft.outdated) check.outdated = false;
  }
  if (draft.checkExtra.trim()) {
    try {
      const extra: unknown = JSON.parse(draft.checkExtra);
      if (typeof extra !== "object" || extra === null || Array.isArray(extra)) throw new Error("not an object");
      Object.assign(check, { ...extra, type: check.type });
    } catch {
      errors.push("检查参数要写成 JSON 对象");
    }
  }

  const cap = /^\d+$/.test(draft.dailyCap.trim()) ? Number(draft.dailyCap) : null;
  if (cap === null) errors.push("每日上限要填 0 或正整数");
  for (const [label, tpl] of [
    ["复核提示词", draft.reviewPrompt],
    ["修复提示词", draft.fixPrompt],
  ] as const) {
    const unknown = tpl ? unknownPlaceholders(tpl) : [];
    if (unknown.length) warnings.push(`${label}里有未知占位符：${unknown.map((n) => `{{${n}}}`).join("、")}，将原样发给 agent`);
  }
  if (errors.length) return { errors, warnings };

  return {
    errors,
    warnings,
    fields: {
      enabled: draft.enabled,
      trigger: trigger!,
      check: check as { type: string },
      agent: draft.agent.trim() || null,
      output: draft.output,
      priority: draft.priority.trim() || "low",
      dedupe_key: draft.dedupeKey.trim() || null,
      daily_cap: cap!,
      prompts: {
        ...(draft.reviewPrompt?.trim() ? { review: draft.reviewPrompt } : {}),
        ...(draft.fixPrompt?.trim() ? { fix: draft.fixPrompt } : {}),
      },
    },
  };
}

// ---- writing into the global rule table ----------------------------------------------------------

type Stored = Record<string, unknown>;

function valueOf(fields: RuleFields | RuleDef | null | undefined, key: FieldKey): unknown {
  if (!fields) return undefined;
  if (key === "prompts.review") return fields.prompts?.review ?? undefined;
  if (key === "prompts.fix") return fields.prompts?.fix ?? undefined;
  return (fields as Record<string, unknown>)[key];
}

function setValue(stored: Stored, key: FieldKey, value: unknown): void {
  if (key.startsWith("prompts.")) {
    const sub = key.slice(8);
    const prompts = { ...((stored.prompts as Stored | undefined) ?? {}) };
    if (value === undefined) delete prompts[sub];
    else prompts[sub] = value;
    if (Object.keys(prompts).length) stored.prompts = prompts;
    else delete stored.prompts;
  } else if (value === undefined) delete stored[key];
  else stored[key] = value;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Stores an edit of a global rule: its fields and the projects it applies to. For built-in rules only
 * differences from the built-in default are kept, so "restore default" is just removing the entry and
 * future default changes still apply. `projects` and `splitFrom` (migration marker) are kept next
 * to the fields; an entry that says nothing new (default fields, all projects) is removed.
 */
export function applyRuleEdit(
  config: RulesConfig,
  target: { name: string; origin: "builtin" | "custom"; base: RuleDef | null },
  fields: NonNullable<DraftResult["fields"]>,
  scope: RuleScope,
): RulesConfig {
  const custom = target.origin === "custom";
  const previous = config.rules[target.name] ?? {};
  const stored: Stored = {};
  for (const key of FIELD_KEYS) {
    const value = valueOf(fields as RuleFields, key);
    const isDefault = !custom && target.base ? same(value, valueOf(target.base, key)) : false;
    setValue(stored, key, value === undefined || isDefault ? undefined : value);
  }
  if (!custom && Object.keys(stored).length === 0 && scope === "all") {
    const { [target.name]: _removed, ...rest } = config.rules;
    return { ...config, rules: rest };
  }
  stored.projects = scope;
  if (typeof previous.splitFrom === "string") stored.splitFrom = previous.splitFrom;
  return { ...config, rules: { ...config.rules, [target.name]: stored } };
}

/** Creates a custom rule; returns an error text when the name is unusable. */
export function addCustomRule(
  config: RulesConfig,
  name: string,
  takenNames: string[],
  fields: NonNullable<DraftResult["fields"]>,
  scope: RuleScope,
): { config: RulesConfig; error?: string } {
  const trimmed = name.trim();
  if (!trimmed) return { config, error: "规则名称不能为空" };
  if (trimmed.includes(":")) return { config, error: "规则名称不能包含冒号" };
  if (takenNames.includes(trimmed)) return { config, error: `已有叫「${trimmed}」的规则` };
  return { config: { ...config, rules: { ...config.rules, [trimmed]: { ...(fields as Stored), projects: scope } } } };
}

/** Removes only the configuration entry; files and history stay. */
export function removeCustomRule(config: RulesConfig, name: string): RulesConfig {
  const { [name]: _removed, ...rest } = config.rules;
  return { ...config, rules: rest };
}
