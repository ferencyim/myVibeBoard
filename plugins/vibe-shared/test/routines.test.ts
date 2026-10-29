import { describe, expect, it } from "vitest";
import { nextRoutineTime } from "../contract/routine-schedule";

describe("routine schedule", () => {
  it("advances intervals from their anchor", () => {
    expect(nextRoutineTime({ kind: "interval", minutes: 30 }, "UTC", new Date("2026-01-01T00:15:00Z")).toISOString()).toBe("2026-01-01T00:45:00.000Z");
  });
  it("matches cron in its time zone across daylight saving", () => {
    expect(nextRoutineTime({ kind: "cron", expression: "0 9 * * *" }, "America/New_York", new Date("2026-03-08T12:00:00Z")).toISOString()).toBe("2026-03-08T13:00:00.000Z");
  });
  it("finds sparse leap-day schedules and repeated DST hours", () => {
    expect(nextRoutineTime({ kind: "cron", expression: "0 0 29 2 *" }, "UTC", new Date("2025-03-01T00:00:00Z")).toISOString()).toBe("2028-02-29T00:00:00.000Z");
    expect(nextRoutineTime({ kind: "cron", expression: "30 1 * * *" }, "America/New_York", new Date("2026-11-01T05:30:00Z")).toISOString()).toBe("2026-11-01T06:30:00.000Z");
  });
  it("rejects invalid schedules and time zones", () => {
    expect(() => nextRoutineTime({ kind: "cron", expression: "90 * * * *" }, "UTC", new Date())).toThrow();
    expect(() => nextRoutineTime({ kind: "interval", minutes: 1 }, "invalid-zone", new Date())).toThrow();
  });
});
