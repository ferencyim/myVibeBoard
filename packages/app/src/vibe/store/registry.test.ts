import { beforeEach, describe, expect, it, vi } from "vitest";

const openVibeDb = vi.fn();
vi.mock("./open-db", () => ({ openVibeDb: (serverId: string) => openVibeDb(serverId) }));

describe("local replica registry", () => {
  beforeEach(() => {
    openVibeDb.mockReset();
    vi.resetModules();
  });

  it("opens no database at import time (cold start must not touch SQLite)", async () => {
    await import("./registry");
    expect(openVibeDb).not.toHaveBeenCalled();
  });

  it("returns null when the platform has no local database, and asks only once per host", async () => {
    openVibeDb.mockReturnValue(null);
    const { getLocalReplica } = await import("./registry");
    expect(getLocalReplica("a")).toBeNull();
    expect(getLocalReplica("a")).toBeNull();
    expect(openVibeDb).toHaveBeenCalledTimes(1);
  });

  it("survives a database that fails to open without retrying on every call", async () => {
    openVibeDb.mockImplementation(() => {
      throw new Error("disk full");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { getLocalReplica } = await import("./registry");
    expect(getLocalReplica("a")).toBeNull();
    expect(getLocalReplica("a")).toBeNull();
    expect(openVibeDb).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
