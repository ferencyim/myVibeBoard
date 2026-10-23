// GENERATED FROM plugins/vibe-shared — DO NOT EDIT (run: node scripts/vibe/sync-shared.mjs)
import type { VibeDb } from "./sqlite";
import type { MaintenanceRule } from "../contract/model";

export interface MaintenanceTaskLink {
  workspaceId: string;
  ruleId: string;
  projectId: string;
  dedupeKey: string;
  findings: unknown[];
  rejectedAt: string | null;
}

/** Maintains rule history and task links without writing legacy cards. */
export function createMaintenanceCommands(db: VibeDb, options: { now?: () => Date } = {}) {
  const iso = () => (options.now?.() ?? new Date()).toISOString();
  const counter = (projectId: string, kind: string) =>
    db
      .prepare<{ count: number; since: string }>(
        "SELECT count, since FROM work_counter WHERE project_id = ? AND kind = ?",
      )
      .get(projectId, kind);
  const setCounter = (projectId: string, kind: string, count: number, since?: string) => {
    if (!Number.isFinite(count)) throw new Error("维护计数必须是有限数字");
    db.prepare(
      "INSERT INTO work_counter (project_id, kind, count, since) VALUES (?, ?, ?, ?) ON CONFLICT (project_id, kind) DO UPDATE SET count = excluded.count, since = COALESCE(?, work_counter.since)",
    ).run(projectId, kind, count, since ?? iso(), since ?? null);
  };
  return {
    counter,
    setCounter,
    bump(projectId: string, kind: string): number {
      return db.immediate(() => {
        const n = (counter(projectId, kind)?.count ?? 0) + 1;
        setCounter(projectId, kind, n);
        return n;
      });
    },
    once(projectId: string, kind: string): boolean {
      return (
        db
          .prepare(
            "INSERT OR IGNORE INTO work_counter (project_id, kind, count, since) VALUES (?, ?, 1, ?)",
          )
          .run(projectId, kind, iso()).changes === 1
      );
    },
    upsertRule(
      input: Pick<
        MaintenanceRule,
        | "id"
        | "projectId"
        | "name"
        | "triggerKind"
        | "trigger"
        | "check"
        | "agent"
        | "outputMode"
        | "priority"
        | "dedupeKey"
        | "dailyCap"
        | "enabled"
      >,
    ) {
      db.prepare(
        "INSERT INTO maintenance_rule (id, project_id, name, trigger_kind, trigger_json, check_json, agent, output_mode, priority, dedupe_key, daily_cap, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET trigger_kind=excluded.trigger_kind, trigger_json=excluded.trigger_json, check_json=excluded.check_json, agent=excluded.agent, output_mode=excluded.output_mode, priority=excluded.priority, dedupe_key=excluded.dedupe_key, daily_cap=excluded.daily_cap, enabled=excluded.enabled, updated_at=excluded.updated_at",
      ).run(
        input.id,
        input.projectId,
        input.name,
        input.triggerKind,
        JSON.stringify(input.trigger),
        JSON.stringify(input.check),
        input.agent,
        input.outputMode,
        input.priority,
        input.dedupeKey,
        input.dailyCap,
        Number(input.enabled),
        iso(),
        iso(),
      );
    },
    setRuleEnabled(ruleId: string, enabled: boolean) {
      db.prepare("UPDATE maintenance_rule SET enabled = ?, updated_at = ? WHERE id = ?").run(
        Number(enabled),
        iso(),
        ruleId,
      );
    },
    setRulePaused(ruleId: string, paused: boolean) {
      db.prepare("UPDATE maintenance_rule SET paused_at = ?, updated_at = ? WHERE id = ?").run(
        paused ? iso() : null,
        iso(),
        ruleId,
      );
    },
    startRun(input: { id: string; ruleId: string; projectId: string; dedupeKey: string }) {
      db.prepare(
        "INSERT INTO maintenance_run (id, rule_id, project_id, triggered_at, status, dedupe_key) VALUES (?, ?, ?, ?, 'running', ?)",
      ).run(input.id, input.ruleId, input.projectId, iso(), input.dedupeKey);
    },
    finishRun(
      id: string,
      status: "done" | "failed" | "skipped",
      findings: unknown,
      workspaceIds: string[],
    ) {
      db.prepare(
        "UPDATE maintenance_run SET status = ?, finished_at = ?, findings_json = ?, workspace_ids_json = ? WHERE id = ?",
      ).run(status, iso(), JSON.stringify(findings), JSON.stringify(workspaceIds), id);
    },
    links(filter: { ruleId?: string; workspaceId?: string } = {}): MaintenanceTaskLink[] {
      return db
        .prepare<{
          workspace_id: string;
          rule_id: string;
          project_id: string;
          dedupe_key: string;
          findings_json: string;
          rejected_at: string | null;
        }>(
          "SELECT * FROM maintenance_task WHERE (? IS NULL OR rule_id = ?) AND (? IS NULL OR workspace_id = ?)",
        )
        .all(
          filter.ruleId ?? null,
          filter.ruleId ?? null,
          filter.workspaceId ?? null,
          filter.workspaceId ?? null,
        )
        .map((row) => ({
          workspaceId: row.workspace_id,
          ruleId: row.rule_id,
          projectId: row.project_id,
          dedupeKey: row.dedupe_key,
          findings: JSON.parse(row.findings_json) as unknown[],
          rejectedAt: row.rejected_at,
        }));
    },
    linkTask(input: Omit<MaintenanceTaskLink, "rejectedAt">) {
      db.prepare(
        "INSERT INTO maintenance_task (workspace_id, rule_id, project_id, dedupe_key, findings_json) VALUES (?, ?, ?, ?, ?)",
      ).run(
        input.workspaceId,
        input.ruleId,
        input.projectId,
        input.dedupeKey,
        JSON.stringify(input.findings),
      );
    },
    appendFindings(workspaceId: string, findings: unknown[]) {
      db.immediate(() => {
        const row = db
          .prepare<{ findings_json: string }>(
            "SELECT findings_json FROM maintenance_task WHERE workspace_id = ?",
          )
          .get(workspaceId);
        if (!row) throw new Error("维护任务关联不存在");
        const previous = JSON.parse(row.findings_json) as unknown[];
        const keys = new Set(previous.map((item) => JSON.stringify(item)));
        const added = findings.filter((item) => !keys.has(JSON.stringify(item)));
        db.prepare("UPDATE maintenance_task SET findings_json = ? WHERE workspace_id = ?").run(
          JSON.stringify([...previous, ...added]),
          workspaceId,
        );
      });
    },
    rejectTask(workspaceId: string): boolean {
      return (
        db
          .prepare(
            "UPDATE maintenance_task SET rejected_at = ? WHERE workspace_id = ? AND rejected_at IS NULL",
          )
          .run(iso(), workspaceId).changes === 1
      );
    },
  };
}
