import type { createMaintenanceEngine } from "./engine";
import { cronMatches, parseCron } from "./cron";

type Status = ReturnType<ReturnType<typeof createMaintenanceEngine>["status"]>;

/** A projection only: maintenance configuration and execution remain owned by the engine. */
export function systemRoutines(status: Status, now = new Date()) {
  return status.rules.filter((row) => row.defined).map((row) => {
    const { rule, lastRun } = row;
    const trigger = rule.trigger as { cron?: unknown };
    const expression = rule.triggerKind === "time" && typeof trigger.cron === "string" ? trigger.cron : null;
    const nextRunAt = expression && rule.enabled && !rule.pausedAt ? nextCron(expression, now) : null;
    const findings = Array.isArray(lastRun?.findings) ? lastRun.findings : [];
    const failure = findings.find((item) => item && typeof item === "object" && "error" in item && typeof item.error === "string") as { error: string } | undefined;
    return {
      id: rule.id, title: rule.name, projectId: rule.projectId,
      projectName: row.projectName ?? rule.projectId,
      schedule: expression ? { kind: "cron" as const, expression } : null,
      scheduleText: row.triggerText,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      nextRunAt, paused: !rule.enabled || !!rule.pausedAt,
      lastRunAt: lastRun?.triggeredAt ?? null, lastStatus: lastRun?.status ?? null,
      lastError: failure?.error ?? null,
      editKey: row.origin === "yml" ? `${rule.projectId}:${rule.name}` : rule.name,
    };
  });
}

function nextCron(expression: string, now: Date): string | null {
  try {
    const spec = parseCron(expression);
    const date = new Date(now);
    date.setSeconds(0, 0);
    date.setMinutes(date.getMinutes() + 1);
    const limit = now.getTime() + 366 * 86_400_000;
    while (date.getTime() <= limit) {
      if (cronMatches(spec, date)) return date.toISOString();
      date.setTime(date.getTime() + 60_000);
    }
  } catch { /* An invalid configuration has no projected occurrence. */ }
  return null;
}
