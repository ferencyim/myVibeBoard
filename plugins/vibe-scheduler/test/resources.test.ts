import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { createPortAllocator, isPortFree } from "../server/ports";
import {
  createResourceSampler,
  createSystemProbe,
  parsePsProcesses,
  parseWindowsProcesses,
  type ProcInfo,
} from "../server/resources";
import { fakeMachine } from "./helpers";

const proc = (pid: number, ppid: number, cmd: string, rssBytes: number, cpuMs = 0): ProcInfo => ({
  pid,
  ppid,
  name: cmd,
  cmd,
  rssBytes,
  cpuMs,
});

describe("resource sampler", () => {
  it("attributes process trees to sessions by working directory and splits shared directories", async () => {
    const m = fakeMachine();
    let t = 0;
    const sampler = createResourceSampler({ probe: m, now: () => new Date(t) });
    m.procs = [
      proc(1, 0, "init", 1e6),
      proc(10, 1, "node D:\\wt\\One\\vite.js", 2e9, 0),
      proc(11, 10, "esbuild", 1e9, 0),
      proc(20, 1, "node /repo/shared/run.js", 1e9, 0),
      proc(30, 1, "unrelated", 5e9, 0),
    ];
    await sampler.sample([]);
    t = 10_000;
    m.procs = m.procs.map((p) => (p.pid === 10 ? { ...p, cpuMs: 4000 } : p)); // 4 s of cpu in 10 s on 4 cores
    const snap = await sampler.sample([
      { sessionId: "s1", cardKey: "D-1", path: "d:/wt/one/" },
      { sessionId: "s2", path: "/repo/shared" },
      { sessionId: "s3", path: "/repo/shared" },
      { sessionId: "s4", path: null },
    ]);
    expect(snap.perSession.s1).toMatchObject({ memBytes: 3e9, procs: 2, cardKey: "D-1" });
    expect(snap.perSession.s1!.cpu).toBeCloseTo(0.1);
    expect(snap.perSession.s2!.memBytes).toBe(5e8);
    expect(snap.perSession.s3!.memBytes).toBe(5e8);
    expect(snap.perSession.s4).toMatchObject({ memBytes: 0, procs: 0 });
    expect(snap.mem).toBeCloseTo(0.3);
    expect(snap.cpu).toBeGreaterThanOrEqual(0);
  });

  it("parses Windows and ps process listings", () => {
    const win = parseWindowsProcesses(
      JSON.stringify([{ ProcessId: 4, ParentProcessId: 0, Name: "System", CommandLine: null, WorkingSetSize: 1000, KernelModeTime: 20000, UserModeTime: 10000 }]),
    );
    expect(win[0]).toMatchObject({ pid: 4, cmd: "", rssBytes: 1000, cpuMs: 3 });
    expect(parseWindowsProcesses(JSON.stringify({ ProcessId: 5, ParentProcessId: 4, Name: "x" }))).toHaveLength(1);
    const ps = parsePsProcesses("  100     1  2048 01:02:03 /usr/bin/node app.js\n  101   100   512 1-00:00:01 sh -c x\n");
    expect(ps[0]).toMatchObject({ pid: 100, ppid: 1, rssBytes: 2048 * 1024, cpuMs: 3_723_000, name: "node" });
    expect(ps[1]!.cpuMs).toBe(86_401_000);
  });

  // Real sample of this machine; prints the numbers. Opt in with VIBE_E2E_SAMPLE=1.
  it.skipIf(!process.env.VIBE_E2E_SAMPLE)("samples the real machine", async () => {
    const sampler = createResourceSampler({ probe: createSystemProbe(), diskPath: process.cwd() });
    await sampler.sample([]);
    await new Promise((r) => setTimeout(r, 1500));
    const snap = await sampler.sample([{ sessionId: "self", path: process.cwd() }]);
    console.log("REAL SAMPLE", JSON.stringify(snap));
    expect(snap.mem).toBeGreaterThan(0);
    expect(snap.disk?.totalBytes).toBeGreaterThan(0);
  }, 60_000);
});

describe("port allocator", () => {
  it("hands out distinct stable ports, skips busy ones, persists and releases", async () => {
    const busy = new Set([5000]);
    const a = createPortAllocator({ base: 5000, span: 3, isFree: async (p) => !busy.has(p) });
    expect(await a.allocate("c1")).toBe(5001);
    expect(await a.allocate("c1")).toBe(5001);
    expect(await a.allocate("c2")).toBe(5002);
    await expect(a.allocate("c3")).rejects.toThrow(/No free/);
    a.release("c1");
    expect(await a.allocate("c3")).toBe(5001);
  });

  it("really checks the machine for listeners", async () => {
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    expect(await isPortFree(port)).toBe(false);
    await new Promise((r) => server.close(r));
    expect(await isPortFree(port)).toBe(true);
  });
});
