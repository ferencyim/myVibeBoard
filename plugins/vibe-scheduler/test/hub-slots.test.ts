import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHub, type JobRequest } from "../server/hub";
import type { HubMetrics } from "../server/hub-metrics";
import { createHubStore } from "../server/hub-store";
import { migrateOwner, openVibeDb } from "../server/vibe/db";

const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0).reverse()) close();
});

/** A lock directory shaped like the real one: dynamic guard, slots.txt, admission.lock, logs/. */
function realLockDir(slots = 4) {
  const dir = mkdtempSync(join(tmpdir(), "hub-slots-"));
  closers.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "slots.txt"), slots + "\n");
  writeFileSync(join(dir, "admission-state.json"), JSON.stringify({ version: 2, last_started_at: 0 }));
  writeFileSync(join(dir, "admission.lock"), "");
  mkdirSync(join(dir, "logs"));
  return dir;
}

function setup(lockDir: string, hardLimit: number, metrics: HubMetrics = { ts: "", availableGb: 40, cpuPercent: 10 }) {
  const db = openVibeDb({ path: ":memory:" });
  closers.push(() => db.close());
  migrateOwner(db, "scheduler");
  const events: string[] = [];
  const hub = createHub({
    store: createHubStore(db, () => new Date()),
    metrics: async () => ({ ...metrics }),
    isPidAlive: () => true,
    lockDir,
    onEvent: (event) => void events.push(event),
  });
  const ready = hub.updateSettings({ hardLimit, admissionIntervalSeconds: 0 });
  let pid = 100;
  const job = (extra: Partial<JobRequest> = {}): JobRequest => ({
    owner: "s",
    command: "npm",
    commandSha256: "x",
    priority: 1,
    exclusive: false,
    pid: pid++,
    ...extra,
  });
  return { hub, ready, job, events, metrics };
}

describe("slot semantics (regression: idle machine reported slots_full)", () => {
  it("admits at once on an idle machine; the request does not carry the machine slot count", async () => {
    const dir = realLockDir(4);
    const t = setup(dir, 5);
    await t.ready;
    // An older guard still sends the machine's slot count as `slots`; it must not count as occupancy.
    const view = await t.hub.submit({ ...t.job(), slots: 4 } as JobRequest);
    expect(view.state).toBe("admitted");
    expect(t.events).toEqual([]); // no bypass needed
  });

  it("slots.txt=4, hardLimit 5: capacity 4, normal jobs leave the last slot to deploy", async () => {
    const dir = realLockDir(4);
    const t = setup(dir, 5);
    await t.ready;
    for (let i = 0; i < 3; i++) expect((await t.hub.submit(t.job())).state).toBe("admitted");
    const fourth = await t.hub.submit(t.job());
    expect(fourth.state).toBe("queued");
    expect(fourth.waitReasons).toContain("slots_full");
    expect((await t.hub.submit(t.job({ priority: 0 }))).state).toBe("admitted");
    expect((await t.hub.submit(t.job({ priority: 0 }))).state).toBe("queued");
    expect(readdirSync(dir).filter((n) => n.startsWith("slot-"))).toHaveLength(4);
  });

  it("hardLimit 5 with slots.txt=6: hardLimit is the smaller, 4 normal jobs and a fifth for deploy", async () => {
    const dir = realLockDir(6);
    const t = setup(dir, 5);
    await t.ready;
    for (let i = 0; i < 4; i++) expect((await t.hub.submit(t.job())).state).toBe("admitted");
    expect((await t.hub.submit(t.job())).waitReasons).toContain("slots_full");
    expect((await t.hub.submit(t.job({ priority: 0 }))).state).toBe("admitted");
  });

  it("a legacy-mode guard (no admission-state.json) caps the machine at 2 like the guard does", async () => {
    const dir = realLockDir(4);
    rmSync(join(dir, "admission-state.json"));
    const t = setup(dir, 5);
    await t.ready;
    expect((await t.hub.submit(t.job())).state).toBe("admitted");
    expect((await t.hub.submit(t.job())).waitReasons).toContain("slots_full");
    expect((await t.hub.submit(t.job({ priority: 0 }))).state).toBe("admitted");
  });

  it("units > 1 occupies several slots", async () => {
    const dir = realLockDir(4);
    const t = setup(dir, 5);
    await t.ready;
    expect((await t.hub.submit(t.job({ units: 3 }))).state).toBe("admitted");
    expect((await t.hub.submit(t.job())).waitReasons).toContain("slots_full");
  });
});

describe("empty-machine deadlock guard", () => {
  it("admits the queue head with no holders even when slots, interval and metrics say no", async () => {
    const dir = realLockDir(1);
    const t = setup(dir, 5, { ts: "", availableGb: 1, cpuPercent: 99 });
    await t.ready;
    await t.hub.updateSettings({ admissionIntervalSeconds: 600 });
    const first = await t.hub.submit(t.job({ units: 4 }));
    expect(first.state).toBe("admitted");
    expect(t.events).toEqual(["hub_empty_machine_bypass"]);
    const log = readdirSync(join(dir, "logs"));
    expect(log).toHaveLength(1);
    const record = JSON.parse(readFileSync(join(dir, "logs", log[0]!), "utf8").trim());
    expect(record).toMatchObject({ event: "hub_empty_machine_bypass", via: "hub" });
    expect(record.ignoredReasons).toEqual(expect.arrayContaining(["slots_full", "memory_low", "cpu_high"]));
    // Only the head: the next job waits behind a real holder.
    const second = await t.hub.submit(t.job());
    expect(second.state).toBe("queued");
  });

  it("does not bypass a pause", async () => {
    const dir = realLockDir(1);
    const t = setup(dir, 5, { ts: "", availableGb: 1 });
    await t.ready;
    await t.hub.createPause({ scope: "all-heavy", reason: "维护" });
    expect((await t.hub.submit(t.job())).state).toBe("queued");
    expect(t.events).toEqual([]);
  });
});
