import type { CollectorContext } from "../context";
// Android emulator evidence collector (WP-23).
//
// Flow: lease device -> make sure the emulator is up -> install APK (or Metro for debug builds)
// -> clear logcat, start screenrecord -> launch -> run Maestro flow or adb steps (screenshot per
// check) -> stop recording (mp4 -> GIF with ffmpeg) -> logcat crash analysis -> evidence bundle.
// Missing Maestro / ffmpeg degrade (adb only, mp4 instead of GIF) and say so in `notes`.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  CollectResult,
  CollectorAvailability,
  EvidenceArtifact,
  EvidenceCollector,
} from "../../vibe/contract";
import type { EvidenceKind, Judgement } from "../../vibe/contract";
import { loadVerifyConfig } from "../common";
import { Adb, emulatorPort, ffmpegGifArgs, parseAdbDevices } from "./adb";
import { analyzeLogcat } from "./logcat";
import type {
  AdbStep,
  AndroidAppConfig,
  AndroidCollectorOptions,
  AndroidFlow,
  DeviceLeaseHandle,
  SpawnedProcess,
} from "./types";

interface RunState {
  lease?: DeviceLeaseHandle;
  emulator?: SpawnedProcess;
  metro?: SpawnedProcess;
  adb?: Adb;
  recording?: Promise<unknown>;
  remoteRecording?: string;
}

const MAX_RECORD_SEC = 120;
const DEFAULT_LEASE_TTL_MS = 30 * 60_000;

const sleepReal = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "shot";

async function httpProbeReal(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    await res.arrayBuffer();
    return res.ok;
  } catch {
    return false;
  }
}

export function createAndroidCollector(options: AndroidCollectorOptions): EvidenceCollector {
  const adbPath = options.adbPath ?? "adb";
  const ffmpegPath = options.ffmpegPath ?? "ffmpeg";
  const maestroPath = options.maestroPath ?? "maestro";
  const emulatorPath = options.emulatorPath ?? "emulator";
  const sleep = options.sleep ?? sleepReal;
  const fileExists = options.fileExists ?? existsSync;
  const httpProbe = options.httpProbe ?? httpProbeReal;
  const record = options.record ?? true;
  const states = new Map<string, RunState>();

  const resolveApp = (ctx: CollectorContext): AndroidAppConfig => {
    if (typeof options.app === "function") return options.app(ctx);
    if (options.app) return options.app;
    const configured = loadVerifyConfig(ctx.worktreePath).android?.app;
    if (!configured) throw new Error("未在 .vibe/verify.json 或选项中配置 android.app");
    return configured;
  };
  const resolveFlow = (ctx: CollectorContext): AndroidFlow | undefined => {
    if (typeof options.flow === "function") return options.flow(ctx);
    return options.flow ?? loadVerifyConfig(ctx.worktreePath).android?.flow;
  };
  const inWorktree = (ctx: CollectorContext, p: string) =>
    path.isAbsolute(p) ? p : path.join(ctx.worktreePath, p);

  async function toolPresent(ctx: CollectorContext, command: string, args: string[]) {
    try {
      const r = await ctx.runner.run(command, args, { timeoutMs: 15_000 });
      return r.exitCode === 0;
    } catch {
      return false;
    }
  }

  async function detect(ctx: CollectorContext): Promise<CollectorAvailability> {
    if (!(await toolPresent(ctx, adbPath, ["version"]))) {
      return { available: false, reason: "未找到 adb" };
    }
    const devices = await ctx.runner.run(adbPath, ["devices"], { timeoutMs: 15_000 });
    const online = parseAdbDevices(devices.stdout).filter((d) => d.state === "device");
    const canBoot = Boolean(options.spawner && options.leases);
    if (online.length === 0 && !canBoot) {
      return { available: false, reason: "没有在线 Android 模拟器，也未配置 AVD 启动" };
    }
    const degradedBy: string[] = [];
    const flow = resolveFlow(ctx);
    if (flow?.maestroFile && !(await toolPresent(ctx, maestroPath, ["--version"]))) {
      degradedBy.push("未找到 Maestro，流程使用 adb 步骤");
    }
    if (record && !(await toolPresent(ctx, ffmpegPath, ["-version"]))) {
      degradedBy.push("未找到 ffmpeg，录屏保留为 mp4 而不生成 GIF");
    }
    return degradedBy.length
      ? { available: true, degraded: true, reason: degradedBy.join("; ") }
      : { available: true };
  }

  async function ensureOnline(
    ctx: CollectorContext,
    state: RunState,
    serial: string,
    avd: string | undefined,
    notes: string[],
  ) {
    const adb = state.adb as Adb;
    const listed = async () =>
      parseAdbDevices((await ctx.runner.run(adbPath, ["devices"], { timeoutMs: 15_000 })).stdout);
    const isUp = async () =>
      (await listed()).some((d) => d.serial === serial && d.state === "device");

    if (!(await isUp())) {
      if (!avd || !options.spawner) {
        throw new Error(`设备 ${serial} 不在线，且未配置 AVD 或启动器`);
      }
      const port = emulatorPort(serial);
      const args = ["-avd", avd, "-no-window", "-no-audio", "-no-boot-anim", "-no-snapshot-save"];
      if (port) args.push("-port", String(port));
      ctx.log(`booting AVD ${avd} headless (snapshot start)`);
      state.emulator = options.spawner.spawn(emulatorPath, args);
      notes.push(`已为 AVD ${avd} 启动无界面模拟器（使用快速启动快照，退出时不保存）。`);
    }
    const deadline = Date.now() + (options.bootTimeoutMs ?? 180_000);
    while (!(await isUp())) {
      if (Date.now() > deadline) throw new Error(`模拟器 ${serial} 上线超时`);
      await sleep(2000);
    }
    while (!(await adb.isBooted())) {
      if (Date.now() > deadline) throw new Error(`模拟器 ${serial} 未能完成启动`);
      await sleep(2000);
    }
  }

  async function startMetro(
    ctx: CollectorContext,
    state: RunState,
    app: AndroidAppConfig,
    notes: string[],
  ): Promise<string> {
    const metro = app.metro;
    if (!metro) throw new Error("debug-metro 模式需要配置 app.metro");
    const base = `http://localhost:${metro.port}`;
    const adb = state.adb as Adb;
    const timeout = metro.warmupTimeoutMs ?? 300_000;
    const statusUp = () => httpProbe(`${base}/status`, 3000);
    if (await statusUp()) {
      notes.push(`Metro 已在端口 ${metro.port} 运行，本次复用，结束时保留。`);
    } else {
      if (!options.spawner) throw new Error("debug-metro 模式需要 ProcessSpawner 来启动 Metro");
      const cwd = metro.cwd ? inWorktree(ctx, metro.cwd) : ctx.worktreePath;
      ctx.log(`starting Metro on port ${metro.port}`);
      state.metro = options.spawner.spawn(metro.command, metro.args, { cwd, env: metro.env });
      const deadline = Date.now() + timeout;
      while (!(await statusUp())) {
        if (Date.now() > deadline) throw new Error("Metro 启动超时");
        await sleep(2000);
      }
    }
    await adb.reverse(metro.port);
    // First full bundle takes ~145 s cold (SPIKE-ANDROID); the app would time out without warm-up.
    const started = Date.now();
    const bundleUrl = `${base}/index.bundle?platform=android&dev=true&minify=false`;
    if (!(await httpProbe(bundleUrl, timeout))) throw new Error("Metro bundle 预热失败");
    notes.push(`Metro bundle 预热耗时 ${Math.round((Date.now() - started) / 1000)} 秒。`);
    return base;
  }

  async function waitForApp(adb: Adb, pkg: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if ((await adb.pids(pkg)).length > 0) return true;
      if (Date.now() >= deadline) return false;
      await sleep(1000);
    }
  }

  async function collect(ctx: CollectorContext): Promise<CollectResult> {
    const app = resolveApp(ctx);
    const flow = resolveFlow(ctx);
    const notes: string[] = [];
    const artifacts: EvidenceArtifact[] = [];
    const failures: string[] = [];
    let degraded = false;
    const state: RunState = {};
    states.set(ctx.verificationId, state);
    mkdirSync(ctx.outputDir, { recursive: true });

    const prefix = ctx.check ? slug(ctx.check.id) : "task";
    const addArtifact = (
      kind: EvidenceKind,
      file: string,
      label: string,
      mimeType: string,
    ): EvidenceArtifact => {
      const artifact: EvidenceArtifact = {
        kind,
        path: file,
        mimeType,
        label,
        capturedAt: ctx.now().toISOString(),
        commitHash: ctx.commitHash,
        simulated: true,
        ...(existsSync(file)
          ? { sha256: createHash("sha256").update(readFileSync(file)).digest("hex") }
          : {}),
      };
      artifacts.push(artifact);
      return artifact;
    };

    // 1. device
    let serial = ctx.deviceId;
    let avd: string | undefined;
    if (!serial) {
      if (!options.leases) throw new Error("未指定 ctx.deviceId，也未配置 DeviceLeaseProvider");
      const lease = await options.leases.acquire({
        platform: "android",
        verificationId: ctx.verificationId,
        ttlMs: options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
        signal: ctx.signal,
      });
      state.lease = lease;
      serial = lease.serial ?? lease.deviceId;
      avd = lease.avd;
    }
    const adb = new Adb(ctx.runner, serial, adbPath, ctx.signal);
    state.adb = adb;
    await ensureOnline(ctx, state, serial, avd, notes);
    notes.push(`设备：${serial}（模拟器，证据标记为模拟）。`);

    // 2. tools
    const useMaestro =
      Boolean(flow?.maestroFile) && (await toolPresent(ctx, maestroPath, ["--version"]));
    if (flow?.maestroFile && !useMaestro) {
      degraded = true;
      notes.push(
        flow.steps?.length
          ? "PATH 中未找到 Maestro，已降级为 adb 步骤。"
          : "PATH 中未找到 Maestro，且流程没有 adb 步骤，本次仅启动并截图。",
      );
    }
    const haveFfmpeg = record && (await toolPresent(ctx, ffmpegPath, ["-version"]));
    if (record && !haveFfmpeg) {
      degraded = true;
      notes.push("未找到 ffmpeg：录屏保留为 mp4，不生成 GIF，仍采集逐步截图。");
    }

    // 3. install / metro
    if (app.apkPath) {
      const apk = inWorktree(ctx, app.apkPath);
      if (!fileExists(apk)) throw new Error(`未找到 APK： ${apk}`);
      await adb.install(apk);
      notes.push(`已安装 ${path.basename(apk)}（${app.mode}）。`);
    } else if (
      !(await adb.shell(`pm path ${app.packageName}`, 15_000)).stdout.includes("package:")
    ) {
      throw new Error(`未安装 ${app.packageName}，且未提供 apkPath`);
    }
    let metroUrl = "";
    if (app.mode === "debug-metro") metroUrl = await startMetro(ctx, state, app, notes);
    else notes.push("Bundled 模式：APK 应已内置 JS bundle。");

    // 4. launch with recording
    await adb.forceStop(app.packageName);
    await adb.clearLogcat();
    if (record) {
      const remote = `/sdcard/vibe-rec-${Date.now()}.mp4`;
      state.remoteRecording = remote;
      state.recording = adb.startRecording(remote, MAX_RECORD_SEC).catch((e) => {
        notes.push(`screenrecord 失败： ${String(e)}`);
      });
      await sleep(500);
    }

    let seq = 0;
    const shot = async (label: string) => {
      const file = path.join(
        ctx.outputDir,
        `${prefix}-${String(++seq).padStart(2, "0")}-${slug(label)}.png`,
      );
      try {
        await adb.screenshot(file);
        addArtifact(
          "screenshot",
          file,
          ctx.check ? `${ctx.check.text} - ${label}` : label,
          "image/png",
        );
      } catch (e) {
        failures.push(`截图“${label}”失败： ${String(e)}`);
      }
    };
    const launch = async () => {
      if (app.launchUri) {
        await adb.openUri(app.launchUri.replaceAll("{metroUrl}", encodeURIComponent(metroUrl)));
      } else {
        await adb.launchApp(app.packageName, app.activity);
      }
    };

    let launched = false;
    try {
      await launch();
      launched = await waitForApp(adb, app.packageName, app.launchTimeoutMs ?? 30_000);
      if (!launched) failures.push(`${app.packageName} 启动超时`);
    } catch (e) {
      failures.push(`启动失败： ${String(e)}`);
    }
    await sleep(app.settleMs ?? 1500);
    await shot("launch");

    // 5. flow
    if (launched) {
      try {
        if (useMaestro && flow?.maestroFile) {
          const file = inWorktree(ctx, flow.maestroFile);
          const r = await ctx.runner.run(maestroPath, ["--device", serial, "test", file], {
            cwd: ctx.worktreePath,
            timeoutMs: 300_000,
            signal: ctx.signal,
          });
          const logFile = path.join(ctx.outputDir, `${prefix}-maestro.log`);
          writeFileSync(logFile, `${r.stdout}\n${r.stderr}`);
          addArtifact("log", logFile, "Maestro output", "text/plain");
          if (r.exitCode !== 0) failures.push(`Maestro 流程失败（退出码 ${r.exitCode}）`);
        } else if (flow?.steps) {
          for (const step of flow.steps) await runStep(step);
        }
      } catch (e) {
        failures.push(`流程失败： ${String(e)}`);
      }
      await sleep(app.settleMs ?? 1500);
      await shot(failures.length ? "failure" : "final");
    }

    async function runStep(step: AdbStep) {
      switch (step.type) {
        case "launch":
          return launch();
        case "deeplink":
          return void (await adb.openUri(step.uri));
        case "tap":
          return void (await adb.tap(step.x, step.y));
        case "swipe":
          return void (await adb.swipe(step.x1, step.y1, step.x2, step.y2, step.durationMs));
        case "text":
          return void (await adb.text(step.text));
        case "key":
          return void (await adb.key(step.key));
        case "wait":
          return sleep(step.ms);
        case "screenshot":
          return shot(step.label);
      }
    }

    // 6. recording -> GIF
    if (state.recording && state.remoteRecording) {
      await adb.stopRecording();
      await Promise.race([state.recording, sleep(10_000)]);
      await sleep(1000);
      const mp4 = path.join(ctx.outputDir, `${prefix}-flow.mp4`);
      try {
        await adb.pullAndRemove(state.remoteRecording, mp4);
        if (haveFfmpeg) {
          const gif = path.join(ctx.outputDir, `${prefix}-flow.gif`);
          const r = await ctx.runner.run(ffmpegPath, ffmpegGifArgs(mp4, gif), {
            timeoutMs: 120_000,
          });
          if (r.exitCode === 0) {
            addArtifact("gif", gif, ctx.check ? `${ctx.check.text} - flow` : "flow", "image/gif");
          } else {
            degraded = true;
            notes.push("ffmpeg 转换 GIF 失败，录屏保留为 mp4。");
          }
        }
        addArtifact("video", mp4, "screen recording", "video/mp4");
      } catch (e) {
        degraded = true;
        notes.push(`录屏不可用： ${String(e)}`);
      }
    }

    // 7. logcat crash check
    let judgement: Judgement | undefined;
    const logText = await adb.dumpLogcat();
    const logFile = path.join(ctx.outputDir, `${prefix}-logcat.txt`);
    writeFileSync(logFile, logText);
    addArtifact("log", logFile, "logcat", "text/plain");
    const analysis = analyzeLogcat(logText, app.packageName);
    const aliveAtEnd = launched ? (await adb.pids(app.packageName)).length > 0 : false;
    for (const c of analysis.crashes) failures.push(`${c.kind} 崩溃： ${c.line}`);
    if (launched && !aliveAtEnd && analysis.crashes.length === 0) {
      failures.push("运行结束时应用进程已退出（logcat 未发现崩溃）");
    }
    if (analysis.jsErrors > 0)
      notes.push(`logcat 中有 ${analysis.jsErrors} 条 ReactNativeJS 错误。`);
    if (failures.length === 0) notes.push("logcat 未发现崩溃或 ANR，结束时应用仍在运行。");
    else judgement = "fail";

    // 8. report
    const reportFile = path.join(ctx.outputDir, `${prefix}-report.json`);
    writeFileSync(
      reportFile,
      JSON.stringify(
        {
          device: serial,
          package: app.packageName,
          mode: app.mode,
          check: ctx.check ?? null,
          commitHash: ctx.commitHash,
          maestro: useMaestro,
          degraded,
          failures,
          crashes: analysis.crashes,
          jsErrors: analysis.jsErrors,
        },
        null,
        2,
      ),
    );
    addArtifact("report", reportFile, "android run report", "application/json");
    notes.push(...failures);
    return { artifacts, judgement, notes, degraded };
  }

  async function dispose(ctx: CollectorContext): Promise<void> {
    const state = states.get(ctx.verificationId);
    if (!state) return;
    states.delete(ctx.verificationId);
    // Only things this collector started are stopped; a pre-existing emulator/Metro is left alone.
    try {
      if (state.adb && state.remoteRecording) await state.adb.stopRecording();
    } catch {
      // best effort
    }
    state.metro?.kill();
    if (state.emulator) {
      // `emu kill` shuts down qemu itself; killing only the launcher can leave it running.
      try {
        await state.adb?.run(["emu", "kill"], 15_000);
      } catch {
        // fall through to killing the launcher
      }
      state.emulator.kill();
    }
    await state.lease?.release();
  }

  return { id: "android", projectTypes: ["android"], detect, collect, dispose };
}
