import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHub, type JobRequest } from "../server/hub";
import { startHubHttp } from "../server/hub-http";
import { createHubMetrics, type HubMetrics } from "../server/hub-metrics";
import { createHubStore } from "../server/hub-store";
import { migrateOwner, openVibeDb } from "../server/vibe/db";

const closers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "hub-probe-"));
  closers.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setup(lockDir: string | null, alive: Set<number> = new Set()) {
  const db = openVibeDb({ path: ":memory:" });
  closers.push(() => db.close());
  migrateOwner(db, "scheduler");
  const metrics: HubMetrics = { ts: "", availableGb: 40, cpuPercent: 10 };
  const hub = createHub({
    store: createHubStore(db, () => new Date()),
    metrics: async () => ({ ...metrics }),
    isPidAlive: (pid) => alive.has(pid),
    lockDir,
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
  return { hub, job };
}

/** A holder directory exactly like a local-mode guard writes it. */
function localHolder(lockDir: string, n: number, pid: number, extra: Record<string, unknown> = {}) {
  const token = String(n).padStart(32, "a");
  const dir = join(lockDir, `slot-${n}-${pid}-${token}`);
  mkdirSync(dir);
  writeFileSync(
    join(dir, "owner.txt"),
    JSON.stringify({ token, pid, code_version: 2, exclusive: false, admission_path: "local", ...extra }),
  );
  return dir;
}

describe("background metrics", () => {
  it("never waits for a sample, flags stale, and runs one sample at a time", async () => {
    let calls = 0;
    let finish: (v: string) => void = () => undefined;
    let time = 1_000_000;
    const m = createHubMetrics({
      platform: "win32",
      now: () => new Date(time),
      cpuWindowSeconds: () => 10,
      run: () =>
        new Promise<string>((resolve) => {
          calls += 1;
          finish = resolve;
        }),
    });
    const first = await m.read(); // sample not started: answers at once
    expect(first.stale).toBe(true);

    const a = m.sampleOnce();
    const b = m.sampleOnce();
    expect(calls).toBe(1);
    expect((await m.read()).stale).toBe(true); // still sampling, read does not wait
    finish('{"commit":50,"processes":10,"handles":20,"diskQueue":0}');
    await Promise.all([a, b]);
    const fresh = await m.read();
    expect(fresh.stale).toBeUndefined();
    expect(fresh.commitPercent).toBe(50);

    time += 31_000;
    const old = await m.read();
    expect(old.stale).toBe(true);
    expect(old.commitPercent).toBe(50); // the old reading is still served
  });

  it("hub status and admission do not touch the sampler", async () => {
    let calls = 0;
    const db = openVibeDb({ path: ":memory:" });
    closers.push(() => db.close());
    migrateOwner(db, "scheduler");
    const hub = createHub({
      store: createHubStore(db, () => new Date()),
      run: () => {
        calls += 1;
        return new Promise<string>(() => undefined); // would hang forever
      },
      isPidAlive: () => true,
    });
    const status = await Promise.race([
      hub.status(),
      new Promise<null>((r) => setTimeout(() => r(null), 2000)),
    ]);
    expect(status).not.toBeNull();
    expect(status!.machine.metrics.stale).toBe(true);
    expect((await hub.submit({ ...setup(null).job() })).state).toBe("admitted");
    expect(calls).toBe(0);
  });
});

describe("GET /v1/ping", () => {
  it("checks only the token and answers at once", async () => {
    const dir = tempDir();
    const t = setup(dir);
    const http = await startHubHttp(t.hub, { dir });
    closers.push(() => http.stop());
    const info = JSON.parse(readFileSync(join(dir, "hub.json"), "utf8"));
    const ping = (token: string) =>
      fetch(`http://127.0.0.1:${info.port}/v1/ping`, { headers: { authorization: "Bearer " + token } });
    expect((await ping("bad")).status).toBe(401);
    const ok = await ping(info.token);
    expect(await ok.json()).toEqual({ ok: true, pid: process.pid, startedAt: info.startedAt });
  });
});

describe("mixed mode with the local lock directory", () => {
  it("writes holder directories on admit and removes them on release", async () => {
    const dir = tempDir();
    const t = setup(dir);
    await t.hub.updateSettings({ hardLimit: 4, admissionIntervalSeconds: 0 });
    const view = await t.hub.submit(t.job({ slots: 2 }));
    expect(view!.state).toBe("admitted");
    const dirs = readdirSync(dir).filter((n) => n.startsWith("slot-"));
    expect(dirs).toHaveLength(2);
    const owner = JSON.parse(readFileSync(join(dir, dirs[0]!, "owner.txt"), "utf8"));
    expect(owner).toMatchObject({
      via: "hub",
      hub_job_id: view!.jobId,
      pid: 100,
      owner: "s1",
      exclusive: false,
      code_version: 2,
      token: view!.jobId.replaceAll("-", ""),
    });
    expect(dirs[0]).toBe(`slot-1-100-${owner.token}`);
    await t.hub.release(view!.jobId, { exitCode: 0 });
    expect(readdirSync(dir).filter((n) => n.startsWith("slot-"))).toEqual([]);
  });

  it("counts live local holders against slots and exclusivity, ignoring dead pids", async () => {
    const dir = tempDir();
    const alive = new Set([500]);
    const t = setup(dir, alive);
    await t.hub.updateSettings({ hardLimit: 3, admissionIntervalSeconds: 0 }); // priority 1 cap: 2
    localHolder(dir, 1, 500);
    localHolder(dir, 2, 999); // dead process: ignored
    const first = await t.hub.submit(t.job({ pid: 101 }));
    expect(first.state).toBe("admitted");
    const second = await t.hub.submit(t.job({ pid: 102 }));
    expect(second.state).toBe("queued");
    expect(second.waitReasons).toContain("slots_full");
    // The local holder finishes: the queued job gets in on the next pass.
    alive.delete(500);
    await t.hub.tick();
    expect((await t.hub.wait(second.jobId, 0))?.state).toBe("admitted");
  });

  it("waits for an exclusive local holder and an exclusive job waits for local holders", async () => {
    const dir = tempDir();
    const alive = new Set([500]);
    const t = setup(dir, alive);
    await t.hub.updateSettings({ hardLimit: 4, admissionIntervalSeconds: 0 });
    const holder = localHolder(dir, 1, 500, { exclusive: true });
    const blocked = await t.hub.submit(t.job());
    expect(blocked.waitReasons).toContain("exclusive_running");
    unlinkSync(join(holder, "owner.txt"));
    rmdirSync(holder);
    await t.hub.tick();
    expect((await t.hub.wait(blocked.jobId, 0))?.state).toBe("admitted");
    await t.hub.release(blocked.jobId, {});

    localHolder(dir, 1, 500);
    const excl = await t.hub.submit(t.job({ exclusive: true }));
    expect(excl.waitReasons).toContain("exclusive_wait");
  });

  it("does not count its own directories twice and keeps working without a lock dir", async () => {
    const dir = tempDir();
    const t = setup(dir);
    await t.hub.updateSettings({ hardLimit: 3, admissionIntervalSeconds: 0 });
    expect((await t.hub.submit(t.job())).state).toBe("admitted");
    expect((await t.hub.submit(t.job())).state).toBe("admitted"); // 2 = cap, own dirs counted once
    expect((await t.hub.submit(t.job())).state).toBe("queued");
    const plain = setup(null);
    expect((await plain.hub.submit(plain.job())).state).toBe("admitted");
    expect(existsSync(join(dir, "hub.json"))).toBe(false);
  });
});
