// Pure helpers of the maintenance screen: the status RPC carries `rule` / `lastRun` as loose
// objects, so the screen reads them through `parseStatus`.

import { FIELD_KEYS, type FieldKey, type FieldSource, type RuleDef, type RuleOrigin } from "../shared/rules";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);
const num = (v: unknown, fallback = 0) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

export interface RuleRow {
  id: string;
  name: string;
  projectId: string;
  projectName: string;
  /** builtin | custom | yml; null until the project's rules were synced. */
  origin: RuleOrigin | null;
  /** Which layer supplied each field. Everything counts as builtin until synced. */
  sources: Record<FieldKey, FieldSource>;
  /** The effective values, in the shape the editor works on. */
  def: RuleDef;
  /** The built-in default of a built-in rule. */
  base: RuleDef | null;
  triggerText: string;
  progressText: string | null;
  checkText: string;
  output: string;
  agent: string | null;
  priority: string;
  dailyCap: number;
  runsToday: number;
  enabled: boolean;
  paused: boolean;
  /** Why the rule cannot fire now: paused | daily_cap | disabled. */
  blocked: string | null;
  counters: Record<string, number>;
  lastRun: { status: string; at: string; finishedAt: string; cards: number; error: string | null } | null;
}

export interface MaintainView {
  rules: RuleRow[];
  /** Project id (or name) -> problems found in its maintenance.yml / UI config. */
  configErrors: Array<{ project: string; errors: string[] }>;
  projects: Array<{ id: string; name: string }>;
  presets: Array<{ id: string; name: string; spec: string }>;
}

const ORIGINS: RuleOrigin[] = ["builtin", "custom", "yml"];

function parseSources(raw: unknown, origin: RuleOrigin | null): Record<FieldKey, FieldSource> {
  const o = isObj(raw) ? raw : {};
  const fallback: FieldSource = origin === "yml" ? "yml" : "builtin";
  return Object.fromEntries(
    FIELD_KEYS.map((k) => {
      const v = o[k];
      return [k, v === "ui" || v === "yml" || v === "builtin" ? v : fallback];
    }),
  ) as Record<FieldKey, FieldSource>;
}

function defOf(rule: Obj, prompts: { review: string | null; fix: string | null }): RuleDef {
  return {
    name: str(rule.name),
    enabled: rule.enabled !== false,
    trigger: (isObj(rule.trigger)
      ? { ...rule.trigger, kind: str(rule.triggerKind, "workload") }
      : { kind: "workload" }) as RuleDef["trigger"],
    check: (isObj(rule.check) ? rule.check : { type: "git" }) as RuleDef["check"],
    agent: typeof rule.agent === "string" && rule.agent ? rule.agent : null,
    output: rule.outputMode === "fix" ? "fix" : "suggest",
    priority: str(rule.priority, "low"),
    dedupe_key: typeof rule.dedupeKey === "string" && rule.dedupeKey ? rule.dedupeKey : null,
    daily_cap: num(rule.dailyCap, 1),
    prompts,
  };
}

export function parseStatus(raw: unknown): MaintainView {
  const o: Obj = isObj(raw) ? raw : {};
  const rules = (Array.isArray(o.rules) ? o.rules : [])
    .filter(isObj)
    .filter((r) => r.defined !== false)
    .map((r): RuleRow => {
      const rule = isObj(r.rule) ? r.rule : {};
      const last = isObj(r.lastRun) ? r.lastRun : null;
      const origin = ORIGINS.find((x) => x === r.origin) ?? null;
      const promptsRaw = isObj(r.prompts) ? r.prompts : {};
      const def = defOf(rule, {
        review: typeof promptsRaw.review === "string" ? promptsRaw.review : null,
        fix: typeof promptsRaw.fix === "string" ? promptsRaw.fix : null,
      });
      const findings = last && Array.isArray(last.findings) ? last.findings : [];
      const failure = findings.find((f) => isObj(f) && typeof f.error === "string");
      return {
        id: str(rule.id),
        name: str(rule.name, "(未命名)"),
        projectId: str(rule.projectId),
        projectName: str(r.projectName, str(rule.projectId)),
        origin,
        sources: parseSources(r.sources, origin),
        def,
        base: isObj(r.base) ? (r.base as unknown as RuleDef) : null,
        triggerText: str(r.triggerText),
        progressText: typeof r.progressText === "string" ? r.progressText : null,
        checkText: str(r.checkText),
        output: def.output,
        agent: def.agent ?? null,
        priority: def.priority,
        dailyCap: num(rule.dailyCap),
        runsToday: num(r.runsToday),
        enabled: rule.enabled !== false,
        paused: typeof rule.pausedAt === "string" && rule.pausedAt.length > 0,
        blocked: typeof r.blocked === "string" ? r.blocked : null,
        counters: isObj(r.counters)
          ? Object.fromEntries(Object.entries(r.counters).map(([k, v]) => [k, num(v)]))
          : {},
        lastRun: last
          ? {
              status: str(last.status, "unknown"),
              at: str(last.triggeredAt),
              finishedAt: str(last.finishedAt),
              cards: Array.isArray(last.cardIds) ? last.cardIds.length : 0,
              error: isObj(failure) ? str(failure.error) : null,
            }
          : null,
      };
    });
  const configErrors = Object.entries(isObj(o.configErrors) ? o.configErrors : {}).map(
    ([project, errors]) => ({
      project,
      errors: Array.isArray(errors) ? errors.filter((e): e is string => typeof e === "string") : [],
    }),
  );
  const list = <T>(v: unknown, pick: (x: Obj) => T): T[] =>
    (Array.isArray(v) ? v : []).filter(isObj).map(pick);
  return {
    rules,
    configErrors,
    projects: list(o.projects, (p) => ({ id: str(p.id), name: str(p.name) })),
    presets: list(o.presets, (p) => ({ id: str(p.id), name: str(p.name), spec: str(p.spec) })),
  };
}

export const BLOCKED_TEXT: Record<string, string> = {
  paused: "已暂停：连续多张维护卡被驳回，点「恢复」后继续",
  daily_cap: "今天的运行次数已达每日上限",
  disabled: "已停用",
};

export const RUN_STATUS_TEXT: Record<string, string> = {
  running: "运行中",
  done: "完成",
  failed: "失败",
  skipped: "已跳过",
};

export const SOURCE_TEXT: Record<FieldSource, string> = {
  builtin: "内置默认",
  ui: "界面配置",
  yml: "来自 maintenance.yml",
};

export const ORIGIN_TEXT: Record<RuleOrigin, string> = {
  builtin: "内置规则",
  custom: "自定义规则",
  yml: "maintenance.yml 规则",
};

export const fmtTime = (iso: string): string => (iso ? iso.slice(0, 16).replace("T", " ") : "-");

/** "2026-10-21 03:00 · 完成 · 生成或更新了 1 张卡", or the failure reason. */
export function lastRunText(last: RuleRow["lastRun"]): string {
  if (!last) return "从未运行";
  const status = RUN_STATUS_TEXT[last.status] ?? last.status;
  const result =
    last.status === "failed"
      ? `原因：${last.error ?? "未知"}`
      : last.status === "done"
        ? last.cards > 0
          ? `生成或更新了 ${last.cards} 张卡`
          : "没有发现需要处理的问题"
        : "";
  return [fmtTime(last.at), status, result].filter(Boolean).join(" · ");
}
