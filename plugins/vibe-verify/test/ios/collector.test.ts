import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createIosCollector } from "../../server/collectors/ios";
import type { IosConfig } from "../../server/collectors/ios";
import { createScriptedRunner, type RunCall } from "../../server/vibe/contract";
import { makeCtx, solidPng } from "../helpers";

const BUNDLE = "com.example.app";
const sshCommand = (c: RunCall) => (c.command === "ssh" ? String(c.args[c.args.length - 1]) : "");

interface FakeMac {
  uname?: string;
  xcode?: boolean;
  simctl?: boolean;
  sshFails?: boolean;
  crashFiles?: string[];
  launchFails?: boolean;
  alreadyBooted?: boolean;
}

function fakeMac(o: FakeMac = {}) {
  let shotCount = 0;
  return createScriptedRunner((call) => {
    if (call.command === "scp") {
      const dst = String(call.args[call.args.length - 1]);
      const src = String(call.args[call.args.length - 2]);
      if (src.startsWith("macbox:") && !dst.startsWith("macbox:")) {
        // pull: png for screenshots, bytes for the rest
        writeFileSync(dst, src.endsWith(".png") ? solidPng(8, 8, [shotCount * 40, 0, 0]) : "data");
      }
      return {};
    }
    const cmd = sshCommand(call);
    if (cmd.startsWith("uname")) {
      if (o.sshFails) return { exitCode: 255, stderr: "ssh: Could not resolve hostname" };
      const out = `${o.uname ?? "Darwin"}\n`;
      if (!o.xcode) return { exitCode: 127, stdout: out, stderr: "xcodebuild: command not found" };
      if (o.simctl === false) return { exitCode: 1, stdout: `${out}Xcode 16.0\n` };
      return { stdout: `${out}Xcode 16.0\n/usr/bin/simctl\n` };
    }
    if (cmd.includes("'list' 'devices' 'booted'")) {
      return { stdout: o.alreadyBooted ? "-- iOS 18 --\n    iPhone 15 (UDID) (Booted)\n" : "" };
    }
    if (cmd.includes("'screenshot'")) {
      shotCount++;
      return {};
    }
    if (cmd.includes("'launch'")) {
      return o.launchFails ? { exitCode: 1, stderr: "not installed" } : { stdout: `${BUNDLE}: 4242\n` };
    }
    if (cmd.startsWith("nohup")) return { stdout: "9999\n" };
    if (cmd.startsWith("find ")) return { stdout: (o.crashFiles ?? []).join("\n") };
    return {};
  });
}

const config = (extra: Partial<IosConfig> = {}): IosConfig => ({
  device: "iPhone 15",
  app: { bundleId: BUNDLE, launchArgs: [], settleMs: 0 },
  steps: [{ type: "openurl", url: "myapp://home" }, { type: "screenshot", label: "home" }],
  ...extra,
});

const noSleep = async () => {};

describe("ios collector detect()", () => {
  it("is unavailable without a host", async () => {
    delete process.env.VIBE_MAC_HOST;
    const c = createIosCollector({ config: config() });
    const r = await c.detect(makeCtx({ runner: fakeMac() }));
    expect(r.available).toBe(false);
    expect(r.reason).toContain("<MAC_HOST>");
  });

  it("is available on macOS with Xcode and runs the spec probe", async () => {
    const runner = fakeMac({ xcode: true });
    const c = createIosCollector({ host: "macbox", config: config() });
    expect(await c.detect(makeCtx({ runner }))).toEqual({ available: true });
    expect(sshCommand(runner.calls[0])).toBe("uname && xcodebuild -version && xcrun --find simctl");
  });

  it("explains missing Xcode, non-macOS and ssh failures", async () => {
    const make = (m: FakeMac) => createIosCollector({ host: "macbox", config: config() }).detect(makeCtx({ runner: fakeMac(m) }));
    expect((await make({ xcode: false })).reason).toMatch(/Xcode is not installed/);
    expect((await make({ xcode: false, uname: "Linux" })).reason).toMatch(/not macOS/);
    expect((await make({ sshFails: true })).reason).toMatch(/ssh to the Mac failed: ssh: Could not resolve/);
    expect((await make({ xcode: true, simctl: false })).reason).toMatch(/simctl not found/);
  });

  it("rejects a hostile host alias instead of running ssh", async () => {
    const runner = fakeMac({ xcode: true });
    const c = createIosCollector({ host: "-oProxyCommand=x", config: config() });
    const r = await c.detect(makeCtx({ runner }));
    expect(r.available).toBe(false);
    expect(runner.calls).toHaveLength(0);
  });
});

describe("ios collector collect()", () => {
  it("syncs the app, boots, installs, records, captures and pulls everything back", async () => {
    const worktree = mkdtempSync(path.join(tmpdir(), "vibe-ios-wt-"));
    mkdirSync(path.join(worktree, "build", "App.app"), { recursive: true });
    const runner = fakeMac({ xcode: true });
    const c = createIosCollector({ host: "macbox", sleep: noSleep, config: config({ app: { bundleId: BUNDLE, appPath: "build/App.app", launchArgs: [], settleMs: 0 } }) });
    const ctx = makeCtx({ runner, projectType: "ios", worktreePath: worktree });
    const result = await c.collect(ctx);
    await c.dispose?.(ctx);

    const cmds = runner.calls.map((x) => sshCommand(x)).filter(Boolean);
    const joined = cmds.join("\n");
    expect(joined).toContain("'xcrun' 'simctl' 'boot' 'iPhone 15'");
    expect(joined).toContain("'xcrun' 'simctl' 'bootstatus' 'iPhone 15'");
    expect(joined).toMatch(/'simctl' 'install' 'iPhone 15' '\/tmp\/vibe-verify\/ver-1-\d+\/App\.app'/);
    expect(joined).toContain("'recordVideo' '--codec=h264'");
    expect(joined).toContain("'openurl' 'iPhone 15' 'myapp://home'");
    expect(joined).toContain("kill -INT 9999");
    // dispose: terminated the app and shut down the simulator it booted
    expect(cmds.at(-2)).toContain("'terminate' 'iPhone 15' 'com.example.app'");
    expect(cmds.at(-1)).toContain("'shutdown' 'iPhone 15'");
    // app was synced with scp -r
    const put = runner.calls.find((x) => x.command === "scp" && x.args.includes("-r"));
    expect(put?.args.at(-1)).toMatch(/^macbox:\/tmp\/vibe-verify\//);

    const kinds = result.artifacts.map((a) => a.kind);
    expect(kinds.filter((k) => k === "screenshot")).toHaveLength(3); // launch, home, final
    expect(kinds).toEqual(expect.arrayContaining(["gif", "video", "log", "report"]));
    for (const a of result.artifacts) {
      expect(existsSync(a.path)).toBe(true);
      expect(a.simulated).toBe(true);
      expect(a.commitHash).toBe("abc1234");
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(a.capturedAt).toBe("2026-10-19T00:00:00.000Z");
    }
    expect(result.artifacts.find((a) => a.kind === "video")?.mimeType).toBe("video/mp4");
    expect(result.judgement).toBeUndefined();
    expect(result.degraded).toBe(false);
  });

  it("does not shut down a simulator that was already running", async () => {
    const runner = fakeMac({ xcode: true, alreadyBooted: true });
    const c = createIosCollector({ host: "macbox", sleep: noSleep, config: config() });
    const ctx = makeCtx({ runner, projectType: "ios" });
    await c.collect(ctx);
    await c.dispose?.(ctx);
    const joined = runner.calls.map(sshCommand).join("\n");
    expect(joined).not.toContain("'boot'");
    expect(joined).not.toContain("'shutdown'");
  });

  it("builds on the Mac when configured and passes quoted args", async () => {
    const runner = fakeMac({ xcode: true });
    const c = createIosCollector({
      host: "macbox",
      sleep: noSleep,
      config: config({
        app: {
          bundleId: BUNDLE,
          launchArgs: [],
          settleMs: 0,
          appPath: "build/App.app",
          build: { cwd: "/Users/dev/proj", command: "xcodebuild", args: ["-scheme", "My App"], timeoutMs: 1000 },
        },
      }),
    });
    await c.collect(makeCtx({ runner, projectType: "ios" }));
    const joined = runner.calls.map(sshCommand).join("\n");
    expect(joined).toContain("cd '/Users/dev/proj' && 'xcodebuild' '-scheme' 'My App'");
    expect(joined).toContain("'install' 'iPhone 15' '/Users/dev/proj/build/App.app'");
  });

  it("fails the judgement and pulls the crash report when the Mac has one", async () => {
    const runner = fakeMac({ xcode: true, crashFiles: ["/Users/dev/Library/Logs/DiagnosticReports/App-2026.ips"] });
    const c = createIosCollector({ host: "macbox", sleep: noSleep, config: config() });
    const result = await c.collect(makeCtx({ runner, projectType: "ios" }));
    expect(result.judgement).toBe("fail");
    expect(result.artifacts.some((a) => a.label?.includes("crash report App-2026.ips"))).toBe(true);
    expect(result.notes.join("\n")).toContain("crash report on the Mac");
  });

  it("fails when the app cannot be launched", async () => {
    const runner = fakeMac({ xcode: true, launchFails: true });
    const c = createIosCollector({ host: "macbox", sleep: noSleep, config: config() });
    const result = await c.collect(makeCtx({ runner, projectType: "ios" }));
    expect(result.judgement).toBe("fail");
    expect(result.notes.join("\n")).toContain("launch failed");
  });

  it("throws when ssh is broken during setup", async () => {
    const runner = createScriptedRunner(() => ({ exitCode: 255, stderr: "Permission denied" }));
    const c = createIosCollector({ host: "macbox", sleep: noSleep, config: config() });
    await expect(c.collect(makeCtx({ runner, projectType: "ios" }))).rejects.toThrow(/mkdir failed/);
  });
});
