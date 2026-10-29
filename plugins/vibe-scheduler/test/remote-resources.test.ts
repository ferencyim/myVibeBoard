import { createSchedulerRuntime } from "../server/runtime";
import { describe, expect, it, vi } from "vitest";
import { parseRemoteResources, sampleRemoteHost } from "../server/remote-resources";
import {
  resourcePressure,
  formatResourceHost,
  readResourceBriefing,
  writeResourceMeta,
  openVibeDb,
  migrateOwner,
} from "../server/vibe/db";
import { createResourceSampler } from "../server/resources";
import { fakeMachine } from "./helpers";
const GB = 1024 ** 3;
const mac =
  "Darwin\n8589934592\n8\n{ 6.8 4.2 2.0 }\nMach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 10000.\nPages inactive: 60000.\nPages speculative: 8643.";
const linux = "Linux\n4\nMemTotal: 16777216 kB\nMemAvailable: 8388608 kB\n1.25 0.8 0.5 1/100 123";
describe("remote resources", () => {
  it("parses macOS available pages and page size", () => {
    expect(parseRemoteResources(mac)).toEqual({
      totalBytes: 8 * GB,
      availableBytes: 78643 * 16384,
      cores: 8,
      load1: 6.8,
    });
  });
  it("parses Linux meminfo and loadavg", () => {
    expect(parseRemoteResources(linux)).toEqual({
      totalBytes: 16 * GB,
      availableBytes: 8 * GB,
      cores: 4,
      load1: 1.25,
    });
  });
  it("returns SSH failures as unreachable and uses noninteractive options", async () => {
    const run = vi.fn().mockRejectedValue(new Error("connection refused"));
    const h = await sampleRemoteHost({ name: "Mac", target: "user@example-host" }, run);
    expect(h.error).toBe("connection refused");
    expect(run.mock.calls[0]?.slice(0, 1)).toEqual(["ssh"]);
    expect(run.mock.calls[0]?.[1].slice(0, 5)).toEqual([
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=8",
      "user@example-host",
    ]);
  });
  it("rejects unsafe targets before spawning ssh", async () => {
    const run = vi.fn();
    expect(
      (await sampleRemoteHost({ name: "Mac", target: "-oProxyCommand=bad" }, run)).error,
    ).toBeTruthy();
    expect(
      (await sampleRemoteHost({ name: "Mac", target: "-user@example-host" }, run)).error,
    ).toBeTruthy();
    expect(run).not.toHaveBeenCalled();
  });
  it("rejects malformed output", () => {
    expect(() => parseRemoteResources("Darwin\n8")).toThrow();
    expect(() =>
      parseRemoteResources(linux.replace("MemAvailable: 8388608", "MemAvailable: 999999999")),
    ).toThrow();
    expect(() => parseRemoteResources(linux.replace("Linux\n4", "Linux\n4.5"))).toThrow();
  });
  it("evaluates every pressure threshold with strict boundaries", () => {
    const h = {
      name: "本机",
      ts: "",
      totalBytes: 64 * GB,
      availableBytes: 20 * GB,
      cores: 8,
      load1: 6.8,
      committedRatio: 0.9,
    };
    expect(resourcePressure(h)).toEqual([]);
    expect(resourcePressure({ ...h, availableBytes: 9 * GB })).toContain("可用内存不足");
    expect(resourcePressure({ ...h, totalBytes: 8 * GB, availableBytes: 1.4 * GB })).toContain(
      "可用内存不足",
    );
    expect(resourcePressure({ ...h, load1: 6.9 })).toContain("1 分钟负载过高");
    expect(resourcePressure({ ...h, committedRatio: 0.91 })).toContain("已提交内存超过 90%");
  });
  it("formats a minimal brief and only includes configured remote hosts", () => {
    const db = openVibeDb({ path: ":memory:" });
    migrateOwner(db, "scheduler");
    try {
      writeResourceMeta(db, "scheduler.local_resources", {
        name: "本机",
        ts: "",
        cpu: 0.34,
        totalBytes: 64 * GB,
        availableBytes: 22.1 * GB,
      });
      writeResourceMeta(db, "scheduler.remote_hosts", [
        { name: "Mac", target: "user@example-host" },
      ]);
      writeResourceMeta(db, "scheduler.remote_resources", [
        {
          name: "Mac",
          target: "user@example-host",
          ts: "",
          totalBytes: 8 * GB,
          availableBytes: 1.2 * GB,
          cores: 8,
          load1: 6.8,
        },
      ]);
      const result = readResourceBriefing(db);
      expect(result.briefing).toBe(
        "资源：本机 CPU 34% 内存余 22.1/64GB；Mac 内存余 1.2/8GB 负载 6.8/8（紧张）",
      );
      expect(result.tightItems).toEqual(["Mac：可用内存不足"]);
      expect(formatResourceHost({ name: "Mac", ts: "", error: "SSH failed" })).toBe("Mac 不可达");
    } finally {
      db.close();
    }
  });
  it("samples local committed memory and load", async () => {
    const probe = fakeMachine();
    probe.memoryCommit = async () => 0.95;
    probe.load1 = () => 7;
    const s = await createResourceSampler({ probe }).sample([]);
    expect(s.committedRatio).toBe(0.95);
    expect(s.load1).toBe(7);
    expect(s.totalBytes).toBe(probe.totalMem());
  });
  it("keeps remote samples in metadata and never blocks the local sampler", async () => {
    const db = openVibeDb({ path: ":memory:" });
    migrateOwner(db, "scheduler");
    let resolveRemote!: (output: string) => void;
    const remoteRun = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveRemote = resolve;
        }),
    );
    const runtime = createSchedulerRuntime({ db, dataDir: ".", probe: fakeMachine(), remoteRun });
    try {
      writeResourceMeta(db, "scheduler.remote_hosts", [
        { name: "Mac", target: "user@example-host" },
      ]);
      const pending = runtime.sampleRemotesNow();
      await runtime.sampleNow();
      expect(
        db.prepare<{ count: number }>("SELECT COUNT(*) AS count FROM resource_sample").get()?.count,
      ).toBe(1);
      resolveRemote(mac);
      await pending;
      expect(readResourceBriefing(db).hosts[1]?.availableBytes).toBe(78643 * 16384);
      expect(
        db.prepare<{ count: number }>("SELECT COUNT(*) AS count FROM resource_sample").get()?.count,
      ).toBe(1);
    } finally {
      await runtime.stop();
      db.close();
    }
  });
});
