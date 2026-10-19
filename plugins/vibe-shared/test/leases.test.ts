import { describe, expect, it } from "vitest";
import { migrateOwner, openVibeDb } from "../db";
import { createDeviceLeases } from "../db/leases";

function setup(start = 1_700_000_000_000) {
  const db = openVibeDb({ path: ":memory:" });
  migrateOwner(db, "scheduler");
  let t = start;
  const leases = createDeviceLeases(db, {
    now: () => new Date(t),
    sleep: async () => void (t += 1000),
  });
  return { db, leases };
}

describe("device leases", () => {
  it("leases exclusively, exposes serial/avd, and frees on release", async () => {
    const { leases } = setup();
    leases.registerDevice({
      kind: "emulator",
      name: "emu-1",
      meta: { serial: "emulator-5554", avd: "Pixel" },
    });
    const a = await leases.acquire({ platform: "android", cardId: null, ttlMs: 60_000 });
    expect(a).toMatchObject({ serial: "emulator-5554", avd: "Pixel" });
    expect(leases.tryAcquire({ platform: "android", ttlMs: 1000 })).toBeNull();
    expect(leases.poolStatus()).toMatchObject({ busy: 1, total: 1 });
    await a.release();
    expect(leases.tryAcquire({ platform: "android", ttlMs: 1000 })).not.toBeNull();
  });

  it("waits for expiry of the holder's lease", async () => {
    const { leases } = setup();
    leases.registerDevice({ kind: "emulator", name: "emu-1" });
    await leases.acquire({ kind: "emulator", ttlMs: 2500 });
    const b = await leases.acquire({ kind: "emulator", ttlMs: 1000 });
    expect(b.leaseId).toBeTruthy();
  });

  it("rejects when nothing matches or when aborted", async () => {
    const { leases } = setup();
    await expect(leases.acquire({ platform: "android", ttlMs: 1 })).rejects.toThrow(/No matching/);
    leases.registerDevice({ kind: "emulator", name: "emu-1", meta: { serial: "s1" } });
    await leases.acquire({ preferredDeviceId: "s1", ttlMs: 0 });
    const ac = new AbortController();
    ac.abort();
    await expect(
      leases.acquire({ preferredDeviceId: "s1", ttlMs: 1, signal: ac.signal }),
    ).rejects.toThrow(/aborted/);
  });
});
