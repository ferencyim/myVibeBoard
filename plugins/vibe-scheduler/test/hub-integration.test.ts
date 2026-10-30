import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHub, pauseMatches, validatePauseScope, type JobRequest } from "../server/hub";
import {
  createCoordinatorNotifier,
  createHubWatcher,
  METRIC_WARN_MS,
  QUEUE_WARN_MS,
} from "../server/hub-events";
import { startHubHttp } from "../server/hub-http";
import type { HubMetrics } from "../server/hub-metrics";
import { createHubStore } from "../server/hub-store";
import { createSchedulerRuntime } from "../server/runtime";
import { migrateOwner, openVibeDb } from "../server/vibe/db";
import { fakeMachine } from "./helpers";

const closers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-int-"));
  closers.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

function setupHub() {
  const db = openVibeDb({ path: ":memory:" });
  closers.push(() => db.close());
  migrateOwner(db, "scheduler");
  let time = Date.parse("2026-01-01T00:00:00Z");
  const now = () => new Date(time);
  const metrics: HubMetrics = { ts: "", availableGb: 40, cpuPercent: 10 };
  const hub = createHub({
    store: createHubStore(db, now),
    now,
    metrics: async () => ({ ...metrics }),
    isPidAlive: () => true,
  });
  const job = (extra: Partial<JobRequest> = {}): JobRequest => ({
    owner: "s1",
    command: "npm",
    commandSha256: "x",
    priority: 1,
    exclusive: false,
    slots: 1,
    pid: 100,
    ...extra,
  });
  return { hub, metrics, job, now: () => time, advance: (ms: number) => void (time += ms) };
}

describe("pause categories", () => {
  it("matches the reported category and falls back to the command name", () => {
    const base = { command: "python", resources: [] };
    expect(pauseMatches("build", { ...base, category: "build" })).toBe(true);
    expect(pauseMatches("build", { ...base, category: "test" })).toBe(false);
    expect(pauseMatches("deploy", { ...base, category: "deploy" })).toBe(true);
    expect(pauseMatches("db", { ...base, category: "db" })).toBe(true);
    expect(pauseMatches("db", { command: "psql -c x", resources: [] })).toBe(true);
    expect(pauseMatches("test", { command: "npx vitest run", resources: [] })).toBe(true);
    expect(pauseMatches("agents", { ...base, category: "build" })).toBe(false);
    expect(pauseMatches("all-heavy", base)).toBe(true);
    for (const scope of ["deploy", "db", "agents", "project:x"]) expect(validatePauseScope(scope)).toBe(scope);
  });

  it("queues a job of the paused category and releases it when the pause is revoked", async () => {
    const t = setupHub();
    await t.hub.updateSettings({ admissionIntervalSeconds: 0 });
    const pause = await t.hub.createPause({ scope: "db", reason: "迁移窗口" });
    const blocked = await t.hub.submit(t.job({ category: "db" }));
    expect(blocked.state).toBe("queued");
    expect(blocked.waitReasons?.[0]).toContain("pause:db");
    expect((await t.hub.submit(t.job({ category: "build" }))).state).toBe("admitted");
    await t.hub.revokePause(pause.id);
    expect((await t.hub.wait(blocked.jobId, 0))?.state).toBe("admitted");
  });
});

describe("agent gate", () => {
  it("only agents / project pauses and machine thresholds hold agent tasks", async () => {
    const t = setupHub();
    expect(await t.hub.agentGate("Proj")).toBeNull();
    await t.hub.createPause({ scope: "all-heavy", reason: "x" });
    await t.hub.createPause({ scope: "build", reason: "x" });
    expect(await t.hub.agentGate("Proj")).toBeNull();
    const project = await t.hub.createPause({ scope: "project:proj", reason: "只停这个项目" });
    expect(await t.hub.agentGate("Proj")).toContain("只停这个项目");
    expect(await t.hub.agentGate("Other")).toBeNull();
    await t.hub.revokePause(project.id);
    await t.hub.createPause({ scope: "agents", reason: "全部 agent 暂停" });
    expect(await t.hub.agentGate(null)).toContain("全部 agent 暂停");
  });

  it("reports machine reasons when thresholds are exceeded", async () => {
    const t = setupHub();
    t.metrics.availableGb = 3;
    expect(await t.hub.agentGate("Proj")).toBe("中枢：可用内存不足");
  });
});

describe("coordinator notifications", () => {
  it("sends each key once an hour and retries after a failure", async () => {
    let time = 0;
    const sent: string[] = [];
    let fail = true;
    const notify = createCoordinatorNotifier({
      send: async (text) => {
        if (fail) throw new Error("down");
        sent.push(text);
        return { accepted: true };
      },
      now: () => time,
      onError: () => undefined,
    });
    notify("k", "a");
    await new Promise((r) => setTimeout(r, 5));
    fail = false;
    notify("k", "b");
    notify("k", "c");
    await new Promise((r) => setTimeout(r, 5));
    expect(sent).toEqual(["b"]);
    time = 59 * 60_000;
    notify("k", "d");
    time = 61 * 60_000;
    notify("k", "e");
    await new Promise((r) => setTimeout(r, 5));
    expect(sent).toEqual(["b", "e"]);
  });

  it("watcher: long queue wait, sustained metric pressure, expired pause", async () => {
    const t = setupHub();
    const messages: Array<[string, string]> = [];
    const check = createHubWatcher({
      hub: t.hub,
      notify: (key, text) => void messages.push([key, text]),
      now: t.now,
    });
    await t.hub.updateSettings({ admissionIntervalSeconds: 0 });
    t.metrics.availableGb = 3;
    const queued = await t.hub.submit(t.job());
    expect(queued.state).toBe("queued");
    await t.hub.createPause({ scope: "agents", reason: "窗口", until: new Date(t.now() + 10 * 60_000).toISOString() });

    await check();
    expect(messages).toEqual([]);
    t.advance(METRIC_WARN_MS + 1000);
    await check();
    expect(messages.map(([k]) => k)).toEqual(["metric:memory_low"]);
    t.advance(QUEUE_WARN_MS);
    await check();
    expect(messages.map(([k]) => k)).toContain("queue:" + queued.jobId);
    expect(messages.map(([k]) => k).some((k) => k.startsWith("pause-expired:"))).toBe(true);
    expect(messages.find(([k]) => k.startsWith("queue:"))![1]).toContain("可用内存不足");

    t.metrics.availableGb = 40; // pressure gone: the sustained timer resets
    messages.length = 0;
    await check();
    t.metrics.availableGb = 3;
    t.advance(60_000);
    await check();
    expect(messages.some(([k]) => k === "metric:memory_low")).toBe(false);
  });
});

describe("takeover switch", () => {
  it("is off by default (no hub.json), writes hub.json only when on, removes it when off", async () => {
    const dir = tempDir();
    const db = openVibeDb({ path: ":memory:" });
    closers.push(() => db.close());
    migrateOwner(db, "scheduler");
    const runtime = createSchedulerRuntime({ db, dataDir: tempDir(), probe: fakeMachine(), hubDir: dir });
    runtime.start();
    closers.push(() => runtime.stop());
    await new Promise((r) => setTimeout(r, 200));
    expect(runtime.takeover()).toMatchObject({ enabled: false, active: false, available: true });
    expect(existsSync(join(dir, "hub.json"))).toBe(false);

    await runtime.setTakeover(true);
    expect(runtime.takeover()).toMatchObject({ enabled: true, active: true });
    const info = JSON.parse(readFileSync(join(dir, "hub.json"), "utf8")) as { port: number; token: string };
    expect(typeof info.port).toBe("number");

    writeFileSync(join(dir, "hub.disabled"), "");
    expect(runtime.takeover().disabledFile).toBe(true);

    await runtime.setTakeover(false);
    expect(runtime.takeover()).toMatchObject({ enabled: false, active: false });
    expect(existsSync(join(dir, "hub.json"))).toBe(false);
  });

  it("remembers the switch in vibe.db", async () => {
    const db = openVibeDb({ path: ":memory:" });
    closers.push(() => db.close());
    migrateOwner(db, "scheduler");
    const first = createSchedulerRuntime({ db, dataDir: tempDir(), probe: fakeMachine() });
    await first.setTakeover(true);
    const second = createSchedulerRuntime({ db, dataDir: tempDir(), probe: fakeMachine() });
    expect(second.takeover().enabled).toBe(true);
  });
});

// --- end to end with the real python guard ---------------------------------------------------

const GUARD = "D:\\devRepoCaches\\worktrees\\ci-dashboard-hub-client\\queue\\win-heavy-guard.py";
const hasPython = (() => {
  try {
    return spawnSync("python", ["--version"], { timeout: 10_000 }).status === 0;
  } catch {
    return false;
  }
})();
const canRunGuard = process.platform === "win32" && hasPython && existsSync(GUARD);

function runGuard(lockDir: string, command: string[], options: { owner?: string } = {}) {
  const child = spawn(
    "python",
    [GUARD, "run", "--lock-dir", lockDir, "--owner", options.owner ?? "e2e", "--slots", "2", "--poll-seconds", "0.1", "--", ...command],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  const done = new Promise<number | null>((resolve) => child.on("close", resolve));
  closers.push(() => void child.kill());
  return { done, out: () => stdout, err: () => stderr };
}
function auditStarts(lockDir: string): Array<{ event: string; admission_path: string }> {
  const logs = join(lockDir, "logs");
  if (!existsSync(logs)) return [];
  return readdirSync(logs)
    .flatMap((f) => readFileSync(join(logs, f), "utf8").split("\n").filter(Boolean))
    .map((line) => JSON.parse(line) as { event: string; admission_path: string })
    .filter((e) => e.event === "start");
}
async function until<T>(read: () => T | Promise<T>, ok: (v: T) => boolean, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe.skipIf(!canRunGuard)("win-heavy-guard against the real hub", () => {
  async function start() {
    const lockDir = tempDir();
    const t = setupHub();
    await t.hub.updateSettings({ admissionIntervalSeconds: 0 });
    const http = await startHubHttp(t.hub, { dir: lockDir });
    closers.push(() => http.stop());
    return { lockDir, ...t };
  }

  it("goes through the hub: admitted, released, logged", async () => {
    const t = await start();
    const run = runGuard(t.lockDir, ["python", "-c", "print(1)"]);
    expect(await run.done).toBe(0);
    expect(run.out()).toContain("WIN_HEAVY_ACQUIRED");
    expect(auditStarts(t.lockDir).map((e) => e.admission_path)).toEqual(["hub"]);
    const status = await t.hub.status();
    expect(status.holders).toEqual([]);
    expect(status.recentJobs).toHaveLength(1);
    expect(status.recentJobs[0]).toMatchObject({ owner: "e2e", outcome: "released", exitCode: 0 });
  }, 90_000);

  it("ignores the hub while hub.disabled exists", async () => {
    const t = await start();
    writeFileSync(join(t.lockDir, "hub.disabled"), "");
    const run = runGuard(t.lockDir, ["python", "-c", "print(1)"]);
    expect(await run.done).toBe(0);
    expect(auditStarts(t.lockDir).map((e) => e.admission_path)).toEqual(["local"]);
    expect((await t.hub.status()).recentJobs).toHaveLength(0);
  }, 90_000);

  it("queues a build-category request while build is paused, then runs it after the pause is revoked", async () => {
    const t = await start();
    const pause = await t.hub.createPause({ scope: "build", reason: "构建窗口" });
    const run = runGuard(t.lockDir, ["python", "-c", "print('build')"]);
    const queued = await until(
      async () => (await t.hub.status()).queue,
      (queue) => queue.length === 1,
    );
    expect(queued[0]!.waitReasons[0]).toContain("pause:build");
    expect(run.out()).not.toContain("WIN_HEAVY_ACQUIRED");
    await t.hub.revokePause(pause.id);
    expect(await run.done).toBe(0);
    expect(auditStarts(t.lockDir).map((e) => e.admission_path)).toEqual(["hub"]);
  }, 90_000);
});
