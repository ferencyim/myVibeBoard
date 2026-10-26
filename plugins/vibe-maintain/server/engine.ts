// 维护规则按项目保留触发计数与运行历史；发现只进入原生 workspace 的规划会话。
// 同规则未完成任务补充新发现，方案变更须先停止、清除确认并重新等待用户 /执行。

import { randomUUID } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { latestFire } from "./cron";
import { BUILTIN_RULES, loadConfig } from "./config";
import {
  EMPTY_RULES_CONFIG,
  describeCheck,
  describeTrigger,
  mergeRuleLayers,
  progressText,
  resolveGlobalRules,
  ymlFieldsOf,
  type LayeredRule,
  type RuleDef,
  type RulesConfig,
} from "../shared/rules";
import { MAINTENANCE_PROMPTS, buildPrompt, type PromptVars } from "../shared/prompts";
import { trunkOf } from "./git/check";
import type { GitRunner } from "./git/exec";
import type { CheckOutput, CheckRegistry, Finding, MaintenanceTaskLauncher } from "./types";
import { findingKey } from "./types";
import {
  MaintenanceRuleSchema,
  MaintenanceRunSchema,
  isEvent,
  type MaintenanceRule,
  type MaintenanceRun,
  type Project,
} from "./vibe/contract";
import {
  createEventConsumer,
  createMaintenanceCommands,
  decodeRows,
  publishEvent,
  type EventConsumer,
  type VibeDb,
  type VibeStore,
} from "./vibe/db";

export interface EngineSettings {
  enabled: boolean;
  /** 连续驳回达到此次数后暂停规则。 */
  pauseAfterRejections: number;
}

export interface EngineOptions {
  db: VibeDb;
  store: VibeStore;
  now?: () => Date;
  git: GitRunner;
  checks: CheckRegistry;
  settings?: () => EngineSettings;
  /** The global UI rule table (plugin settings); read on every sync. */
  uiRules?: () => RulesConfig;

  taskLauncher?: MaintenanceTaskLauncher;
  /** Waits until WP-111 has actually stopped every native task agent. */
  stopTask?: (workspaceId: string) => Promise<boolean>;
  projectIdOfTask?: (workspaceId: string) => Promise<string | undefined>;
  newId?: () => string;
  /** Minimum seconds between `git rev-list` polls per rule (commit-count triggers). */
  commitPollSeconds?: number | (() => number);
  pollIntervalMs?: number;
  log?: (message: string, error?: unknown) => void;
}

export const DEFAULT_ENGINE_SETTINGS: EngineSettings = { enabled: true, pauseAfterRejections: 3 };

type WorkloadTrigger = {
  kind: "workload";
  cards_done?: number;
  commits_merged?: number;
  tokens?: number;
};
type TimeTrigger = { kind: "time"; cron: string };
type EventTrigger = { kind: "event"; path: string; pattern?: string };

export interface TriggerReason {
  reason: string;
  detail?: string[];
}

export type FireOutcome =
  | { status: "fired"; run: MaintenanceRun }
  | { status: "blocked"; why: "paused" | "daily_cap" | "disabled" | "busy" };

const MAX_EVENT_READ = 1024 * 1024;
/** Key of the problems in the global UI rules (not tied to one project) in `status().configErrors`. */
export const GLOBAL_ERRORS = "(界面规则)";

export function createMaintenanceEngine(options: EngineOptions) {
  const { db, store, git, checks } = options;
  const commands = createMaintenanceCommands(db, { now: options.now });
  store.prompts.register(MAINTENANCE_PROMPTS);
  const now = options.now ?? (() => new Date());
  const settings = options.settings ?? (() => DEFAULT_ENGINE_SETTINGS);
  const newId = options.newId ?? randomUUID;
  const log = options.log ?? (() => undefined);
  const commitPollMs = () => {
    const seconds = options.commitPollSeconds;
    return ((typeof seconds === "function" ? seconds() : seconds) ?? 60) * 1000;
  };

  const uiRules = options.uiRules ?? (() => EMPTY_RULES_CONFIG);
  const configCache = new Map<
    string,
    { signature: string; errors: string[]; layered: Map<string, LayeredRule> }
  >();
  const inflight = new Set<string>();
  const lastCommitPoll = new Map<string, number>();

  // ---- small helpers -------------------------------------------------------------------------

  const iso = () => now().toISOString();
  const ruleKey = (rule: MaintenanceRule, kind: string) => `${rule.id}:${kind}`;

  const getCounter = commands.counter;
  const setCounter = commands.setCounter;
  const bump = commands.bump;

  function listRules(projectId?: string): MaintenanceRule[] {
    const rows = projectId
      ? db
          .prepare("SELECT * FROM maintenance_rule WHERE project_id = ? ORDER BY name")
          .all(projectId)
      : db.prepare("SELECT * FROM maintenance_rule ORDER BY project_id, name").all();
    return decodeRows(MaintenanceRuleSchema, rows);
  }
  function getRule(id: string): MaintenanceRule | undefined {
    const row = db.prepare("SELECT * FROM maintenance_rule WHERE id = ?").get(id);
    return row ? decodeRows(MaintenanceRuleSchema, [row])[0] : undefined;
  }
  function listRuns(ruleId: string, limit = 20): MaintenanceRun[] {
    return decodeRows(
      MaintenanceRunSchema,
      db
        .prepare(
          "SELECT * FROM maintenance_run WHERE rule_id = ? ORDER BY triggered_at DESC, id DESC LIMIT ?",
        )
        .all(ruleId, limit),
    );
  }

  const todayStart = () => `${iso().slice(0, 10)}T00:00:00.000Z`;
  function runsToday(ruleId: string): number {
    return (
      db
        .prepare<{ n: number }>(
          "SELECT COUNT(*) AS n FROM maintenance_run WHERE rule_id = ? AND triggered_at >= ? AND status != 'skipped'",
        )
        .get(ruleId, todayStart())?.n ?? 0
    );
  }

  // ---- rules from maintenance.yml --------------------------------------------------------------

  function upsertRule(project: Project, def: RuleDef): void {
    const id = project.id + ":" + def.name;
    commands.upsertRule({
      id,
      projectId: project.id,
      name: def.name,
      triggerKind: def.trigger.kind,
      trigger: def.trigger,
      check: def.check,
      agent: def.agent ?? null,
      outputMode: def.output,
      priority: def.priority,
      dedupeKey: def.dedupe_key ?? null,
      dailyCap: def.daily_cap,
      enabled: def.enabled,
    });
    const rule = getRule(id)!;
    if (def.trigger.kind === "workload") {
      for (const kind of ["cards", "commits", "tokens"])
        if (!getCounter(project.id, ruleKey(rule, kind)))
          setCounter(project.id, ruleKey(rule, kind), 0);
    }
  }

  /**
   * Merge built-in defaults, the global UI rules and each project's maintenance.yml (only when
   * either changed) and update the rule table: one row per rule x applicable project. A row whose
   * rule no longer applies to its project is disabled, never deleted (history and counters stay).
   */
  async function syncRules(): Promise<void> {
    const ui = uiRules();
    for (const project of store.projects.list()) {
      if (!project.repoPath) continue;
      const config = await loadConfig(project.repoPath);
      const signature = `${config.signature}|ui|${JSON.stringify(ui)}`;
      const cached = configCache.get(project.id);
      if (cached?.signature === signature) continue;
      const merged = mergeRuleLayers({
        builtin: BUILTIN_RULES,
        ui,
        projectId: project.id,
        yml: config.yml,
      });
      const errors = [...config.errors, ...merged.errors];
      configCache.set(project.id, {
        signature,
        errors,
        layered: new Map(merged.rules.map((r) => [r.def.name, r])),
      });
      for (const error of errors) log(`${project.prefix}: ${error}`);
      const names = new Set(merged.rules.map((r) => r.def.name));
      for (const layered of merged.rules) upsertRule(project, layered.def);
      for (const rule of listRules(project.id)) {
        if (!names.has(rule.name) && rule.enabled) {
          commands.setRuleEnabled(rule.id, false);
        }
      }
    }
  }

  const layeredOf = (rule: MaintenanceRule): LayeredRule | undefined =>
    configCache.get(rule.projectId)?.layered.get(rule.name);

  // ---- rejection tracking (auto pause) -----------------------------------------------------------

  function resetRejections(ruleId: string, projectId: string): void {
    setCounter(projectId, `${ruleId}:rejects`, 0);
  }

  function rejectWorkspace(workspaceId: string): void {
    const link = commands.links({ workspaceId })[0];
    if (
      !link ||
      store.tasks.get(workspaceId)?.phase === "completed" ||
      !commands.rejectTask(workspaceId)
    )
      return;
    const rule = getRule(link.ruleId);
    if (!rule) return;
    const count = bump(link.projectId, rule.id + ":rejects");
    if (count >= settings().pauseAfterRejections && !rule.pausedAt) {
      commands.setRulePaused(rule.id, true);
      publishEvent(
        db,
        {
          type: "maintenance.paused",
          projectId: link.projectId,
          payload: {
            ruleId: rule.id,
            ruleName: rule.name,
            reason: "rejections",
            rejections: count,
          },
          dedupeKey: "maintenance.paused:" + rule.id + ":" + count,
        },
        now,
      );
      store.tasks.setSummary(
        workspaceId,
        "维护规则「" + rule.name + "」连续 " + count + " 个任务被驳回，已暂停，可在维护设置恢复。",
      );
    }
  }

  const consumer: EventConsumer = createEventConsumer({
    db,
    consumer: "vibe-maintain-task",
    types: ["task.updated"],
    startAt: "beginning",
    now,
    pollIntervalMs: options.pollIntervalMs,
    onError: (error, seq) => log("维护事件 " + seq + " 处理失败", error),
    handler: async (event) => {
      if (!isEvent(event, "task.updated")) return;
      const task = store.tasks.get(event.payload.workspaceId);
      if (!task) return;
      const link = commands.links({ workspaceId: task.workspaceId })[0];
      if (task.phase !== "completed") return;
      if (link && !link.rejectedAt) resetRejections(link.ruleId, link.projectId);
      const projectId = link?.projectId ?? (await options.projectIdOfTask?.(task.workspaceId));
      if (
        !projectId ||
        !commands.once(projectId, "completed-task:" + task.workspaceId + ":" + task.confirmedAt)
      )
        return;
      if (listRules(projectId).length === 0) await syncRules();
      for (const rule of listRules(projectId)) {
        if (rule.triggerKind === "workload") bump(projectId, ruleKey(rule, "cards"));
      }
    },
  });

  // ---- triggers -------------------------------------------------------------------------------------

  function tokensSince(projectId: string, since: string): number {
    const has = db
      .prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'usage_event'")
      .get();
    if (!has) return 0;
    return (
      db
        .prepare<{ n: number | null }>(
          `SELECT SUM(u.tokens_in + u.tokens_out) AS n FROM usage_event u WHERE u.project_id = ? AND u.ts >= ?`,
        )
        .get(projectId, since)?.n ?? 0
    );
  }

  async function commitsSince(project: Project, since: string): Promise<number> {
    const trunk = await trunkOf(git, project.repoPath);
    if (!trunk) return 0;
    const res = await git(
      ["rev-list", "--count", "--no-merges", `--since=${since}`, trunk],
      project.repoPath,
    );
    return res.code === 0 ? Number(res.stdout.trim()) || 0 : 0;
  }

  async function workloadReason(
    rule: MaintenanceRule,
    project: Project,
  ): Promise<TriggerReason | null> {
    const t = rule.trigger as WorkloadTrigger;
    const reasons: string[] = [];
    const cards = getCounter(project.id, ruleKey(rule, "cards"));
    if (t.cards_done && (cards?.count ?? 0) >= t.cards_done) {
      reasons.push(`已完成任务 ${cards!.count} 个，达到阈值 ${t.cards_done}`);
    }
    if (t.commits_merged) {
      const c = getCounter(project.id, ruleKey(rule, "commits"));
      const last = lastCommitPoll.get(rule.id) ?? 0;
      if (c && now().getTime() - last >= commitPollMs()) {
        lastCommitPoll.set(rule.id, now().getTime());
        const n = await commitsSince(project, c.since);
        setCounter(project.id, ruleKey(rule, "commits"), n);
      }
      const n = getCounter(project.id, ruleKey(rule, "commits"))?.count ?? 0;
      if (n >= t.commits_merged) reasons.push(`已合并提交 ${n} 个，达到阈值 ${t.commits_merged}`);
    }
    if (t.tokens) {
      const c = getCounter(project.id, ruleKey(rule, "tokens"));
      if (c) setCounter(project.id, ruleKey(rule, "tokens"), tokensSince(project.id, c.since));
      const n = getCounter(project.id, ruleKey(rule, "tokens"))?.count ?? 0;
      if (n >= t.tokens) reasons.push(`已消耗 ${n} token，达到阈值 ${t.tokens}`);
    }
    return reasons.length ? { reason: reasons.join("；") } : null;
  }

  function timeReason(rule: MaintenanceRule): TriggerReason | null {
    const t = rule.trigger as TimeTrigger;
    const last = listRuns(rule.id, 1)[0]?.triggeredAt ?? rule.createdAt;
    try {
      const fire = latestFire(t.cron, new Date(last), now());
      return fire ? { reason: `定时 ${t.cron}（${fire.toISOString()}）` } : null;
    } catch (error) {
      log(`规则「${rule.name}」cron 配置无效`, error);
      return null;
    }
  }

  /** Reads what was appended to the watched file since the last look. */
  async function eventReason(
    rule: MaintenanceRule,
    project: Project,
  ): Promise<(TriggerReason & { commit(): void }) | null> {
    const t = rule.trigger as EventTrigger;
    const path = isAbsolute(t.path) ? t.path : join(project.repoPath, t.path);
    const kind = ruleKey(rule, "file");
    const info = await stat(path).catch(() => null);
    const saved = getCounter(project.id, kind);
    if (!saved) {
      setCounter(project.id, kind, info?.size ?? 0);
      return null;
    }
    if (!info) return null;
    const from = info.size < saved.count ? 0 : saved.count;
    if (info.size === from) {
      if (info.size !== saved.count) setCounter(project.id, kind, info.size);
      return null;
    }
    const length = Math.min(info.size - from, MAX_EVENT_READ);
    const handle = await open(path, "r");
    let text = "";
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, info.size - length);
      text = buffer.toString("utf8");
    } finally {
      await handle.close();
    }
    const pattern = t.pattern ? new RegExp(t.pattern) : null;
    const matched = text.split(/\r?\n/).filter((l) => l.trim() && (!pattern || pattern.test(l)));
    const commit = () => setCounter(project.id, kind, info.size);
    if (matched.length === 0) {
      commit();
      return null;
    }
    return {
      reason: `${t.path} 有 ${matched.length} 条新记录`,
      detail: matched.slice(-20),
      commit,
    };
  }

  // ---- running a rule ----------------------------------------------------------------------------------

  function gate(rule: MaintenanceRule): "paused" | "daily_cap" | "disabled" | null {
    if (!rule.enabled) return "disabled";
    if (rule.pausedAt) return "paused";
    if (runsToday(rule.id) >= rule.dailyCap) return "daily_cap";
    return null;
  }

  const openTaskFor = (rule: MaintenanceRule) =>
    commands
      .links({ ruleId: rule.id })
      .find((link) => !link.rejectedAt && store.tasks.get(link.workspaceId)?.phase !== "completed");

  function promptVars(
    rule: MaintenanceRule,
    project: Project,
    trigger: TriggerReason,
    out: CheckOutput,
  ): PromptVars {
    return {
      project: project.name,
      rule: rule.name,
      trigger_reason: trigger.reason,
      check_description: describeCheck(rule.check as { type: string } & Record<string, unknown>),
      card_title: out.title,
      summary: out.body + (out.acceptance ? "\n\n验收要求：\n" + out.acceptance : ""),
      findings_json: JSON.stringify(out.findings),
      findings_count: String(out.findings.length),
      date: iso().slice(0, 10),
    };
  }

  async function plan(
    rule: MaintenanceRule,
    project: Project,
    out: CheckOutput,
    trigger: TriggerReason,
  ): Promise<string[]> {
    const launcher = options.taskLauncher;
    if (!launcher) throw new Error("维护任务需要已连接的原生规划入口");
    const existing = openTaskFor(rule);
    const keys = new Set(existing?.findings.map((finding) => findingKey(finding)) ?? []);
    const findings = out.findings.filter((finding) => {
      const key = findingKey(finding);
      if (keys.has(key)) return false;
      keys.add(key);
      return true;
    });
    if (existing && findings.length === 0) return [existing.workspaceId];
    const kind = rule.outputMode === "fix" ? "fix" : "review";
    const template =
      layeredOf(rule)?.def.prompts[kind] ??
      store.prompts.body("maintenance." + kind, { projectId: project.id }).text;
    const newFindings = findings
      .map((finding) => `- ${finding.subject}：${finding.detail}`)
      .join("\n");
    const prompt = buildPrompt(
      kind,
      template,
      promptVars(rule, project, trigger, {
        ...out,
        findings,
        body: existing
          ? `维护检查补充新发现，请据此更新方案。原有发现仍保留在会话中。\n\n新增发现：\n${newFindings}`
          : out.body,
      }),
      out.instructions,
    );

    if (!existing) {
      const created = await launcher.launch({
        rule,
        project,
        prompt,
        onCreated: (task) =>
          commands.linkTask({
            workspaceId: task.workspaceId,
            ruleId: rule.id,
            projectId: project.id,
            dedupeKey: out.dedupeKey ?? rule.dedupeKey ?? rule.name,
            findings,
          }),
      });
      store.tasks.setSummary(created.workspaceId, "维护检查已发起规划；方案完成后等待用户 /执行。");
      return [created.workspaceId];
    }
    // Persist new findings before requesting Stop so a timeout cannot lose the discovery.
    const task = store.tasks.get(existing.workspaceId)!;
    const active =
      task.confirmedAt !== null ||
      task.subtaskRuns.some((run) => ["running", "waiting"].includes(run.state));
    let stopped = !active;
    if (active) {
      try {
        stopped = (await options.stopTask?.(task.workspaceId)) === true;
      } catch (error) {
        log("维护任务停止请求失败", error);
      }
    }
    if (!stopped) {
      if (store.tasks.get(task.workspaceId)?.phase !== "paused")
        store.tasks.setPhase(task.workspaceId, "paused");
      publishEvent(
        db,
        {
          type: "scheduler.task_resource_request",
          payload: { requestId: newId(), workspaceId: task.workspaceId, action: "freeze" },
        },
        now,
      );
      store.tasks.setSummary(
        task.workspaceId,
        "维护补充发现已保存；任务已暂停派发，但停止尚未落实，原租约仍保留。禁止按旧文件范围继续执行；停止后须重新规划并确认。\n新增发现：\n" +
          JSON.stringify(findings) +
          "",
      );
      throw new Error("维护发现已保留，停止状态不确定；禁止替换已确认方案");
    }
    const currentTask = store.tasks.get(task.workspaceId)!;
    if (!["planning", "awaiting_confirmation", "paused", "failed"].includes(currentTask.phase))
      store.tasks.setPhase(task.workspaceId, "paused");
    if (store.tasks.get(task.workspaceId)!.phase !== "planning")
      store.tasks.setPhase(task.workspaceId, "planning");
    store.tasks.setSummary(
      task.workspaceId,
      "维护发现有变化，旧执行确认已清除；请重新规划并等待用户 /执行。",
    );
    await launcher.append({
      workspaceId: task.workspaceId,
      anchorAgentId: task.anchorAgentId,
      prompt,
    });
    commands.appendFindings(existing.workspaceId, findings);
    return [task.workspaceId];
  }

  function finishRun(
    runId: string,
    status: "done" | "failed" | "skipped",
    findings: unknown,
    workspaceIds: string[],
  ): MaintenanceRun {
    commands.finishRun(runId, status, findings, workspaceIds);
    return decodeRows(MaintenanceRunSchema, [
      db.prepare("SELECT * FROM maintenance_run WHERE id = ?").get(runId)!,
    ])[0]!;
  }

  function resetCounters(rule: MaintenanceRule): void {
    if (rule.triggerKind !== "workload") return;
    for (const kind of ["cards", "commits", "tokens"])
      setCounter(rule.projectId, ruleKey(rule, kind), 0, iso());
    lastCommitPoll.delete(rule.id);
  }

  async function execute(
    rule: MaintenanceRule,
    trigger: TriggerReason,
    force = false,
  ): Promise<FireOutcome> {
    const blocked = gate(rule);
    if (blocked && !(force && (blocked === "paused" || blocked === "daily_cap"))) {
      return { status: "blocked", why: blocked };
    }
    if (inflight.has(rule.id)) return { status: "blocked", why: "busy" };
    const project = store.projects.get(rule.projectId);
    if (!project) return { status: "blocked", why: "disabled" };
    inflight.add(rule.id);
    const runId = newId();
    try {
      commands.startRun({
        id: runId,
        ruleId: rule.id,
        projectId: project.id,
        dedupeKey: rule.dedupeKey ?? rule.name,
      });
      publishEvent(
        db,
        {
          type: "maintenance.triggered",
          projectId: project.id,
          payload: { ruleId: rule.id, runId },
          dedupeKey: `maintenance.triggered:${runId}`,
        },
        now,
      );
      resetCounters(rule);
      let output: CheckOutput | null = null;
      try {
        const { type, ...checkOptions } = rule.check as { type: string } & Record<string, unknown>;
        const check = checks[type];
        if (!check) throw new Error(`未知维护检查类型「${type}」`);
        const out = (output = await check({
          project,
          rule,
          options: checkOptions,
          now: now(),
          git,
          trigger,
          cursor: {
            get: (key) => getCounter(project.id, `${rule.id}:cursor:${key}`)?.count,
            set: (key, value) => setCounter(project.id, `${rule.id}:cursor:${key}`, value),
          },
          hasOpenTask: (key) =>
            commands
              .links({ ruleId: rule.id })
              .some(
                (link) =>
                  link.dedupeKey === key &&
                  !link.rejectedAt &&
                  store.tasks.get(link.workspaceId)?.phase !== "completed",
              ),
        }));
        if (!out) return { status: "fired", run: finishRun(runId, "done", [], []) };
        const workspaceIds = await plan(rule, project, out, trigger);
        out.commit?.();
        return {
          status: "fired",
          run: finishRun(runId, "done", out.findings as Finding[], workspaceIds),
        };
      } catch (error) {
        log(`规则「${rule.name}」运行失败`, error);
        const message = error instanceof Error ? error.message : String(error);
        return {
          status: "fired",
          run: finishRun(
            runId,
            "failed",
            [...(output?.findings ?? []), { error: message }],
            openTaskFor(rule) ? [openTaskFor(rule)!.workspaceId] : [],
          ),
        };
      }
    } finally {
      inflight.delete(rule.id);
    }
  }

  // ---- public ---------------------------------------------------------------------------------------------

  /** One pass: consume bus events, refresh rules, evaluate triggers. */
  async function tick(): Promise<void> {
    if (!settings().enabled) return;
    await syncRules();
    await consumer.poll();
    for (const rule of listRules()) {
      if (!rule.enabled || rule.pausedAt) continue;
      const project = store.projects.get(rule.projectId);
      if (!project || project.archivedAt) continue;
      try {
        if (gate(rule)) continue;
        if (rule.triggerKind === "workload") {
          const reason = await workloadReason(rule, project);
          if (reason) await execute(rule, reason);
        } else if (rule.triggerKind === "time") {
          const reason = timeReason(rule);
          if (reason) await execute(rule, reason);
        } else {
          const reason = await eventReason(rule, project);
          if (reason) {
            const outcome = await execute(rule, reason);
            if (outcome.status === "fired") reason.commit();
          }
        }
      } catch (error) {
        log(`规则「${rule.name}」触发检查失败`, error);
      }
    }
  }

  return {
    tick,
    rejectWorkspace,
    syncRules,
    listRules,
    getRule,
    listRuns,
    consumer,
    /** Manual run of one rule x project row (ignores thresholds, the daily cap and a pause). */
    async runNow(ruleId: string): Promise<FireOutcome> {
      const rule = getRule(ruleId);
      if (!rule) throw new Error(`维护规则不存在：${ruleId}`);
      return execute(rule, { reason: "手动触发" }, true);
    },
    /** Manual run of a rule by name for one project, or for every project it applies to. */
    async runRuleNow(
      name: string,
      projectId?: string,
    ): Promise<Array<{ projectId: string; outcome: FireOutcome }>> {
      const rows = listRules().filter(
        (r) =>
          r.name === name &&
          (!projectId || r.projectId === projectId) &&
          layeredOf(r) !== undefined,
      );
      if (rows.length === 0)
        throw new Error(`维护规则「${name}」不适用于${projectId ?? "任何项目"}`);
      const results: Array<{ projectId: string; outcome: FireOutcome }> = [];
      for (const row of rows)
        results.push({
          projectId: row.projectId,
          outcome: await execute(row, { reason: "手动触发" }, true),
        });
      return results;
    },
    resume(ruleId: string): MaintenanceRule {
      const rule = getRule(ruleId);
      if (!rule) throw new Error(`维护规则不存在：${ruleId}`);
      commands.setRulePaused(ruleId, false);
      resetRejections(ruleId, rule.projectId);
      return getRule(ruleId)!;
    },
    status() {
      const globalErrors = resolveGlobalRules(BUILTIN_RULES, uiRules()).errors;
      return {
        rules: listRules().map((rule) => {
          const counters: Record<string, number> = {};
          for (const kind of ["cards", "commits", "tokens", "rejects"]) {
            const c = getCounter(rule.projectId, ruleKey(rule, kind));
            if (c) counters[kind] = c.count;
          }
          const layered = layeredOf(rule);
          const trigger = layered?.def.trigger ?? (rule.trigger as RuleDef["trigger"]);
          return {
            rule,
            counters,
            origin: layered?.origin ?? null,
            sources: layered?.sources ?? null,
            ymlFields: layered ? ymlFieldsOf(layered.sources) : [],
            base: layered?.base ?? null,
            prompts: {
              review: layered?.def.prompts.review ?? null,
              fix: layered?.def.prompts.fix ?? null,
            },
            triggerText: describeTrigger(trigger),
            progressText: progressText(trigger, counters),
            checkText: describeCheck(rule.check as { type: string } & Record<string, unknown>),
            /** False once the rule left every config layer (kept disabled in the table for its history). */
            defined: layered !== undefined || !configCache.has(rule.projectId),
            runsToday: runsToday(rule.id),
            lastRun: listRuns(rule.id, 1)[0] ?? null,
            blocked: gate(rule),
            projectName: store.projects.get(rule.projectId)?.name ?? null,
          };
        }),
        rulesGlobal: resolveGlobalRules(BUILTIN_RULES, uiRules()).rules,
        configErrors: {
          ...(globalErrors.length ? { [GLOBAL_ERRORS]: globalErrors } : {}),
          ...Object.fromEntries(
            [...configCache.entries()]
              .filter(([, v]) => v.errors.length)
              .map(([k, v]) => [k, v.errors]),
          ),
        },
      };
    },
    start(): void {
      consumer.start();
    },
    async stop(): Promise<void> {
      await consumer.stop();
      while (inflight.size > 0) await new Promise((resolve) => setTimeout(resolve, 25));
    },
  };
}

export type MaintenanceEngine = ReturnType<typeof createMaintenanceEngine>;
