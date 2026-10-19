// adb command construction and output parsing. Everything goes through the injected Runner.

import type { RunResult, Runner } from "../../vibe/contract";

export interface AdbDevice {
  serial: string;
  state: string;
}

/** Parse `adb devices` output. */
export function parseAdbDevices(stdout: string): AdbDevice[] {
  const lines = stdout.split(/\r?\n/);
  return lines
    .slice(lines.findIndex((l) => l.startsWith("List of devices")) + 1)
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length >= 2 && p[0] && !p[0].startsWith("*"))
    .map(([serial, state]) => ({ serial, state }));
}

/** Parse `pidof` output (empty / exit 1 when not running). */
export function parsePids(stdout: string): number[] {
  return stdout
    .split(/\s+/)
    .filter((s) => /^\d+$/.test(s))
    .map(Number);
}

/** Package currently holding window focus, from `dumpsys window` output. */
export function parseFocusedPackage(stdout: string): string | undefined {
  const m = /mCurrentFocus=Window\{[^}]*?\s([\w.]+)\/[\w.$]+\}/.exec(stdout);
  return m?.[1];
}

/** Last `pkg/.Activity` line of `cmd package resolve-activity --brief` output. */
export function parseResolvedActivity(stdout: string): string | undefined {
  return stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .reverse()
    .find((l) => /^[\w.]+\/[\w.$]+$/.test(l));
}

/** Emulator console port from a serial like `emulator-5554`. */
export function emulatorPort(serial: string): number | undefined {
  const m = /^emulator-(\d+)$/.exec(serial);
  return m ? Number(m[1]) : undefined;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** `adb shell input text` wants spaces as %s and shell-safe quoting. */
export function inputTextArg(text: string): string {
  return shellQuote(text.replaceAll(" ", "%s"));
}

export function ffmpegGifArgs(input: string, output: string, fps = 8, width = 360): string[] {
  return [
    "-y",
    "-i",
    input,
    "-vf",
    `fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse`,
    output,
  ];
}

export class Adb {
  constructor(
    private readonly runner: Runner,
    readonly serial: string,
    private readonly adbPath = "adb",
    private readonly signal?: AbortSignal,
  ) {}

  run(args: readonly string[], timeoutMs = 60_000): Promise<RunResult> {
    return this.runner.run(this.adbPath, ["-s", this.serial, ...args], {
      timeoutMs,
      signal: this.signal,
    });
  }

  shell(command: string, timeoutMs?: number): Promise<RunResult> {
    return this.run(["shell", command], timeoutMs);
  }

  async mustRun(args: readonly string[], timeoutMs?: number): Promise<RunResult> {
    const result = await this.run(args, timeoutMs);
    if (result.exitCode !== 0) {
      throw new Error(
        `adb ${args.join(" ")} failed (exit ${result.exitCode}${result.timedOut ? ", timeout" : ""}): ${(result.stderr || result.stdout).trim().slice(0, 300)}`,
      );
    }
    return result;
  }

  async isBooted(): Promise<boolean> {
    const r = await this.shell("getprop sys.boot_completed", 10_000);
    return r.exitCode === 0 && r.stdout.trim() === "1";
  }

  install(apk: string): Promise<RunResult> {
    return this.mustRun(["install", "-r", "-t", "-g", apk], 300_000);
  }

  reverse(port: number): Promise<RunResult> {
    return this.mustRun(["reverse", `tcp:${port}`, `tcp:${port}`], 15_000);
  }

  forceStop(pkg: string): Promise<RunResult> {
    return this.shell(`am force-stop ${pkg}`, 15_000);
  }

  clearLogcat(): Promise<RunResult> {
    return this.mustRun(["logcat", "-c"], 15_000);
  }

  async dumpLogcat(lines = 20_000): Promise<string> {
    const r = await this.mustRun(["logcat", "-d", "-v", "threadtime", "-t", String(lines)], 60_000);
    return r.stdout;
  }

  /**
   * Start the app's launcher activity. `monkey` is avoided: it hangs on newer emulator images
   * when run without a tty.
   */
  async launchApp(pkg: string, activity?: string): Promise<RunResult> {
    let component = activity;
    if (!component) {
      const resolved = await this.mustRun(
        ["shell", `cmd package resolve-activity --brief -c android.intent.category.LAUNCHER ${pkg}`],
        20_000,
      );
      component = parseResolvedActivity(resolved.stdout);
      if (!component) throw new Error(`No launcher activity found for ${pkg}`);
    }
    return this.mustRun(["shell", `am start -W -n ${component}`], 60_000);
  }

  openUri(uri: string, pkg?: string): Promise<RunResult> {
    const target = pkg ? ` ${pkg}` : "";
    return this.mustRun(
      ["shell", `am start -W -a android.intent.action.VIEW -d ${shellQuote(uri)}${target}`],
      60_000,
    );
  }

  async pids(pkg: string): Promise<number[]> {
    return parsePids((await this.shell(`pidof ${pkg}`, 10_000)).stdout);
  }

  async focusedPackage(): Promise<string | undefined> {
    return parseFocusedPackage((await this.shell("dumpsys window", 15_000)).stdout);
  }

  tap(x: number, y: number) {
    return this.mustRun(["shell", `input tap ${Math.round(x)} ${Math.round(y)}`], 15_000);
  }

  swipe(x1: number, y1: number, x2: number, y2: number, durationMs = 300) {
    const coords = [x1, y1, x2, y2].map(Math.round).join(" ");
    return this.mustRun(["shell", `input swipe ${coords} ${Math.round(durationMs)}`], 15_000);
  }

  text(text: string) {
    return this.mustRun(["shell", `input text ${inputTextArg(text)}`], 15_000);
  }

  key(key: string) {
    if (!/^\w+$/.test(key)) throw new Error(`Invalid key: ${key}`);
    return this.mustRun(["shell", `input keyevent ${key}`], 15_000);
  }

  /** screencap on device, pull, remove. PNG ends up at `localPath`. */
  async screenshot(localPath: string): Promise<void> {
    const remote = `/sdcard/vibe-shot-${process.pid}-${Date.now()}.png`;
    await this.mustRun(["shell", `screencap -p ${remote}`], 30_000);
    await this.pullAndRemove(remote, localPath);
  }

  /** Start screenrecord; the promise resolves when the recording process ends. */
  startRecording(remote: string, timeLimitSec: number): Promise<RunResult> {
    return this.run(
      ["shell", `screenrecord --time-limit ${timeLimitSec} ${remote}`],
      (timeLimitSec + 30) * 1000,
    );
  }

  /** SIGINT lets screenrecord finalize the mp4. */
  stopRecording(): Promise<RunResult> {
    return this.shell("kill -2 $(pidof screenrecord)", 10_000);
  }

  async pullAndRemove(remote: string, localPath: string): Promise<void> {
    try {
      await this.mustRun(["pull", remote, localPath], 60_000);
    } finally {
      await this.shell(`rm -f ${remote}`, 10_000);
    }
  }
}
