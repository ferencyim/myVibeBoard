import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDesktopCollector } from "../../server/collectors/desktop";
import type {
  AppLauncher,
  AppProcess,
  DesktopConfig,
  ElectronDriver,
  WindowCapturer,
} from "../../server/collectors/desktop";
import { makeCtx, solidPng } from "../helpers";

const noSleep = async () => {};

interface FakeProc extends AppProcess {
  stopped: boolean;
  exit?: number | null;
}

function fakeLauncher(opts: { exitAfterPolls?: number; exitCode?: number } = {}) {
  const started: { command: string; args: readonly string[]; cwd?: string }[] = [];
  const procs: FakeProc[] = [];
  const launcher: AppLauncher = {
    start(command, args, options) {
      started.push({ command, args, cwd: options.cwd });
      const proc: FakeProc = {
        pid: 777,
        stopped: false,
        exitCode: () => proc.exit,
        output: () => ({ stdout: "out-line", stderr: "err-line" }),
        stop: async () => void (proc.stopped = true),
      };
      if (opts.exitCode !== undefined) proc.exit = opts.exitCode;
      procs.push(proc);
      return proc;
    },
  };
  return { launcher, started, procs };
}

/** Window appears after `missingPolls` failed attempts. */
function fakeCapturer(missingPolls = 0) {
  let polls = 0;
  const targets: { pid?: number; title?: string }[] = [];
  const capturer: WindowCapturer = {
    probe: async () => ({ ok: true }),
    async capture(_runner, target, file) {
      targets.push(target);
      if (polls++ < missingPolls) return { ok: false, reason: "no matching window", windowMissing: true };
      writeFileSync(file, solidPng(10, 10, [polls * 20, 0, 0]));
      return { ok: true };
    },
  };
  return { capturer, targets };
}

const config = (extra: Partial<DesktopConfig["app"]> = {}, steps?: DesktopConfig["steps"]): DesktopConfig => ({
  app: { command: "C:\\app\\App.exe", args: ["--x"], windowTimeoutMs: 5000, settleMs: 0, automation: "none", ...extra },
  steps,
});

describe("desktop collector", () => {
  it("launches, waits for the window, captures frames, builds a GIF and stops its process", async () => {
    const { launcher, started, procs } = fakeLauncher();
    const { capturer, targets } = fakeCapturer(2);
    const c = createDesktopCollector({
      launcher,
      capturer,
      sleep: noSleep,
      config: config({}, [{ type: "screenshot", label: "mid" }, { type: "click", selector: "#x" }]),
    });
    const ctx = makeCtx({ projectType: "desktop" });
    const result = await c.collect(ctx);
    await c.dispose?.(ctx);

    expect(started[0]).toEqual({ command: "C:\\app\\App.exe", args: ["--x"], cwd: undefined });
    expect(targets[0]).toEqual({ pid: 777, title: undefined });
    expect(procs[0].stopped).toBe(true);
    const kinds = result.artifacts.map((a) => a.kind);
    expect(kinds.filter((k) => k === "screenshot")).toHaveLength(3); // launch, mid, final
    expect(kinds).toEqual(expect.arrayContaining(["gif", "log", "report"]));
    for (const a of result.artifacts) {
      expect(existsSync(a.path)).toBe(true);
      expect(a.simulated).toBe(false);
      expect(a.commitHash).toBe("abc1234");
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    const log = result.artifacts.find((a) => a.kind === "log");
    expect(log?.mimeType).toBe("text/plain");
    // click needs electron automation: degraded, said in notes
    expect(result.degraded).toBe(true);
    expect(result.notes.join("\n")).toContain('Step "click" skipped');
    expect(result.judgement).toBeUndefined();
  });

  it("resolves worktree-relative executables and checks they exist", async () => {
    const worktree = mkdtempSync(path.join(tmpdir(), "vibe-desk-wt-"));
    const { launcher, started } = fakeLauncher();
    const c = createDesktopCollector({
      launcher,
      capturer: fakeCapturer().capturer,
      sleep: noSleep,
      fileExists: () => false,
      config: config({ command: "release/win-unpacked/App.exe" }),
    });
    await expect(c.collect(makeCtx({ worktreePath: worktree }))).rejects.toThrow(/not found/);
    expect(started).toHaveLength(0);

    const ok = createDesktopCollector({
      launcher,
      capturer: fakeCapturer().capturer,
      sleep: noSleep,
      fileExists: () => true,
      config: config({ command: "release/win-unpacked/App.exe" }),
    });
    await ok.collect(makeCtx({ worktreePath: worktree }));
    expect(started[0].command).toBe(path.join(worktree, "release/win-unpacked/App.exe"));
  });

  it("fails when the app exits before showing a window", async () => {
    const { launcher } = fakeLauncher({ exitCode: 3 });
    const c = createDesktopCollector({ launcher, capturer: fakeCapturer(Infinity).capturer, sleep: noSleep, config: config() });
    const result = await c.collect(makeCtx({ projectType: "desktop" }));
    expect(result.judgement).toBe("fail");
    expect(result.notes.join("\n")).toContain("exited (code 3) before a window appeared");
    expect(result.artifacts.some((a) => a.kind === "screenshot")).toBe(false);
  });

  it("fails after the window timeout", async () => {
    const { launcher } = fakeLauncher();
    const c = createDesktopCollector({
      launcher,
      capturer: fakeCapturer(Infinity).capturer,
      sleep: async () => new Promise((r) => setTimeout(r, 2)),
      config: config({ windowTimeoutMs: 20 }),
    });
    const result = await c.collect(makeCtx({ projectType: "desktop" }));
    expect(result.judgement).toBe("fail");
    expect(result.notes.join("\n")).toContain("no window appeared");
  });

  it("passes the title regex to the capturer", async () => {
    const { launcher } = fakeLauncher();
    const { capturer, targets } = fakeCapturer();
    const c = createDesktopCollector({ launcher, capturer, sleep: noSleep, config: config({ windowTitle: "^Notepad" }) });
    await c.collect(makeCtx({ projectType: "desktop" }));
    expect(targets[0]).toEqual({ pid: 777, title: "^Notepad" });
  });

  it("drives Electron apps through the injected driver, including click/fill/press", async () => {
    const stepsSeen: string[] = [];
    let closed = false;
    const electron: ElectronDriver = {
      async launch() {
        return {
          screenshot: async () => solidPng(6, 6, [stepsSeen.length * 30, 0, 0]),
          step: async (s) => void stepsSeen.push(s.type),
          output: () => ({ stdout: "electron-out", stderr: "" }),
          close: async () => void (closed = true),
        };
      },
    };
    const { launcher, started } = fakeLauncher();
    const c = createDesktopCollector({
      launcher,
      capturer: fakeCapturer().capturer,
      electron,
      sleep: noSleep,
      config: config({ automation: "electron" }, [
        { type: "click", selector: "#go" },
        { type: "fill", selector: "#in", value: "v" },
        { type: "press", key: "Enter" },
      ]),
    });
    const ctx = makeCtx({ projectType: "desktop" });
    const result = await c.collect(ctx);
    await c.dispose?.(ctx);
    expect(stepsSeen).toEqual(["click", "fill", "press"]);
    expect(started).toHaveLength(0);
    expect(closed).toBe(true);
    expect(result.degraded).toBe(false);
    expect(result.artifacts.find((a) => a.kind === "log")).toBeTruthy();
  });

  it("falls back to a plain launch when Electron automation cannot start", async () => {
    const electron: ElectronDriver = {
      launch: async () => {
        throw new Error("nodeCliInspect disabled");
      },
    };
    const { launcher, started } = fakeLauncher();
    const c = createDesktopCollector({
      launcher,
      capturer: fakeCapturer().capturer,
      electron,
      sleep: noSleep,
      config: config({ automation: "electron" }),
    });
    const result = await c.collect(makeCtx({ projectType: "desktop" }));
    expect(started).toHaveLength(1);
    expect(result.degraded).toBe(true);
    expect(result.notes.join("\n")).toContain("nodeCliInspect disabled");
  });
});

describe("desktop collector detect()", () => {
  it("is unavailable without a capturer for the platform", async () => {
    const c = createDesktopCollector({ platform: "linux", config: config() });
    const r = await c.detect(makeCtx());
    expect(r.available).toBe(false);
    expect(r.reason).toContain("linux");
  });

  it("reports probe failures and degraded capturers", async () => {
    const failing: WindowCapturer = { probe: async () => ({ ok: false, reason: "no PowerShell" }), capture: async () => ({ ok: false, reason: "x" }) };
    expect((await createDesktopCollector({ capturer: failing, config: config() }).detect(makeCtx())).reason).toBe("no PowerShell");
    const degraded: WindowCapturer = { probe: async () => ({ ok: true, degraded: "full screen" }), capture: failing.capture };
    expect(await createDesktopCollector({ capturer: degraded, config: config() }).detect(makeCtx())).toEqual({
      available: true,
      degraded: true,
      reason: "full screen",
    });
  });
});
