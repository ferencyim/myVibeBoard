// Pure helpers of the maintenance screen: the status RPC carries `rule` / `lastRun` as loose
// objects, so the screen reads them through `parseStatus`.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);
const num = (v: unknown, fallback = 0) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

export interface RuleRow {
  id: string;
  name: string;
  projectName: string;
  trigger: string;
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
  lastRun: { status: string; at: string; cards: number } | null;
}

export interface MaintainView {
  rules: RuleRow[];
  /** Project id (or name) -> problems found in its maintenance.yml. */
  configErrors: Array<{ project: string; errors: string[] }>;
}

export function triggerText(kind: string, trigger: unknown): string {
  const t = isObj(trigger) ? trigger : {};
  if (kind === "workload") {
    const parts = [
      t.cards_done ? `${t.cards_done} cards done` : "",
      t.commits_merged ? `${t.commits_merged} commits` : "",
      t.tokens ? `${t.tokens} tokens` : "",
    ].filter(Boolean);
    return parts.length ? `every ${parts.join(" / ")}` : "workload";
  }
  if (kind === "time") return `cron ${str(t.cron, "?")}`;
  if (kind === "event") return `on ${str(t.path, "file")} matching ${str(t.pattern, "?")}`;
  return kind;
}

export function parseStatus(raw: unknown): MaintainView {
  const o: Obj = isObj(raw) ? raw : {};
  const rules = (Array.isArray(o.rules) ? o.rules : []).filter(isObj).map((r): RuleRow => {
    const rule = isObj(r.rule) ? r.rule : {};
    const last = isObj(r.lastRun) ? r.lastRun : null;
    return {
      id: str(rule.id),
      name: str(rule.name, "(unnamed)"),
      projectName: str(r.projectName, str(rule.projectId)),
      trigger: triggerText(str(rule.triggerKind), rule.trigger),
      output: str(rule.outputMode, "suggest"),
      agent: typeof rule.agent === "string" && rule.agent ? rule.agent : null,
      priority: str(rule.priority, "low"),
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
            cards: Array.isArray(last.cardIds) ? last.cardIds.length : 0,
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
  return { rules, configErrors };
}

export const BLOCKED_TEXT: Record<string, string> = {
  paused: "Paused after repeated rejections",
  daily_cap: "Daily cap reached",
  disabled: "Disabled in maintenance.yml",
};

export const fmtTime = (iso: string): string => (iso ? iso.slice(0, 16).replace("T", " ") : "-");
