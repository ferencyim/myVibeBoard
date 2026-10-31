import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { acquirePidLock, getPidLockInfo, updatePidLock } from "./pid-lock.js";
import { createShutdownChannel, requestSupervisorShutdown } from "./supervisor-shutdown-channel.js";

describe("supervisor shutdown channel", () => {
  test("keeps the shutdown channel when publishing and clearing the endpoint", async () => {
    const home = await mkdtemp(join(tmpdir(), "paseo-channel-"));
    const address = { port: 12345, token: "a".repeat(64) };
    try {
      await acquirePidLock(home, null, { shutdownChannel: address });
      expect((await getPidLockInfo(home))?.shutdownChannel).toEqual(address);
      await updatePidLock(home, { listen: "127.0.0.1:1234", serverId: "test" });
      await updatePidLock(home, { listen: null, serverId: null });
      expect((await getPidLockInfo(home))?.shutdownChannel).toEqual(address);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("accepts a valid capability before the worker is ready and rejects a wrong token", async () => {
    const shutdown = vi.fn();
    const channel = await createShutdownChannel(shutdown);
    try {
      await expect(
        requestSupervisorShutdown({ ...channel.address, token: "0".repeat(64) }),
      ).rejects.toThrow();
      expect(shutdown).not.toHaveBeenCalled();
      await requestSupervisorShutdown(channel.address);
      await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce());
    } finally {
      await channel.close();
    }
  });
});
