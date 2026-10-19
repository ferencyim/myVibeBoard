import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAndroidCollector } from "../../server/collectors/android/collector";
import { createInMemoryLeaseProvider } from "../../server/collectors/android/lease";
import type {
  AndroidCollectorOptions,
  ProcessSpawner,
} from "../../server/collectors/android/types";
import {
  createScriptedRunner,
  type CollectorContext,
  type RunCall,
} from "../../server/vibe/contract";

const PKG = "com.example.app";
const SERIAL = "emulator-5554";

interface FakeOptions {
  maestro?: boolean;
  ffmpeg?: boolean;
  logcat?: string;
  appRunning?: () => boolean;
  /** serials listed as online by `adb devices` (mutable to simulate boot). */
  online?: string[];
}

/** Fake adb/ffmpeg/maestro: answers like a healthy device and writes pulled/converted files. */
function fakeEnvironment(opts: FakeOptions = {}) {
  const online = opts.online ?? [SERIAL];
  const runner = createScriptedRunner((call: RunCall) => {
    const { command, args } = call;
    if (command === "adb" && args[0] === "version") return {};
    if (command === "adb" && args[0] === "devices") {
      return {
        stdout: `List of devices attached\n${online.map((s) => `${s}\tdevice`).join("\n")}\n`,
      };
    }
    if (command === "maestro") return opts.maestro ? {} : { exitCode: 127 };
    if (command === "ffmpeg") {
      if (!opts.ffmpeg) return { exitCode: 127 };
      const out = args.at(-1);
      if (out?.endsWith(".gif")) writeFileSync(out, "GIF89a");
      return {};
    }
    if (command !== "adb") return undefined;
    const rest = args.slice(2); // drop "-s <serial>"
    const cmd = rest.join(" ");
    if (rest[0] === "pull") writeFileSync(rest[2] as string, `data:${rest[1]}`);
    if (cmd.includes("getprop sys.boot_completed")) return { stdout: "1\n" };
    if (cmd.includes("resolve-activity")) return { stdout: `priority=0
${PKG}/.MainActivity
` };
    if (cmd.startsWith("shell pm path")) return { stdout: `package:/data/app/${PKG}/base.apk\n` };
    if (cmd.startsWith("shell pidof ") && !cmd.includes("screenrecord")) {
      return (opts.appRunning ?? (() => true))() ? { stdout: "4321\n" } : { exitCode: 1 };
    }
    if (rest[0] === "logcat" && rest[1] === "-d") return { stdout: opts.logcat ?? "I app: fine\n" };
    return undefined;
  });
  return { runner };
}

function makeCtx(runner: CollectorContext["runner"], extra: Partial<CollectorContext> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "vibe-android-"));
  const ctx: CollectorContext = {
    cardId: "card-1",
    verificationId: "ver-1",
    projectType: "android",
    projectPath: dir,
    worktreePath: dir,
    commitHash: "abc123",
    outputDir: path.join(dir, "out"),
    check: { id: "chk-1", text: "Shows the home screen", method: "screenshot" },
    runner,
    now: () => new Date("2026-10-19T12:00:00Z"),
    log: () => {},
    ...extra,
  };
  return ctx;
}

const baseOptions = (extra: Partial<AndroidCollectorOptions> = {}): AndroidCollectorOptions => ({
  app: { packageName: PKG, mode: "bundled" },
  sleep: async () => {},
  leases: createInMemoryLeaseProvider([{ deviceId: "dev-1", serial: SERIAL }]),
  ...extra,
});

const adbCmds = (runner: { calls: RunCall[] }) =>
  runner.calls
    .filter((c) => c.command === "adb" && c.args[0] === "-s")
    .map((c) => c.args.slice(2).join(" "));

describe("android collector", () => {
  it("collects a full bundle with ffmpeg + adb steps and degrades without maestro", async () => {
    const { runner } = fakeEnvironment({ ffmpeg: true });
    const leases = createInMemoryLeaseProvider([{ deviceId: "dev-1", serial: SERIAL }]);
    const collector = createAndroidCollector(
      baseOptions({
        leases,
        flow: {
          maestroFile: "flows/home.yaml",
          steps: [
            { type: "tap", x: 100, y: 200 },
            { type: "screenshot", label: "after tap" },
          ],
        },
      }),
    );
    const ctx = makeCtx(runner);
    const result = await collector.collect(ctx);
    expect(leases.held()).toEqual(["dev-1"]);
    await collector.dispose?.(ctx);
    expect(leases.held()).toEqual([]);

    const kinds = result.artifacts.map((a) => a.kind);
    expect(kinds.filter((k) => k === "screenshot")).toHaveLength(3); // launch, after tap, final
    expect(kinds).toEqual(expect.arrayContaining(["gif", "video", "log", "report"]));
    for (const a of result.artifacts) {
      expect(existsSync(a.path)).toBe(true);
      expect(a.commitHash).toBe("abc123");
      expect(a.simulated).toBe(true);
      expect(a.capturedAt).toBe("2026-10-19T12:00:00.000Z");
    }
    expect(result.artifacts.find((a) => a.kind === "screenshot")?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.judgement).toBeUndefined();
    expect(result.degraded).toBe(true);
    expect(result.notes.join("\n")).toContain("Maestro not found");

    const cmds = adbCmds(runner);
    const idx = (s: string) => cmds.findIndex((c) => c.includes(s));
    expect(idx("am force-stop")).toBeLessThan(idx("logcat -c"));
    expect(idx("screenrecord")).toBeLessThan(idx("am start -W -n"));
    expect(idx("am start -W -n")).toBeLessThan(idx("input tap 100 200"));
    expect(idx("input tap")).toBeLessThan(idx("logcat -d"));
  });

  it("uses maestro when present", async () => {
    const { runner } = fakeEnvironment({ maestro: true, ffmpeg: true });
    const collector = createAndroidCollector(
      baseOptions({ flow: { maestroFile: "flows/a.yaml" } }),
    );
    const result = await collector.collect(makeCtx(runner));
    const call = runner.calls.find((c) => c.command === "maestro" && c.args[0] === "--device");
    expect(call?.args.slice(0, 2)).toEqual(["--device", SERIAL]);
    expect(call?.args[2]).toBe("test");
    expect(result.degraded).toBe(false);
    expect(result.artifacts.some((a) => a.label === "Maestro output")).toBe(true);
  });

  it("fails the judgement on a logcat crash and when the app dies", async () => {
    const crash = `E AndroidRuntime: FATAL EXCEPTION: main\nE AndroidRuntime: Process: ${PKG}, PID: 9\n`;
    const { runner } = fakeEnvironment({ ffmpeg: true, logcat: crash });
    const result = await createAndroidCollector(baseOptions()).collect(makeCtx(runner));
    expect(result.judgement).toBe("fail");
    expect(result.notes.join("\n")).toContain("java crash");

    let calls = 0;
    const { runner: r2 } = fakeEnvironment({ ffmpeg: true, appRunning: () => ++calls <= 1 });
    const result2 = await createAndroidCollector(baseOptions()).collect(makeCtx(r2));
    expect(result2.judgement).toBe("fail");
    expect(result2.notes.join("\n")).toContain("gone at the end");
  });

  it("keeps the mp4 and says so when ffmpeg is missing", async () => {
    const { runner } = fakeEnvironment({ ffmpeg: false });
    const result = await createAndroidCollector(baseOptions()).collect(makeCtx(runner));
    const kinds = result.artifacts.map((a) => a.kind);
    expect(kinds).toContain("video");
    expect(kinds).not.toContain("gif");
    expect(result.degraded).toBe(true);
    expect(result.notes.join("\n")).toContain("ffmpeg not found");
  });

  it("debug-metro mode: starts Metro, reverses the port, warms the bundle, opens the dev client", async () => {
    const { runner } = fakeEnvironment({ ffmpeg: true });
    const killed: string[] = [];
    const spawned: Array<{ command: string; args: readonly string[] }> = [];
    const spawner: ProcessSpawner = {
      spawn(command, args) {
        spawned.push({ command, args });
        return { kill: () => void killed.push(command) };
      },
    };
    let metroUp = false;
    const probed: string[] = [];
    const collector = createAndroidCollector(
      baseOptions({
        spawner,
        httpProbe: async (url) => {
          probed.push(url);
          if (url.endsWith("/status")) {
            const was = metroUp;
            metroUp = true; // answers from the second poll on
            return was;
          }
          return true;
        },
        app: {
          packageName: PKG,
          mode: "debug-metro",
          launchUri: "exp+app://expo-development-client/?url={metroUrl}",
          metro: { command: "npx", args: ["expo", "start", "--dev-client"], port: 8081 },
        },
      }),
    );
    const ctx = makeCtx(runner);
    const result = await collector.collect(ctx);
    expect(spawned).toEqual([{ command: "npx", args: ["expo", "start", "--dev-client"] }]);
    expect(probed.some((u) => u.includes("/index.bundle?platform=android"))).toBe(true);
    const cmds = adbCmds(runner);
    expect(cmds).toContain("reverse tcp:8081 tcp:8081");
    expect(cmds.find((c) => c.includes("android.intent.action.VIEW"))).toContain(
      encodeURIComponent("http://localhost:8081"),
    );
    expect(result.notes.join("\n")).toContain("Metro bundle warmed");
    await collector.dispose?.(ctx);
    expect(killed).toEqual(["npx"]);
  });

  it("boots the AVD headless when the leased device is offline, and stops only what it started", async () => {
    const online: string[] = [];
    const { runner } = fakeEnvironment({ ffmpeg: true, online });
    const spawns: Array<{ command: string; args: readonly string[] }> = [];
    let killed = false;
    const spawner: ProcessSpawner = {
      spawn(command, args) {
        spawns.push({ command, args });
        online.push(SERIAL); // emulator comes up
        return { kill: () => void (killed = true) };
      },
    };
    const leases = createInMemoryLeaseProvider([
      { deviceId: "dev-1", serial: SERIAL, avd: "Pixel_API_35" },
    ]);
    const collector = createAndroidCollector(baseOptions({ leases, spawner }));
    const ctx = makeCtx(runner);
    await collector.collect(ctx);
    expect(spawns[0]?.command).toBe("emulator");
    expect(spawns[0]?.args).toEqual(
      expect.arrayContaining([
        "-avd",
        "Pixel_API_35",
        "-no-window",
        "-no-snapshot-save",
        "-port",
        "5554",
      ]),
    );
    await collector.dispose?.(ctx);
    expect(killed).toBe(true);
    expect(adbCmds(runner)).toContain("emu kill");
    expect(leases.held()).toEqual([]);
  });

  it("does not stop an emulator it did not start, and skips leasing when ctx.deviceId is set", async () => {
    const { runner } = fakeEnvironment({ ffmpeg: true });
    const collector = createAndroidCollector(baseOptions({ leases: undefined }));
    const ctx = makeCtx(runner, { deviceId: SERIAL });
    await collector.collect(ctx);
    await collector.dispose?.(ctx);
    expect(adbCmds(runner)).not.toContain("emu kill");
  });

  it("releases the lease when setup fails (missing APK)", async () => {
    const { runner } = fakeEnvironment();
    const leases = createInMemoryLeaseProvider([{ deviceId: "dev-1", serial: SERIAL }]);
    const collector = createAndroidCollector(
      baseOptions({
        leases,
        app: { packageName: PKG, mode: "bundled", apkPath: "app-release.apk" },
        fileExists: () => false,
      }),
    );
    const ctx = makeCtx(runner);
    await expect(collector.collect(ctx)).rejects.toThrow("APK not found");
    await collector.dispose?.(ctx);
    expect(leases.held()).toEqual([]);
  });

  it("installs the APK when given", async () => {
    const { runner } = fakeEnvironment({ ffmpeg: true });
    const collector = createAndroidCollector(
      baseOptions({
        app: { packageName: PKG, mode: "bundled", apkPath: "/tmp/app.apk" },
        fileExists: () => true,
      }),
    );
    await collector.collect(makeCtx(runner));
    expect(adbCmds(runner)).toContain("install -r -t -g /tmp/app.apk");
  });

  it("detect reports availability and degradation", async () => {
    const none = createScriptedRunner((c) =>
      c.args[0] === "version" ? { exitCode: 127 } : undefined,
    );
    expect(await createAndroidCollector(baseOptions()).detect(makeCtx(none))).toMatchObject({
      available: false,
      reason: "adb not found",
    });

    const { runner } = fakeEnvironment({ ffmpeg: false, maestro: false });
    const collector = createAndroidCollector(baseOptions({ flow: { maestroFile: "a.yaml" } }));
    const availability = await collector.detect(makeCtx(runner));
    expect(availability.available).toBe(true);
    expect(availability.degraded).toBe(true);
    expect(availability.reason).toContain("Maestro");
    expect(availability.reason).toContain("ffmpeg");

    const { runner: offline } = fakeEnvironment({ online: [] });
    const noBoot = createAndroidCollector({ ...baseOptions(), leases: undefined });
    expect((await noBoot.detect(makeCtx(offline))).available).toBe(false);
  });
});
