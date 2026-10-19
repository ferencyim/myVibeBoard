// Minimal 5-field cron (minute hour day-of-month month day-of-week), local time.
// Supports `*`, lists, ranges and steps. day-of-week 0 and 7 are Sunday. When both day fields
// are restricted either one matching is enough (classic cron).

type Field = { any: boolean; values: Set<number> };
export interface CronSpec {
  minute: Field;
  hour: Field;
  dom: Field;
  month: Field;
  dow: Field;
}

function parseField(text: string, min: number, max: number, name: string): Field {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const [range = "", stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid cron ${name} step: ${part}`);
    let lo = min;
    let hi = max;
    if (range !== "*") {
      const [a = "", b] = range.split("-");
      lo = Number(a);
      hi = b === undefined ? (stepText === undefined ? lo : max) : Number(b);
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`Invalid cron ${name} field: ${part}`);
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return { any: text === "*", values };
}

export function parseCron(expr: string): CronSpec {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Cron needs 5 fields: "${expr}"`);
  const [m, h, dom, mon, dow] = parts as [string, string, string, string, string];
  const dowField = parseField(dow, 0, 7, "day-of-week");
  if (dowField.values.delete(7)) dowField.values.add(0);
  return {
    minute: parseField(m, 0, 59, "minute"),
    hour: parseField(h, 0, 23, "hour"),
    dom: parseField(dom, 1, 31, "day-of-month"),
    month: parseField(mon, 1, 12, "month"),
    dow: dowField,
  };
}

export function cronMatches(spec: CronSpec, date: Date): boolean {
  if (!spec.minute.values.has(date.getMinutes())) return false;
  if (!spec.hour.values.has(date.getHours())) return false;
  if (!spec.month.values.has(date.getMonth() + 1)) return false;
  const domOk = spec.dom.values.has(date.getDate());
  const dowOk = spec.dow.values.has(date.getDay());
  if (spec.dom.any || spec.dow.any) return domOk && dowOk;
  return domOk || dowOk;
}

/** The latest scheduled minute in (after, now], or null. Looks back at most `maxDays` days. */
export function latestFire(expr: string, after: Date, now: Date, maxDays = 8): Date | null {
  const spec = parseCron(expr);
  const floor = Math.max(after.getTime(), now.getTime() - maxDays * 86_400_000);
  const t = new Date(now);
  t.setSeconds(0, 0);
  for (; t.getTime() > floor; t.setMinutes(t.getMinutes() - 1)) {
    if (cronMatches(spec, t)) return new Date(t);
  }
  return null;
}
