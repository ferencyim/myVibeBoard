import type { RoutineSchedule } from "./routines";

function field(text: string, min: number, max: number): Set<number> {
  const result = new Set<number>();
  for (const part of text.split(",")) {
    const [range, stepText, extra] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!range || extra !== undefined || !Number.isInteger(step) || step < 1) throw new Error("无效的 cron 字段");
    const bounds = range === "*" ? [min, max] : range.split("-").map(Number);
    const start = bounds[0];
    if (start === undefined || bounds.length > 2 || bounds.some((v) => !Number.isInteger(v) || v < min || v > max)) throw new Error("无效的 cron 字段");
    const end = bounds[1] ?? start;
    if (end < start) throw new Error("无效的 cron 范围");
    for (let v = start; v <= end; v += step) result.add(v);
  }
  return result;
}
export function nextRoutineTime(schedule: RoutineSchedule, timezone: string, after: Date): Date {
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, minute: "numeric", hour: "numeric", day: "numeric", month: "numeric", weekday: "short", hourCycle: "h23" });
  if (schedule.kind === "interval") return new Date(after.getTime() + schedule.minutes * 60000);
  const parts = schedule.expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("cron 必须有五个字段");
  const minute = field(parts[0]!, 0, 59), hour = field(parts[1]!, 0, 23), day = field(parts[2]!, 1, 31), month = field(parts[3]!, 1, 12), weekday = field(parts[4]!, 0, 7);
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  function local(at: number) { return Object.fromEntries(formatter.formatToParts(new Date(at)).map((p) => [p.type, p.value])); }
  function dateMatches(v: Record<string, string>) {
    const d = day.has(Number(v.day));
    const w = weekday.has(weekdays.indexOf(v.weekday ?? "")) || (v.weekday === "Sun" && weekday.has(7));
    let matchesDay = d || w;
    if (parts[2] === "*") matchesDay = w;
    else if (parts[4] === "*") matchesDay = d;
    return month.has(Number(v.month)) && matchesDay;
  }
  const first = Math.floor(after.getTime() / 60000) * 60000 + 60000;
  const end = first + 366 * 8 * 86400000;
  // Examine only UTC days containing a matching local date, then candidate minutes in each hour.
  for (let utcDay = Math.floor(first / 86400000) * 86400000; utcDay < end; utcDay += 86400000) {
    if (!dateMatches(local(utcDay)) && !dateMatches(local(utcDay + 86340000))) continue;
    for (let utcHour = utcDay; utcHour < utcDay + 86400000; utcHour += 3600000) {
      const start = local(utcHour), finish = local(utcHour + 3540000);
      if (!(dateMatches(start) && hour.has(Number(start.hour))) && !(dateMatches(finish) && hour.has(Number(finish.hour)))) continue;
      // Sampling both ends preserves half-hour DST transitions and non-hour UTC offsets.
      const offsets = new Set([Number(start.minute), (Number(finish.minute) - 59 + 60) % 60]);
      const candidates = new Set<number>();
      for (const offset of offsets) for (const m of minute) candidates.add((m - offset + 60) % 60);
      for (const m of [...candidates].sort((a, b) => a - b)) {
        const at = utcHour + m * 60000;
        if (at < first || at >= end) continue;
        const v = local(at);
        if (dateMatches(v) && hour.has(Number(v.hour)) && minute.has(Number(v.minute))) return new Date(at);
      }
    }
  }
  throw new Error("cron 在未来八年内没有运行时间");
}
