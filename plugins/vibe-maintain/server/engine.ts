// The maintenance engine: syncs rules from .vibe/maintenance.yml, counts work, decides when a rule
// fires (workload / cron / file change), runs its check and files the result as a board card.
//
// Controls (docs/vibe/IMPLEMENTATION-PLAN.md M10): maintenance cards are low priority, every rule
// has a daily cap, an open card with the same dedupe key only gets a note appended, and a rule
// whose cards the user keeps rejecting is paused (with a `maintenance.paused` event).
//
// Everything time- or IO-dependent is injected (clock, git runner, checks, sub agent, launcher), so
// the tests drive it with a fake clock and real temporary git repositories.

import { randomUUID } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { latestFire } from "./cron";
import { loadConfig, type RuleDef } from "./config";
import { trunkOf } from "./git/check";
import type { GitRunner } from "./git/exec";
import type {
  CheckOutput,
  CheckRegistry,
  Finding,
  FixLauncher,
  SubAgentRunner,
} from "./types";
import {
  CARD_PRIORITIES,
  MaintenanceRuleSchema,
  MaintenanceRunSchema,
  isEvent,
  type CardPriority,
  type CardView,
  type MaintenanceRule,
  type MaintenanceRun,
  type Project,
} from "./vibe/contract";
import {
  createEventConsumer,
  decodeRows,
  publishEvent,
  type EventConsumer,
  type VibeDb,
  type VibeStore,
} from "./vibe/db";

export interface EngineSettings {
  enabled: boolean;
  /** Pause a rule after this many consecutive rejected cards. */
  pauseAfterRejections: number;
}

export interface EngineOptions {
  db: VibeDb;
  store: VibeStore;
  now?: () => Date;
  git: GitRunner;
  checks: CheckRegistry;
  settings?: () => EngineSettings;
  subAgent?: SubAgentRunner;
  fixLauncher?: FixLauncher;
  newId?: () => string;
  /** Minimum seconds between `git rev-list` polls per rule (commit-count triggers). */
  commitPollSeconds?: number;
  pollIntervalMs?: number;
  log?: (message: string, error?: unknown) => void;
}

export const DEFAULT_ENGINE_SETTINGS: EngineSettings = { enabled: true, pauseAfterRejections: 3 };

type WorkloadTrigger = { kind: "workload"; cards_done?: number; commits_merged?: number; tokens?: number };
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

export function createMaintenanceEngine(options: EngineOptions) {
  const { db, store, git, checks } = options;
  const now = options.now ?? (() => new Date());
  const settings = options.settings ?? (() => DEFAULT_ENGINE_SETTINGS);
  const newId = options.newId ?? randomUUID;
  const log = options.log ?? (() => undefined);
  const commitPollMs = (options.commitPollSeconds ?? 60) * 1000;

  const configCache = new Map<string, { signature: string; errors: string[] }>();
  const inflight = new Set<string>();
  const lastCommitPoll = new Map<string, number>();

  // ---- small helpers -------------------------------------------------------------------------

  const iso = () => now().toISOString();
  const ruleKey = (rule: MaintenanceRule, kind: string) => `${rule.id}:${kind}`;

  function getCounter(projectId: string, kind: string): { count: number; since: string } | undefined {
    const row = db
      .prepare<{ count: number; since: string }>(
        "SELECT count, since FROM work_counter WHERE project_id = ? AND kind = ?",
      )
      .get(projectId, kind);
    return row ? { count: row.count, since: row.since } : undefined;
  }
  function setCounter(projectId: string, kind: string, count: number, since?: string): void {
    db.prepare(
      `INSERT INTO work_counter (project_id, kind, count, since) VALUES (?, ?, ?, ?)
       ON CONFLICT (project_id, kind) DO UPDATE SET count = excluded.count,
         since = COALESCE(?, work_counter.since)`,
    ).run(projectId, kind, count, since ?? iso(), since ?? null);
  }
  function bump(projectId: string, kind: string): number {
    const next = (getCounter(projectId, kind)?.count ?? 0) + 1;
    setCounter(projectId, kind, next);
    return next;
  }

  function listRules(projectId?: string): MaintenanceRule[] {
    const rows = projectId
      ? db.prepare("SELECT * FROM maintenance_rule WHERE project_id = ? ORDER BY name").all(projectId)
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
        .prepare("SELECT * FROM maintenance_run WHERE rule_id = ? ORDER BY triggered_at DESC, id DESC LIMIT ?")
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
    const id = `${project.id}:${def.name}`;
    const row = {
      trigger_kind: def.trigger.kind,
      trigger_json: JSON.stringify(def.trigger),
      check_json: JSON.stringify(def.check),
      agent: def.agent ?? null,
      output_mode: def.output,
      priority: def.priority,
      dedupe_key: def.dedupe_key ?? null,
      daily_cap: def.daily_cap,
      enabled: def.enabled ? 1 : 0,
    };
    const existing = db.prepare<Record<string, unknown>>("SELECT * FROM maintenance_rule WHERE id = ?").get(id);
    if (!existing) {
      db.prepare(
        `INSERT INTO maintenance_rule (id, project_id, name, trigger_kind, trigger_json, check_json, agent,
           output_mode, priority, dedupe_key, daily_cap, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id, project.id, def.name, row.trigger_kind, row.trigger_json, row.check_json, row.agent,
        row.output_mode, row.priority, row.dedupe_key, row.daily_cap, row.enabled, iso(), iso(),
      );
    } else if (Object.entries(row).some(([k, v]) => existing[k] !== v)) {
      db.prepare(
        `UPDATE maintenance_rule SET trigger_kind = ?, trigger_json = ?, check_json = ?, agent = ?, output_mode = ?,
           priority = ?, dedupe_key = ?, daily_cap = ?, enabled = ?, updated_at = ? WHERE id = ?`,
      ).run(
        row.trigger_kind, row.trigger_json, row.check_json, row.agent, row.output_mode, row.priority,
        row.dedupe_key, row.daily_cap, row.enabled, iso(), id,
      );
    }
    const rule = getRule(id)!;
    if (def.trigger.kind === "workload") {
      for (const kind of ["cards", "commits", "tokens"]) {
        if (!getCounter(project.id, ruleKey(rule, kind))) setCounter(project.id, ruleKey(rule, kind), 0);
      }
    }
  }

  /** Re-read each project's maintenance.yml (only when its text changed) and update the rule table. */
  async function syncRules(): Promise<void> {
    for (const project of store.projects.list()) {
      if (!project.repoPath) continue;
      const config = await loadConfig(project.repoPath);
      const cached = configCache.get(project.id);
      if (cached?.signature === config.signature) continue;
      configCache.set(project.id, { signature: config.signature, errors: config.errors });
      for (const error of config.errors) log(`${project.prefix}: ${error}`);
      const names = new Set(config.rules.map((r) => r.name));
      for (const def of config.rules) upsertRule(project, def);
      for (const rule of listRules(project.id)) {
        if (!names.has(rule.name) && rule.enabled) {
          db.prepare("UPDATE maintenance_rule SET enabled = 0, updated_at = ? WHERE id = ?").run(iso(), rule.id);
        }
      }
    }
  }

  // ---- rejection tracking (auto pause) -----------------------------------------------------------

  function resetRejections(ruleId: string, projectId: string): void {
    setCounter(projectId, `${ruleId}:rejects`, 0);
  }

  function reject(ruleId: string, projectId: string, cardId: string): void {
    const rule = getRule(ruleId);
    if (!rule) return;
    // Each card counts once even if it is archived and later deleted.
    const marker = db
      .prepare("INSERT OR IGNORE INTO work_counter (project_id, kind, count, since) VALUES (?, ?, 1, ?)")
      .run(projectId, `rejected:${cardId}`, iso());
    if (marker.changes === 0) return;
    const count = bump(projectId, `${ruleId}:rejects`);
    if (count >= settings().pauseAfterRejections && !rule.pausedAt) {
      db.prepare("UPDATE maintenance_rule SET paused_at = ?, updated_at = ? WHERE id = ?").run(iso(), iso(), ruleId);
      publishEvent(
        db,
        {
          type: "maintenance.paused",
          projectId,
          payload: { ruleId, ruleName: rule.name, reason: "rejections", rejections: count },
          dedupeKey: `maintenance.paused:${ruleId}:${count}`,
        },
        now,
      );
      if (store.cards.get(cardId)) {
        store.events.add({
          cardId,
          type: "maintenance",
          authorKind: "system",
          author: rule.name,
          body: {
            kind: "rule_paused",
            ruleId,
            text: `规则「${rule.name}」连续 ${count} 张卡被驳回，已自动暂停。需要时在维护面板里恢复。`,
          },
        });
      }
    }
  }

  function ruleOfDeletedCard(cardId: string): string | undefined {
    return db
      .prepare<{ rule_id: string }>(
        "SELECT rule_id FROM maintenance_run WHERE card_ids_json LIKE ? ORDER BY triggered_at DESC LIMIT 1",
      )
      .get(`%"${cardId}"%`)?.rule_id;
  }

  function onCardDone(projectId: string): void {
    for (const rule of listRules(projectId)) {
      if (rule.triggerKind === "workload") bump(projectId, ruleKey(rule, "cards"));
    }
  }

  const consumer: EventConsumer = createEventConsumer({
    db,
    consumer: "vibe-maintain",
    types: ["card.moved", "card.updated", "card.deleted"],
    startAt: "now",
    now,
    pollIntervalMs: options.pollIntervalMs,
    onError: (error, seq) => log(`event ${seq} failed`, error),
    handler: async (event) => {
      const cardId = event.cardId;
      if (!cardId) return;
      if (isEvent(event, "card.deleted")) {
        const ruleId = ruleOfDeletedCard(cardId);
        if (ruleId && event.projectId) reject(ruleId, event.projectId, cardId);
        return;
      }
      const card = store.cards.get(cardId);
      if (!card) return;
      if (card.origin === "maintenance" && card.originRef) {
        if (isEvent(event, "card.moved")) {
          const { from, to, actor } = event.payload;
          if (to === "done" || (from === "draft" && to === "todo")) {
            resetRejections(card.originRef, card.projectId);
          } else if (from === "verifying" && to === "in_progress" && actor === "user") {
            reject(card.originRef, card.projectId, card.id);
          }
        } else if (
          isEvent(event, "card.updated") &&
          event.payload.fields.includes("archivedAt") &&
          card.archivedAt &&
          (card.column === "draft" || card.column === "todo")
        ) {
          reject(card.originRef, card.projectId, card.id);
        }
        return;
      }
      if (isEvent(event, "card.moved") && event.payload.to === "done") {
        // A brand-new project has no rules until the next sync: do not lose its first cards.
        if (listRules(card.projectId).length === 0) await syncRules();
        onCardDone(card.projectId);
      }
    },
  });

  // ---- triggers -------------------------------------------------------------------------------------

  function tokensSince(projectId: string, since: string): number {
    const has = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'usage_event'").get();
    if (!has) return 0;
    return (
      db
        .prepare<{ n: number | null }>(
          `SELECT SUM(u.tokens_in + u.tokens_out) AS n FROM usage_event u
           JOIN card c ON c.id = u.card_id WHERE c.project_id = ? AND u.ts >= ?`,
        )
        .get(projectId, since)?.n ?? 0
    );
  }

  async function commitsSince(project: Project, since: string): Promise<number> {
    const trunk = await trunkOf(git, project.repoPath);
    if (!trunk) return 0;
    const res = await git(["rev-list", "--count", "--no-merges", `--since=${since}`, trunk], project.repoPath);
    return res.code === 0 ? Number(res.stdout.trim()) || 0 : 0;
  }

  async function workloadReason(rule: MaintenanceRule, project: Project): Promise<TriggerReason | null> {
    const t = rule.trigger as WorkloadTrigger;
    const reasons: string[] = [];
    const cards = getCounter(project.id, ruleKey(rule, "cards"));
    if (t.cards_done && (cards?.count ?? 0) >= t.cards_done) {
      reasons.push(`累计完成 ${cards!.count} 张卡（阈值 ${t.cards_done}）`);
    }
    if (t.commits_merged) {
      const c = getCounter(project.id, ruleKey(rule, "commits"));
      const last = lastCommitPoll.get(rule.id) ?? 0;
      if (c && now().getTime() - last >= commitPollMs) {
        lastCommitPoll.set(rule.id, now().getTime());
        const n = await commitsSince(project, c.since);
        setCounter(project.id, ruleKey(rule, "commits"), n);
      }
      const n = getCounter(project.id, ruleKey(rule, "commits"))?.count ?? 0;
      if (n >= t.commits_merged) reasons.push(`累计合并 ${n} 个提交（阈值 ${t.commits_merged}）`);
    }
    if (t.tokens) {
      const c = getCounter(project.id, ruleKey(rule, "tokens"));
      if (c) setCounter(project.id, ruleKey(rule, "tokens"), tokensSince(project.id, c.since));
      const n = getCounter(project.id, ruleKey(rule, "tokens"))?.count ?? 0;
      if (n >= t.tokens) reasons.push(`累计消耗 ${n} token（阈值 ${t.tokens}）`);
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
      log(`rule ${rule.name}: bad cron`, error);
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

  const priorityOf = (rule: MaintenanceRule): CardPriority =>
    (CARD_PRIORITIES as readonly string[]).includes(rule.priority) ? (rule.priority as CardPriority) : "low";

  const openCardFor = (project: Project, key: string): CardView | undefined =>
    store.cards
      .list({ projectId: project.id })
      .find((c) => c.origin === "maintenance" && c.dedupeKey === key && c.column !== "done");

  function recordFindings(card: CardView, rule: MaintenanceRule, runId: string, out: CheckOutput, kind: string): void {
    store.events.add({
      cardId: card.id,
      type: "maintenance",
      authorKind: "system",
      author: rule.name,
      body: { kind, ruleId: rule.id, runId, text: out.body, findings: out.findings, notes: out.notes },
    });
  }

  async function repoState(project: Project): Promise<string> {
    const [head, status] = await Promise.all([
      git(["rev-parse", "HEAD"], project.repoPath),
      git(["status", "--porcelain"], project.repoPath),
    ]);
    return `${head.stdout.trim()}\n${status.stdout}`;
  }

  async function askSubAgent(card: CardView, rule: MaintenanceRule, project: Project, out: CheckOutput) {
    if (!rule.agent || !options.subAgent) return;
    const before = await repoState(project);
    const prompt = [
      `You are a read-only maintenance reviewer for the project "${project.name}" (rule "${rule.name}").`,
      "Do NOT modify files, branches or worktrees. Read the deterministic findings below and reply with a short,",
      "prioritised cleanup plan (what to do first, what is safe to delete, what needs the owner's decision).",
      "",
      out.body,
      "",
      "Findings (JSON):",
      JSON.stringify(out.findings),
    ].join("\n");
    try {
      const reply = await options.subAgent.run({ rule, project, prompt });
      const violated = (await repoState(project)) !== before;
      store.events.add({
        cardId: card.id,
        type: "note",
        authorKind: "agent",
        author: rule.agent,
        body: {
          kind: "maintenance_analysis",
          text: reply ?? "",
          ...(violated ? { warning: "The read-only sub agent changed the repository state." } : {}),
        },
      });
    } catch (error) {
      log(`sub agent for ${rule.name} failed`, error);
      store.events.add({
        cardId: card.id,
        type: "maintenance",
        authorKind: "system",
        author: rule.name,
        body: { kind: "sub_agent_failed", text: `子 agent 分析失败：${error instanceof Error ? error.message : String(error)}` },
      });
    }
  }

  async function suggest(rule: MaintenanceRule, project: Project, runId: string, out: CheckOutput): Promise<string[]> {
    const key = out.dedupeKey ?? rule.dedupeKey ?? rule.name;
    const existing = openCardFor(project, key);
    if (existing) {
      recordFindings(existing, rule, runId, out, "recurrence");
      return [existing.id];
    }
    const card = store.cards.create(
      {
        projectId: project.id,
        title: out.title,
        description: out.body,
        ...(out.acceptance ? { acceptance: out.acceptance } : {}),
        column: "draft",
        priority: priorityOf(rule),
        origin: "maintenance",
        originRef: rule.id,
        dedupeKey: key,
      },
      "dispatcher",
      rule.name,
    );
    recordFindings(card, rule, runId, out, "created");
    await askSubAgent(card, rule, project, out);
    return [card.id];
  }

  async function fix(rule: MaintenanceRule, project: Project, runId: string, out: CheckOutput): Promise<string[]> {
    const key = out.dedupeKey ?? rule.dedupeKey ?? rule.name;
    const existing = openCardFor(project, key);
    if (existing) {
      recordFindings(existing, rule, runId, out, "recurrence");
      return [existing.id];
    }
    const launcher = options.fixLauncher;
    if (!launcher) throw new Error("This rule has output=fix but no worker launcher is available");
    const provider = launcher.provider(rule, project); // fails before any card exists
    const agentId = newId();
    const card = store.cards.create(
      {
        projectId: project.id,
        title: out.title,
        description: out.body,
        ...(out.acceptance ? { acceptance: out.acceptance } : {}),
        ...(out.needsEvidence !== undefined ? { needsEvidence: out.needsEvidence } : {}),
        column: "in_progress",
        priority: priorityOf(rule),
        origin: "maintenance",
        originRef: rule.id,
        dedupeKey: key,
      },
      "dispatcher",
      rule.name,
    );
    const session = store.sessions.start({
      cardId: card.id,
      agentId,
      role: "worker",
      provider,
    });
    recordFindings(card, rule, runId, out, "created");
    const prompt = [
      `Maintenance rule "${rule.name}" found problems in ${project.name}. Investigate and fix them in this worktree.`,
      "Commit on this worktree's branch. Do NOT merge into the main branch and do not push: the owner reviews",
      "the evidence and merges. Finish with a short report of what changed and how you verified it.",
      ...(out.instructions ? ["", out.instructions] : []),
      "",
      out.body,
      "",
      "Findings (JSON):",
      JSON.stringify(out.findings),
    ].join("\n");
    try {
      const launched = await launcher.launch({
        agentId,
        cardKey: card.key,
        cardId: card.id,
        rule,
        project,
        prompt,
      });
      if (launched.worktree) store.cards.update(card.id, { worktree: launched.worktree });
    } catch (error) {
      store.sessions.setState(session.id, "ended", { outcome: "launch_failed" });
      store.cards.archive(card.id);
      throw error;
    }
    return [card.id];
  }

  function finishRun(runId: string, status: "done" | "failed" | "skipped", findings: unknown, cardIds: string[]): MaintenanceRun {
    db.prepare(
      "UPDATE maintenance_run SET status = ?, finished_at = ?, findings_json = ?, card_ids_json = ? WHERE id = ?",
    ).run(status, iso(), JSON.stringify(findings), JSON.stringify(cardIds), runId);
    return decodeRows(MaintenanceRunSchema, [db.prepare("SELECT * FROM maintenance_run WHERE id = ?").get(runId)!])[0]!;
  }

  function resetCounters(rule: MaintenanceRule): void {
    if (rule.triggerKind !== "workload") return;
    for (const kind of ["cards", "commits", "tokens"]) setCounter(rule.projectId, ruleKey(rule, kind), 0, iso());
    lastCommitPoll.delete(rule.id);
  }

  async function execute(rule: MaintenanceRule, trigger: TriggerReason, force = false): Promise<FireOutcome> {
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
      db.prepare(
        `INSERT INTO maintenance_run (id, rule_id, project_id, triggered_at, status, dedupe_key)
         VALUES (?, ?, ?, ?, 'running', ?)`,
      ).run(runId, rule.id, project.id, iso(), rule.dedupeKey ?? rule.name);
      publishEvent(
        db,
        { type: "maintenance.triggered", projectId: project.id, payload: { ruleId: rule.id, runId }, dedupeKey: `maintenance.triggered:${runId}` },
        now,
      );
      resetCounters(rule);
      try {
        const { type, ...checkOptions } = rule.check as { type: string } & Record<string, unknown>;
        const check = checks[type];
        if (!check) throw new Error(`Unknown check type "${type}"`);
        const out = await check({
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
          hasOpenCard: (key) => openCardFor(project, key) !== undefined,
        });
        if (!out) return { status: "fired", run: finishRun(runId, "done", [], []) };
        const cardIds =
          rule.outputMode === "fix" && !out.forceDraft
            ? await fix(rule, project, runId, out)
            : await suggest(rule, project, runId, out);
        out.commit?.();
        return { status: "fired", run: finishRun(runId, "done", out.findings as Finding[], cardIds) };
      } catch (error) {
        log(`rule ${rule.name} failed`, error);
        const message = error instanceof Error ? error.message : String(error);
        return { status: "fired", run: finishRun(runId, "failed", [{ error: message }], []) };
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
        log(`rule ${rule.name}: trigger evaluation failed`, error);
      }
    }
  }

  return {
    tick,
    syncRules,
    listRules,
    getRule,
    listRuns,
    consumer,
    /** Manual run (ignores thresholds, the daily cap and a pause). */
    async runNow(ruleId: string): Promise<FireOutcome> {
      const rule = getRule(ruleId);
      if (!rule) throw new Error(`Unknown rule: ${ruleId}`);
      return execute(rule, { reason: "手动触发" }, true);
    },
    resume(ruleId: string): MaintenanceRule {
      const rule = getRule(ruleId);
      if (!rule) throw new Error(`Unknown rule: ${ruleId}`);
      db.prepare("UPDATE maintenance_rule SET paused_at = NULL, updated_at = ? WHERE id = ?").run(iso(), ruleId);
      resetRejections(ruleId, rule.projectId);
      return getRule(ruleId)!;
    },
    status() {
      return {
        rules: listRules().map((rule) => {
          const counters: Record<string, number> = {};
          for (const kind of ["cards", "commits", "tokens", "rejects"]) {
            const c = getCounter(rule.projectId, ruleKey(rule, kind));
            if (c) counters[kind] = c.count;
          }
          return {
            rule,
            counters,
            runsToday: runsToday(rule.id),
            lastRun: listRuns(rule.id, 1)[0] ?? null,
            blocked: gate(rule),
            projectName: store.projects.get(rule.projectId)?.name ?? null,
          };
        }),
        configErrors: Object.fromEntries(
          [...configCache.entries()].filter(([, v]) => v.errors.length).map(([k, v]) => [k, v.errors]),
        ),
      };
    },
    start(): void {
      consumer.start();
    },
    async stop(): Promise<void> {
      await consumer.stop();
    },
  };
}

export type MaintenanceEngine = ReturnType<typeof createMaintenanceEngine>;
