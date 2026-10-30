import { describe, expect, it } from "vitest";
import {
  THRESHOLD_FIELDS,
  formatRemaining,
  groupDirectives,
  metricExceeds,
  moveQueueItem,
  parseDirectives,
  parseHubStatus,
  parseNumberField,
  parseThresholds,
  queueOrderIds,
  setQueuePriority,
  sortQueue,
  validateDirectiveForm,
  validatePauseForm,
  validateResourceForm,
  type QueueItem,
} from "../client/hub-model";

const item = (id: string, state: QueueItem["state"] = "queued", priority = 5): QueueItem => ({
  id,
  kind: "shell",
  owner: "",
  project: "",
  command: id,
  priority,
  state,
  waitReasons: [],
  queuedAt: null,
});

describe("hub status mapping", () => {
  it("maps an empty or malformed status to empty views", () => {
    const view = parseHubStatus(undefined);
    expect(view.queue).toEqual([]);
    expect(view.machine.cpu).toBeNull();
    expect(parseHubStatus({ queue: "x", resources: [1], pauses: null }).resources).toHaveLength(0);
  });

  it("maps queue, resources and pauses with defaults", () => {
    const view = parseHubStatus({
      machine: { cpu: 0.4, availableMemGb: 12.5 },
      queue: [{ id: "j1", kind: "agent", state: "running", priority: 0, waitReasons: ["a", 3] }, { id: "j2" }],
      resources: [{ name: "pg:5435", limit: 0, holders: [{ jobId: "j1", owner: "s1", mode: "shared" }] }],
      pauses: [{ id: "p1", scope: "build", until: "2026-10-30T10:00:00.000Z", reason: "维护" }],
    });
    expect(view.machine).toMatchObject({ cpu: 0.4, availableMemGb: 12.5, processes: null });
    expect(view.queue[0]).toMatchObject({ kind: "agent", state: "running", waitReasons: ["a"] });
    expect(view.queue[1]).toMatchObject({ kind: "shell", state: "queued", priority: 5 });
    expect(view.resources[0]).toMatchObject({ limit: 1 });
    expect(view.resources[0]?.holders[0]?.mode).toBe("shared");
    expect(view.pauses[0]).toMatchObject({ issuedBy: "user" });
  });

  it("parses thresholds from a wrapped or bare record and drops non-numbers", () => {
    expect(parseThresholds({ thresholds: { maxCpu: 0.9, maxProcesses: "x" } })).toEqual({ maxCpu: 0.9 });
    expect(parseThresholds({ heavyHardLimit: 4 })).toEqual({ heavyHardLimit: 4 });
  });

  it("flags metrics past their threshold in the right direction", () => {
    const mem = THRESHOLD_FIELDS.find((f) => f.key === "minAvailableMemGb")!;
    const cpu = THRESHOLD_FIELDS.find((f) => f.key === "maxCpu")!;
    const machine = { ...parseHubStatus({}).machine, availableMemGb: 4, cpu: 0.5 };
    expect(metricExceeds(mem, machine, { minAvailableMemGb: 8 })).toBe(true);
    expect(metricExceeds(cpu, machine, { maxCpu: 0.9 })).toBe(false);
    expect(metricExceeds(cpu, machine, {})).toBe(false);
  });
});

describe("queue ordering", () => {
  it("keeps running items on top and the manual order otherwise", () => {
    const sorted = sortQueue([item("a"), item("b", "running"), item("c")]);
    expect(sorted.map((i) => i.id)).toEqual(["b", "a", "c"]);
  });

  it("moves a waiting item and refuses to cross running ones or the ends", () => {
    const q = [item("r", "running"), item("a"), item("b")];
    expect(moveQueueItem(q, "b", -1).map((i) => i.id)).toEqual(["r", "b", "a"]);
    expect(moveQueueItem(q, "a", -1).map((i) => i.id)).toEqual(["r", "a", "b"]);
    expect(moveQueueItem(q, "b", 1).map((i) => i.id)).toEqual(["r", "a", "b"]);
    expect(moveQueueItem(q, "zzz", 1)).toEqual(q);
  });

  it("clamps priority and lists only waiting ids for the reorder call", () => {
    const q = [item("r", "running"), item("a")];
    expect(setQueuePriority(q, "a", -3)[1]?.priority).toBe(0);
    expect(setQueuePriority(q, "a", 42)[1]?.priority).toBe(9);
    expect(queueOrderIds(q)).toEqual(["a"]);
  });
});

describe("form validation", () => {
  it("parses numbers within range and integer-ness", () => {
    expect(parseNumberField("0.5", { min: 0.1, max: 1, int: false })).toBe(0.5);
    expect(parseNumberField("2", { min: 1, max: 4, int: true })).toBe(2);
    expect(parseNumberField("1.5", { min: 1, max: 4, int: true })).toBeNull();
    expect(parseNumberField("9", { min: 1, max: 4, int: true })).toBeNull();
    expect(parseNumberField("  ", { min: 1, max: 4, int: true })).toBeNull();
    expect(parseNumberField("abc", { min: 1, max: 4, int: true })).toBeNull();
  });

  it("builds a pause with an absolute end time and rejects bad input", () => {
    const now = new Date("2026-10-30T00:00:00.000Z");
    const ok = validatePauseForm({ scope: "pg:*", minutes: "90", reason: " 迁移 " }, now);
    expect(ok).toEqual({
      ok: true,
      value: { scope: "pg:*", until: "2026-10-30T01:30:00.000Z", reason: "迁移" },
    });
    expect(validatePauseForm({ scope: "", minutes: "5", reason: "x" }, now).ok).toBe(false);
    expect(validatePauseForm({ scope: "build", minutes: "0", reason: "x" }, now).ok).toBe(false);
    expect(validatePauseForm({ scope: "build", minutes: "5", reason: " " }, now).ok).toBe(false);
  });

  it("validates resource names, uniqueness and limits", () => {
    expect(validateResourceForm("pg:5435", "2", [], false)).toEqual({
      ok: true,
      value: { name: "pg:5435", limit: 2 },
    });
    expect(validateResourceForm("bad name", "1", [], false).ok).toBe(false);
    expect(validateResourceForm("pg:5435", "1", ["pg:5435"], false).ok).toBe(false);
    expect(validateResourceForm("pg:5435", "1", ["pg:5435"], true).ok).toBe(true);
    expect(validateResourceForm("pg:5435", "0", [], false).ok).toBe(false);
  });

  it("validates directives: temporary needs an expiry, standing has none", () => {
    const now = new Date("2026-10-30T00:00:00.000Z");
    expect(validateDirectiveForm({ text: "  ", kind: "standing", hours: "" }, now).ok).toBe(false);
    expect(validateDirectiveForm({ text: "x", kind: "temporary", hours: "x" }, now).ok).toBe(false);
    expect(validateDirectiveForm({ text: "x", kind: "temporary", hours: "2" }, now)).toEqual({
      ok: true,
      value: { text: "x", scope: "all", kind: "temporary", expiresAt: "2026-10-30T02:00:00.000Z" },
    });
    expect(validateDirectiveForm({ text: "x", kind: "standing", hours: "" }, now)).toEqual({
      ok: true,
      value: { text: "x", scope: "all", kind: "standing" },
    });
  });
});

describe("directives and time", () => {
  it("groups by status, newest first, and marks bot origin", () => {
    const items = parseDirectives({
      directives: [
        { id: "1", text: "a", status: "active", createdAt: "2026-10-29T00:00:00Z" },
        { id: "2", text: "b", status: "active", createdAt: "2026-10-30T00:00:00Z", issuedBy: "bot" },
        { id: "3", text: "c", status: "pending", kind: "standing" },
        { id: "4", text: "d", status: "expired" },
        { id: "5", text: "e", status: "revoked" },
      ],
    });
    const groups = groupDirectives(items);
    expect(groups.active.map((d) => d.id)).toEqual(["2", "1"]);
    expect(groups.active[0]?.issuedBy).toBe("bot");
    expect(groups.pending[0]?.kind).toBe("standing");
    expect(groups.history).toHaveLength(2);
    expect(parseDirectives(null)).toEqual([]);
  });

  it("formats the time left", () => {
    const now = new Date("2026-10-30T00:00:00.000Z");
    expect(formatRemaining(null, now)).toBe("无期限");
    expect(formatRemaining("2026-10-29T23:00:00.000Z", now)).toBe("已到期");
    expect(formatRemaining("2026-10-30T00:20:00.000Z", now)).toBe("还剩 20 分");
    expect(formatRemaining("2026-10-30T02:05:00.000Z", now)).toBe("还剩 2 小时 5 分");
    expect(formatRemaining("2026-11-01T03:00:00.000Z", now)).toBe("还剩 2 天 3 小时");
  });
});
