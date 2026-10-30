import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateOwner, openVibeDb } from "../server/vibe/db";
import { createHub } from "../server/hub";
import { createHubStore } from "../server/hub-store";
import { createHubHistory, createHubTuning, TUNE_LIMITS } from "../server/hub-tuning";

const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

function setup() {
  const db = openVibeDb({ path: ":memory:" });
  closers.push(() => db.close());
  migrateOwner(db, "scheduler");
  const dir = mkdtempSync(join(tmpdir(), "hub-tuning-"));
  const admissionFile = join(dir, "admission.json");
  let time = Date.parse("2026-01-01T00:00:00Z");
  const now = () => new Date(time);
  const hub = createHub({
    store: createHubStore(db, now),
    now,
    metrics: async () => ({ ts: "", availableGb: 40 }),
    admissionFile,
  });
  const events: string[] = [];
  const history = createHubHistory({
    db,
    now,
    load: () => ({ running: 2, maxQueueWaitMs: 20 * 60_000 }),
    lockDir: dir,
    onEvent: (e) => void events.push(e.kind),
  });
  const notices: string[] = [];
  const told: string[] = [];
  const tuning = createHubTuning({
    db,
    now,
    history,
    settings: () => hub.settings(),
    update: (patch) => hub.updateSettings(patch),
    notifyUser: (title, body) => void notices.push(title + "|" + body),
    tellCoordinator: (_key, text) => void told.push(text),
  });
  return {
    db, dir, admissionFile, hub, history, tuning, events, notices, told,
    advance: (ms: number) => void (time += ms),
    at: () => new Date(time).toISOString(),
  };
}

describe("hub history", () => {
  it("aggregates per minute and per window, and records events", () => {
    const s = setup();
    s.history.record({ ts: "2026-01-01T00:00:05Z", availableGb: 10, commitPercent: 70, cpuPercent: 20, processes: 100 });
    s.history.record({ ts: "2026-01-01T00:00:10Z", availableGb: 6, commitPercent: 96, cpuPercent: 40, processes: 300 });
    s.history.record({ ts: "2026-01-01T00:01:05Z", availableGb: 1.5, commitPercent: 50, cpuPercent: 30 });
    s.advance(2 * 60_000);
    const q = s.history.query(1);
    expect(q.summary).toMatchObject({
      minAvailableGb: 1.5, maxCommitPercent: 96, maxCpuPercent: 40, maxProcesses: 300, maxRunning: 2,
      maxQueueWaitMin: 20, minutesWithData: 2, minutesQueuedOver15: 2, avgCpuPercent: 30,
    });
    expect(q.hourly).toHaveLength(1);
    expect(q.eventCounts).toEqual({ commit_high: 1, memory_low: 1 });
    expect(s.events).toEqual(["commit_high", "memory_low"]);
  });

  it("dedupes repeated events, flags OOM exits and guard commit-limit hits", () => {
    const s = setup();
    s.history.record({ ts: "2026-01-01T00:00:05Z", commitPercent: 97 });
    s.history.record({ ts: "2026-01-01T00:00:10Z", commitPercent: 98 });
    expect(s.events).toEqual(["commit_high"]);
    s.history.jobFinished({ owner: "a", exitCode: 1 });
    s.history.jobFinished({ owner: "a", exitCode: -1073741801 });
    expect(s.events).toEqual(["commit_high", "job_oom"]);
    const logs = join(s.dir, "logs");
    mkdirSync(logs);
    const file = join(logs, "2026-01-01.jsonl");
    writeFileSync(file, '{"event":"end","job_commit_limit_exceeded":true,"owner":"old"}\n');
    s.history.flush(); // first sight: old lines are not replayed
    appendFileSync(file, '{"event":"end","job_commit_limit_exceeded":true,"owner":"new","exit_code":1}\n{"event":"end"}\n');
    s.history.flush();
    expect(s.events.filter((k) => k === "job_commit_limit")).toHaveLength(1);
  });

  it("prunes data older than 14 days", () => {
    const s = setup();
    s.db
      .prepare("INSERT INTO hub_metric_minute (minute,samples,max_running,max_queue_wait_ms) VALUES ('2025-12-01T00:00',1,0,0)")
      .run();
    s.history.flush();
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM hub_metric_minute").get()).toMatchObject({ n: 0 });
  });
});

describe("threshold tuning", () => {
  it("enforces floors, ceilings and step size", async () => {
    const s = setup(); // defaults: min 12, deploy 4, commit 80, cpu 70, limit 4
    await expect(s.tuning.set({ changes: { minAvailableGb: 8 }, reason: "r" })).rejects.toThrow("单次最多调整 3");
    await expect(s.tuning.set({ changes: { deployMinAvailableGb: 1 }, reason: "r" })).rejects.toThrow("安全底线");
    await expect(s.tuning.set({ changes: { maxCommitPercent: 95 }, reason: "r" })).rejects.toThrow();
    await expect(s.tuning.set({ changes: { maxCpuPercent: 99 }, reason: "r" })).rejects.toThrow();
    await expect(s.tuning.set({ changes: { hardLimit: 9 }, reason: "r" })).rejects.toThrow();
    await expect(s.tuning.set({ changes: { hardLimit: 2 }, reason: "r" })).rejects.toThrow("单次最多调整 1");
    await expect(s.tuning.set({ changes: { maxProcesses: 10 } as never, reason: "r" })).rejects.toThrow("不能由总协调调整");
    await expect(s.tuning.set({ changes: {}, reason: "r" })).rejects.toThrow("没有需要调整");
    await expect(s.tuning.set({ changes: { hardLimit: 5 }, reason: " " })).rejects.toThrow("理由");
    expect(TUNE_LIMITS.hardLimit).toMatchObject({ min: 1, max: 8 });
  });

  it("applies, writes the admission file, records history and notifies", async () => {
    const s = setup();
    const r = await s.tuning.set({ changes: { minAvailableGb: 9, hardLimit: 5 }, reason: "排队多而内存闲置" });
    expect(r.settings).toMatchObject({ minAvailableGb: 9, hardLimit: 5 });
    const file = JSON.parse(readFileSync(s.admissionFile, "utf8")) as Record<string, number>;
    expect(file).toMatchObject({ min_available_gb: 9, hard_limit: 5 });
    expect(s.tuning.history()).toMatchObject([
      {
        actor: "coordinator",
        old: { minAvailableGb: 12, hardLimit: 4 },
        new: { minAvailableGb: 9, hardLimit: 5 },
        reason: "排队多而内存闲置",
      },
    ]);
    expect(s.notices).toHaveLength(1);
    expect(s.notices[0]).toContain("minAvailableGb: 12 -> 9");
    expect(s.told).toHaveLength(1);
  });

  it("requires 30 minutes between coordinator adjustments", async () => {
    const s = setup();
    await s.tuning.set({ changes: { minAvailableGb: 9 }, reason: "a" });
    s.advance(29 * 60_000);
    await expect(s.tuning.set({ changes: { minAvailableGb: 6 }, reason: "b" })).rejects.toThrow("不足 30 分钟");
    s.advance(2 * 60_000);
    await expect(s.tuning.set({ changes: { minAvailableGb: 6 }, reason: "b" })).resolves.toBeTruthy();
  });

  it("does not override a fresh user change unless a memory event happened", async () => {
    const s = setup();
    const before = s.hub.settings();
    const result = await s.hub.updateSettings({ maxCpuPercent: 90 });
    s.tuning.recordUser(before, result.settings);
    expect(s.tuning.history()[0]).toMatchObject({ actor: "user", old: { maxCpuPercent: 70 }, new: { maxCpuPercent: 90 } });
    expect(s.told[0]).toContain("30 分钟");
    s.advance(10 * 60_000);
    await expect(s.tuning.set({ changes: { maxCpuPercent: 85 }, reason: "x" })).rejects.toThrow("用户刚手动改过");
    s.history.record({ ts: s.at(), availableGb: 1 }); // memory event after the user change
    await expect(s.tuning.set({ changes: { maxCpuPercent: 85 }, reason: "x" })).resolves.toBeTruthy();
    expect(s.hub.settings().maxCpuPercent).toBe(85);
  });

  it("allows adjusting after the protection window", async () => {
    const s = setup();
    const before = s.hub.settings();
    s.tuning.recordUser(before, (await s.hub.updateSettings({ hardLimit: 6 })).settings);
    s.advance(31 * 60_000);
    await expect(s.tuning.set({ changes: { hardLimit: 5 }, reason: "x" })).resolves.toBeTruthy();
    expect(s.tuning.recordUser(before, before)).toBeNull();
  });
});
