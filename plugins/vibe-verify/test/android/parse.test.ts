import { describe, expect, it } from "vitest";
import {
  Adb,
  emulatorPort,
  ffmpegGifArgs,
  inputTextArg,
  parseAdbDevices,
  parseFocusedPackage,
  parsePids,
  parseResolvedActivity,
} from "../../server/collectors/android/adb";
import { analyzeLogcat } from "../../server/collectors/android/logcat";
import { createScriptedRunner } from "../../server/vibe/contract";

describe("adb parsing", () => {
  it("parses adb devices, ignoring daemon noise", () => {
    const out =
      "* daemon started successfully\nList of devices attached\nemulator-5554\tdevice\nR58M\toffline\n\n";
    expect(parseAdbDevices(out)).toEqual([
      { serial: "emulator-5554", state: "device" },
      { serial: "R58M", state: "offline" },
    ]);
    expect(parseAdbDevices("List of devices attached\n\n")).toEqual([]);
  });

  it("parses pids, focus and emulator port", () => {
    expect(parsePids("1234 5678\n")).toEqual([1234, 5678]);
    expect(parsePids("")).toEqual([]);
    expect(
      parseFocusedPackage("  mCurrentFocus=Window{d518ebc u0 sh.paseo.debug/sh.paseo.debug.MainActivity}"),
    ).toBe("sh.paseo.debug");
    expect(parseResolvedActivity(["priority=0 x=1", "com.x/.Main", ""].join("\r\n"))).toBe(
      "com.x/.Main",
    );
    expect(parseResolvedActivity("No activity found")).toBeUndefined();
    expect(emulatorPort("emulator-5590")).toBe(5590);
    expect(emulatorPort("R58M")).toBeUndefined();
  });

  it("quotes text input", () => {
    expect(inputTextArg("hi there's")).toBe(String.raw`'hi%sthere'\''s'`);
  });

  it("builds ffmpeg gif args", () => {
    const args = ffmpegGifArgs("a.mp4", "a.gif");
    expect(args.slice(0, 3)).toEqual(["-y", "-i", "a.mp4"]);
    expect(args.at(-1)).toBe("a.gif");
  });

  it("builds adb commands against the serial", async () => {
    const runner = createScriptedRunner(() => undefined);
    const adb = new Adb(runner, "emulator-5554", "adb");
    await adb.tap(10.4, 20.6);
    await adb.launchApp("com.x", "com.x/.Main");
    await adb.openUri("exp://a?b=1&c=2", "com.x");
    expect(runner.calls.map((c) => c.args)).toEqual([
      ["-s", "emulator-5554", "shell", "input tap 10 21"],
      ["-s", "emulator-5554", "shell", "am start -W -n com.x/.Main"],
      [
        "-s",
        "emulator-5554",
        "shell",
        "am start -W -a android.intent.action.VIEW -d 'exp://a?b=1&c=2' com.x",
      ],
    ]);
    expect(() => adb.key("KEYCODE_BACK; rm -rf /")).toThrow("Invalid key");
  });

  it("raises on non-zero exit", async () => {
    const runner = createScriptedRunner(() => ({ exitCode: 1, stderr: "device offline" }));
    await expect(new Adb(runner, "x").install("a.apk")).rejects.toThrow("device offline");
  });
});

describe("logcat crash analysis", () => {
  const pkg = "sh.paseo.debug";
  const java = [
    "10-19 12:00:00.000  100  100 E AndroidRuntime: FATAL EXCEPTION: main",
    `10-19 12:00:00.000  100  100 E AndroidRuntime: Process: ${pkg}, PID: 100`,
    "10-19 12:00:00.000  100  100 E AndroidRuntime: java.lang.IllegalStateException: boom",
  ].join("\n");

  it("finds a java crash of the package only", () => {
    expect(analyzeLogcat(java, pkg).crashes).toHaveLength(1);
    expect(analyzeLogcat(java, pkg).crashes[0]?.kind).toBe("java");
    expect(analyzeLogcat(java, "other.app").crashes).toHaveLength(0);
    // prefix package must not match
    expect(analyzeLogcat(java.replace(`${pkg},`, `${pkg}.sub,`), pkg).crashes).toHaveLength(0);
  });

  it("finds ANR and native crashes", () => {
    const text = [
      `I ActivityManager: ANR in ${pkg} (${pkg}/.MainActivity)`,
      "F libc    : Fatal signal 11 (SIGSEGV), code 1",
      `F DEBUG   : pid: 1, tid: 1, name: x  >>> ${pkg} <<<`,
    ].join("\n");
    expect(analyzeLogcat(text, pkg).crashes.map((c) => c.kind)).toEqual(["anr", "native"]);
  });

  it("counts JS errors without treating them as crashes", () => {
    const text = "10-19 E ReactNativeJS: Error: x\n10-19 I ReactNativeJS: ok";
    expect(analyzeLogcat(text, pkg)).toEqual({ crashes: [], jsErrors: 1 });
  });
});
