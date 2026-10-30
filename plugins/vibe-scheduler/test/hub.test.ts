import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateOwner, openVibeDb } from "../server/vibe/db";
import { createHub, readAdmissionFile, type JobRequest } from "../server/hub";
import { createHubStore } from "../server/hub-store";
import { startHubHttp, type HubHttp } from "../server/hub-http";
import type { HubMetrics } from "../server/hub-metrics";
import { fromThresholds, toPageStatus, toThresholds } from "../server/hub-page";

const closers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

function setup(options: { admissionFile?: string; agentQueue?: string[] } = {}) {
  const db = openVibeDb({ path: ":memory:" });
  closers.push(() => db.close());
  migrateOwner(db, "scheduler");
  let time = Date.parse("2026-01-01T00:00:00Z");
  const now = () => new Date(time);
  const metrics: HubMetrics = { ts: "", availableGb: 40, cpuPercent: 10 };
  const alive = new Set<number>();
  const agentOrder: string[][] = [];
  const hub = createHub({
    store: createHubStore(db, now),
    now,
    metrics: async () => ({ ...metrics }),
    isPidAlive: (pid) => alive.has(pid),
    admissionFile: options.admissionFile ?? null,
    agents: {
      queue: () =>
        (options.agentQueue ?? []).map((id) => ({
          workspaceId: id,
          goal: "g-" + id,
          confirmedAt: "2026-01-01T00:00:00.000Z",
        })),
      running: () => ({}),
      reorder: async (ids) => void agentOrder.push(ids),
    },
  });
  return {
    hub,
    metrics,
    alive,
    agentOrder,
    advance: (ms: number) => void (time += ms),
    job: (extra: Partial<JobRequest> = {}): JobRequest => ({
      owner: "s1",
      command: "npm",
      commandSha256: "x",
      priority: 1,
      exclusive: false,
      units: 1,
      pid: 100,
      ...extra,
    }),
  };
}

describe("hub admission", () => {
  it("blocks on a known metric and ignores unknown ones", async () => {
    const t = setup();
    await t.hub.updateSettings({ admissionIntervalSeconds: 0 });
    await t.hub.submit(t.job()); // a holder: on an empty machine the deadlock guard ignores metrics
    t.metrics.availableGb = 5;
    const blocked = await t.hub.submit(t.job());
    expect(blocked.state).toBe("queued");
    expect(blocked.waitReasons).toContain("memory_low");
    t.metrics.availableGb = 40;
    await t.hub.tick();
    expect((await t.hub.wait(blocked.jobId, 0))?.state).toBe("admitted");
    // handles/processes unknown (undefined) never block
    expect((await t.hub.submit(t.job())).state).toBe("admitted");
  });

  it("deploy uses its own memory floor and may be admitted when normal jobs are not", async () => {
    const t = setup();
    await t.hub.updateSettings({ admissionIntervalSeconds: 0 });
    await t.hub.submit(t.job());
    t.metrics.availableGb = 6;
    expect((await t.hub.submit(t.job())).waitReasons).toContain("memory_low");
    expect((await t.hub.submit(t.job({ priority: 0 }))).state).toBe("admitted");
  });

  it("hard limit keeps one slot for priority 0", async () => {
    const t = setup();
    await t.hub.updateSettings({ admissionIntervalSeconds: 0 });
    for (let i = 0; i < 3; i++) expect((await t.hub.submit(t.job())).state).toBe("admitted");
    const fourth = await t.hub.submit(t.job());
    expect(fourth.state).toBe("queued");
    expect(fourth.waitReasons).toContain("slots_full");
    expect((await t.hub.submit(t.job({ priority: 0 }))).state).toBe("admitted");
    expect((await t.hub.submit(t.job({ priority: 0 }))).state).toBe("queued");
  });

  it("enforces the minimum interval between launches except for priority 0", async () => {
    const t = setup();
    t.alive.add(100);
    expect((await t.hub.submit(t.job())).state).toBe("admitted");
    const second = await t.hub.submit(t.job());
    expect(second.waitReasons?.[0]).toMatch(/^interval:/);
    expect((await t.hub.submit(t.job({ priority: 0 }))).state).toBe("admitted");
    t.advance(121_000);
    await t.hub.tick();
    expect((await t.hub.wait(second.jobId, 0))?.state).toBe("admitted");
  });

  it("orders by priority, manual order, then queue time, and does not let jobs overtake", async () => {
    const t = setup();
    await t.hub.updateSettings({ hardLimit: 2, admissionIntervalSeconds: 0 });
    const holder = await t.hub.submit(t.job());
    const low = await t.hub.submit(t.job({ priority: 2 }));
    const normalA = await t.hub.submit(t.job());
    const normalB = await t.hub.submit(t.job());
    await t.hub.reorder({
      order: [
        { kind: "job", id: normalB.jobId },
        { kind: "job", id: normalA.jobId },
      ],
      reason: "t",
    });
    const status = await t.hub.status();
    expect(status.queue.map((q) => q.id)).toEqual([normalB.jobId, normalA.jobId, low.jobId]);
    await t.hub.release(holder.jobId, {});
    expect((await t.hub.wait(normalB.jobId, 0))?.state).toBe("admitted");
    expect((await t.hub.wait(normalA.jobId, 0))?.state).toBe("queued");
    expect((await t.hub.wait(low.jobId, 0))?.waitReasons).toContain("slots_full");
  });

  it("shows agent tasks in the queue and forwards their order", async () => {
    const t = setup({ agentQueue: ["w1", "w2"] });
    const status = await t.hub.status();
    expect(status.queue.map((q) => [q.kind, q.id])).toEqual([
      ["agent", "w1"],
      ["agent", "w2"],
    ]);
    await t.hub.reorder({
      order: [
        { kind: "agent", id: "w2" },
        { kind: "agent", id: "w1" },
      ],
      reason: "r",
    });
    expect(t.agentOrder).toEqual([["w2", "w1"]]);
    await expect(t.hub.reorder({ order: [], priorities: { w1: 0 }, reason: "r" })).rejects.toThrow();
  });
});

describe("shared resources", () => {
  it("makes exclusive mutually exclusive and honours the shared limit", async () => {
    const t = setup();
    await t.hub.updateSettings({ admissionIntervalSeconds: 0 });
    t.hub.upsertResource({ name: "pg:5435", maxShared: 2 });
    const res = (mode: "shared" | "exclusive") => [{ name: "pg:5435", mode }];
    const s1 = await t.hub.submit(t.job({ resources: res("shared") }));
    const s2 = await t.hub.submit(t.job({ resources: res("shared") }));
    expect([s1.state, s2.state]).toEqual(["admitted", "admitted"]);
    const s3 = await t.hub.submit(t.job({ resources: res("shared") }));
    expect(s3.waitReasons).toContain("resource_full:pg:5435");
    const ex = await t.hub.submit(t.job({ resources: res("exclusive") }));
    expect(ex.waitReasons).toContain("resource_busy:pg:5435");
    await t.hub.release(s1.jobId, {});
    await t.hub.release(s2.jobId, {});
    // s3 is ahead of ex in queue order and takes the shared slot; ex keeps waiting
    expect((await t.hub.wait(s3.jobId, 0))?.state).toBe("admitted");
    expect((await t.hub.wait(ex.jobId, 0))?.waitReasons).toContain("resource_busy:pg:5435");
    await t.hub.release(s3.jobId, {});
    expect((await t.hub.wait(ex.jobId, 0))?.state).toBe("admitted");
    const after = await t.hub.submit(t.job({ resources: res("shared") }));
    expect(after.waitReasons).toContain("resource_exclusive:pg:5435");
  });

  it("registry can be edited and removed", () => {
    const t = setup();
    t.hub.upsertResource({ name: "pg:1", maxShared: 3, note: "a" });
    t.hub.upsertResource({ name: "pg:1", note: "b" });
    expect(t.hub.listResources()).toEqual([{ name: "pg:1", maxShared: 3, note: "b" }]);
    expect(t.hub.removeResource("pg:1")).toBe(true);
    expect(t.hub.listResources()).toEqual([]);
  });
});

describe("pause rules", () => {
  it("queues matching jobs with the reason, expires on time, and can be revoked", async () => {
    const t = setup();
    t.alive.add(100);
    await t.hub.updateSettings({ admissionIntervalSeconds: 0 });
    const until = new Date(Date.parse("2026-01-01T00:10:00Z")).toISOString();
    const pause = await t.hub.createPause({ scope: "pg:*", until, reason: "维护" });
    const hit = await t.hub.submit(
      t.job({ resources: [{ name: "pg:5435", mode: "shared" }] }),
    );
    expect(hit.state).toBe("queued");
    expect(hit.waitReasons?.[0]).toContain("pause:pg:*:维护");
    expect(hit.waitReasons?.[0]).toContain(until);
    expect((await t.hub.submit(t.job())).state).toBe("admitted");
    t.advance(11 * 60_000);
    await t.hub.tick();
    expect((await t.hub.wait(hit.jobId, 0))?.state).toBe("admitted");
    expect(t.hub.listPauses(true)).toEqual([]);
    expect(t.hub.listPauses(false).map((p) => p.id)).toEqual([pause.id]);

    const all = await t.hub.createPause({ scope: "all-heavy", reason: "x" });
    const blocked = await t.hub.submit(t.job());
    expect(blocked.state).toBe("queued");
    expect(await t.hub.revokePause(all.id)).toBe(true);
    expect((await t.hub.wait(blocked.jobId, 0))?.state).toBe("admitted");
    await expect(t.hub.createPause({ scope: "nonsense" })).rejects.toThrow();
  });

  it("matches build and test categories", async () => {
    const t = setup();
    await t.hub.createPause({ scope: "test", reason: "t" });
    expect((await t.hub.submit(t.job({ command: "vitest" }))).state).toBe("queued");
    expect((await t.hub.submit(t.job({ command: "gradlew" }))).state).toBe("admitted");
  });
});

describe("heartbeat reaping", () => {
  it("reclaims a slot only when heartbeat is missing and the pid is dead", async () => {
    const t = setup();
    await t.hub.updateSettings({ hardLimit: 1, admissionIntervalSeconds: 0 });
    const a = await t.hub.submit(t.job({ pid: 7 }));
    const b = await t.hub.submit(t.job({ pid: 8 }));
    t.alive.add(7);
    t.alive.add(8);
    t.advance(61_000);
    await t.hub.tick();
    expect((await t.hub.wait(b.jobId, 0))?.state).toBe("queued"); // pid alive, no reap
    t.hub.heartbeat(a.jobId);
    t.alive.delete(7);
    t.advance(30_000);
    await t.hub.tick();
    expect(t.hub.heartbeat(a.jobId)).toBe("ok"); // heartbeat keeps it
    t.advance(61_000);
    await t.hub.tick();
    expect(t.hub.heartbeat(a.jobId)).toBe("gone");
    expect((await t.hub.wait(b.jobId, 0))?.state).toBe("admitted");
    expect((await t.hub.status()).recentJobs[0]?.outcome).toBe("reaped");
  });
});

describe("settings and admission file", () => {
  it("reads defaults from the file, then writes changes back keeping unknown keys", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-"));
    const file = join(dir, "admission.json");
    writeFileSync(file, JSON.stringify({ hard_limit: 6, min_available_gb: 9, job_commit_gb_priority0: 64 }));
    const t = setup({ admissionFile: file });
    expect(t.hub.settings().hardLimit).toBe(6);
    expect(t.hub.settings().minAvailableGb).toBe(9);
    const result = await t.hub.updateSettings({ maxCpuPercent: 55 });
    expect(result.fileError).toBeUndefined();
    const raw = JSON.parse(readFileSync(file, "utf8"));
    expect(raw.max_cpu_percent).toBe(55);
    expect(raw.job_commit_gb_priority0).toBe(64);
    expect(readAdmissionFile(file).maxCpuPercent).toBe(55);
    await expect(t.hub.updateSettings({ hardLimit: 0 })).rejects.toThrow();
  });

  it("maps to the page shapes", async () => {
    const t = setup();
    const th = toThresholds(t.hub.settings());
    expect(th.maxCommitRatio).toBeCloseTo(0.8);
    expect(fromThresholds({ maxCpu: 0.5, heavyHardLimit: 3 })).toEqual({ maxCpuPercent: 50, hardLimit: 3 });
    await t.hub.submit(t.job());
    const page = toPageStatus(await t.hub.status());
    expect(page.queue[0]?.state).toBe("running");
  });
});

describe("hub http", () => {
  it("serves submit, long poll, heartbeat, release and status; removes hub.json on stop", async () => {
    const t = setup();
    await t.hub.updateSettings({ hardLimit: 2, admissionIntervalSeconds: 0 });
    const dir = mkdtempSync(join(tmpdir(), "hub-http-"));
    const http: HubHttp = await startHubHttp(t.hub, { dir });
    closers.push(() => http.stop());
    const info = JSON.parse(readFileSync(join(dir, "hub.json"), "utf8"));
    expect(info.port).toBe(http.port);
    const call = async (method: string, path: string, body?: unknown, token = info.token) => {
      const res = await fetch(`http://127.0.0.1:${info.port}${path}`, {
        method,
        headers: { authorization: "Bearer " + token, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };
    const req = { owner: "o", command: "npm", commandSha256: "h", priority: 1, exclusive: false, units: 1, pid: process.pid };

    expect((await call("GET", "/v1/status", undefined, "bad")).status).toBe(401);
    expect((await call("POST", "/v1/jobs", { owner: "" })).status).toBe(400);

    const first = await call("POST", "/v1/jobs", req);
    expect(first.status).toBe(200);
    expect(first.body.state).toBe("admitted");
    const second = await call("POST", "/v1/jobs", req);
    expect(second.body.state).toBe("queued");
    expect(second.body.waitReasons).toContain("slots_full");
    expect(second.body.position).toBe(1);

    const poll = call("GET", `/v1/jobs/${second.body.jobId}?wait=30`);
    await new Promise((r) => setTimeout(r, 50));
    expect((await call("POST", `/v1/jobs/${first.body.jobId}/heartbeat`)).body.ok).toBe(true);
    expect((await call("GET", "/v1/status")).body.holders).toHaveLength(1);
    const released = await call("POST", `/v1/jobs/${first.body.jobId}/release`, { exitCode: 130, durationMs: 5 });
    expect(released.body.ok).toBe(true);
    const polled = await poll;
    expect(polled.body.state).toBe("admitted");

    expect((await call("GET", "/v1/jobs/nope")).status).toBe(410);
    expect((await call("POST", `/v1/jobs/${first.body.jobId}/release`, {})).status).toBe(200);
    await call("POST", `/v1/jobs/${second.body.jobId}/release`, { exitCode: 0, durationMs: 1 });

    await http.stop();
    expect(existsSync(join(dir, "hub.json"))).toBe(false);
  });
});
