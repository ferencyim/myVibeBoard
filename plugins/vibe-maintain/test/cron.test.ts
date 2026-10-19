import { describe, expect, it } from "vitest";
import { cronMatches, latestFire, parseCron } from "../server/cron";

const at = (h: number, m: number, day = 19) => new Date(2026, 9, day, h, m);

describe("cron", () => {
  it("matches fields, lists, ranges and steps", () => {
    expect(cronMatches(parseCron("0 3 * * *"), at(3, 0))).toBe(true);
    expect(cronMatches(parseCron("0 3 * * *"), at(3, 1))).toBe(false);
    expect(cronMatches(parseCron("*/15 * * * *"), at(7, 45))).toBe(true);
    expect(cronMatches(parseCron("*/15 * * * *"), at(7, 40))).toBe(false);
    expect(cronMatches(parseCron("5,10 8-9 * * *"), at(9, 10))).toBe(true);
    expect(cronMatches(parseCron("5,10 8-9 * * *"), at(10, 10))).toBe(false);
  });

  it("treats day-of-week 7 as Sunday and ORs restricted day fields", () => {
    const sunday = new Date(2026, 9, 18, 0, 0); // Sunday
    expect(cronMatches(parseCron("0 0 * * 7"), sunday)).toBe(true);
    expect(cronMatches(parseCron("0 0 1 * 0"), sunday)).toBe(true); // dom=1 OR sunday
    expect(cronMatches(parseCron("0 0 1 * 1"), sunday)).toBe(false);
  });

  it("rejects malformed expressions", () => {
    expect(() => parseCron("* * * *")).toThrow();
    expect(() => parseCron("61 * * * *")).toThrow();
    expect(() => parseCron("*/0 * * * *")).toThrow();
  });

  it("finds the latest scheduled minute in (after, now]", () => {
    const fire = latestFire("0 3 * * *", at(0, 0), at(4, 30));
    expect(fire?.getHours()).toBe(3);
    expect(latestFire("0 3 * * *", at(3, 0), at(4, 30))).toBeNull(); // `after` is exclusive
    expect(latestFire("0 3 * * *", at(0, 0), at(2, 59))).toBeNull();
  });
});
