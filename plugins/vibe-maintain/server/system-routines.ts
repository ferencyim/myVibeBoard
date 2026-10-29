import type { createMaintenanceEngine } from "./engine";
import { parseCron } from "./cron";
import { nextRoutineTime } from "./vibe/contract/routine-schedule";

type Status = ReturnType<ReturnType<typeof createMaintenanceEngine>["status"]>;

// Expand maintenance's `n/step` semantics for the shared calendar parser.
function calendarCron(expression: string): string {
  const spec = parseCron(expression);
  return [spec.minute, spec.hour, spec.dom, spec.month, spec.dow]
    .map((field) => field.any ? "*" : [...field.values].sort((a, b) => a - b).join(","))
    .join(" ");
}

function projection(expression: string | null, enabled: boolean, now: Date, timezone: string) {
  if (!expression) return { schedule: null, nextRunAt: null };
  try {
    const schedule = { kind: "cron" as const, expression: calendarCron(expression) };
    return { schedule, nextRunAt: enabled ? nextRoutineTime(schedule, timezone, now).toISOString() : null };
  } catch {
    return { schedule: null, nextRunAt: null };
  }
}

/** A projection only: maintenance configuration and execution remain owned by the engine. */
export function systemRoutines(status: Status, now = new Date()) {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return status.rules.filter((row) => row.defined).map((row) => {
    const { rule, lastRun } = row;
    const trigger = rule.trigger as { cron?: unknown };
    const expression = rule.triggerKind === "time" && typeof trigger.cron === "string" ? trigger.cron : null;
    const paused = !rule.enabled || !!rule.pausedAt;
    const { schedule, nextRunAt } = projection(expression, !paused, now, timezone);
    const findings = Array.isArray(lastRun?.findings) ? lastRun.findings : [];
    const failure = findings.find((item) => item && typeof item === "object" && "error" in item && typeof item.error === "string") as { error: string } | undefined;
    return {
      id: rule.id, title: rule.name, projectId: rule.projectId,
      projectName: row.projectName ?? rule.projectId,
      schedule,
      scheduleText: row.triggerText,
      timezone,
      nextRunAt, paused,
      lastRunAt: lastRun?.triggeredAt ?? null, lastStatus: lastRun?.status ?? null,
      lastError: failure?.error ?? null,
      editKey: row.origin === "yml" ? `${rule.projectId}:${rule.name}` : rule.name,
    };
  });
}
