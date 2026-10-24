import { describe, expect, it } from "vitest";
import { createInMemoryLeaseProvider } from "../../server/collectors/android/lease";

const req = { platform: "android", verificationId: "v", ttlMs: 1000 } as const;

describe("in-memory device lease", () => {
  it("grants exclusively and hands the device to the next waiter on release", async () => {
    const leases = createInMemoryLeaseProvider([{ deviceId: "d1", serial: "emulator-5554" }]);
    const first = await leases.acquire(req);
    expect(leases.held()).toEqual(["d1"]);
    let secondGot = false;
    const second = leases.acquire({ ...req, verificationId: "v2" }).then((h) => {
      secondGot = true;
      return h;
    });
    await Promise.resolve();
    expect(secondGot).toBe(false);
    await first.release();
    await first.release(); // idempotent
    const handle = await second;
    expect(handle.deviceId).toBe("d1");
    await handle.release();
    expect(leases.held()).toEqual([]);
  });

  it("rejects unknown devices and aborted waits", async () => {
    const leases = createInMemoryLeaseProvider([{ deviceId: "d1" }]);
    await expect(leases.acquire({ ...req, preferredDeviceId: "nope" })).rejects.toThrow(
      "No matching",
    );
    await leases.acquire(req);
    const ac = new AbortController();
    const waiting = leases.acquire({ ...req, signal: ac.signal });
    ac.abort();
    await expect(waiting).rejects.toThrow("aborted");
  });
});
