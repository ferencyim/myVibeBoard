// iOS simulator evidence collector (WP-46), driven over SSH on a remote Mac.
//
// Flow: [sync .app | build on the Mac] -> simctl boot/install -> start recordVideo -> launch ->
// steps (screenshot per step, pulled back with scp) -> stop recording -> crash reports -> GIF
// (built locally from the step screenshots, no ffmpeg) -> evidence bundle.
// Without a reachable Mac with Xcode, detect() says "unavailable" with the reason. Real-Mac runs
// are gated by VIBE_E2E_IOS=1 (see test/ios/e2e.test.ts); nothing here ever hard-codes a host.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type {
  CollectResult,
  CollectorAvailability,
  CollectorContext,
  EvidenceArtifact,
  EvidenceCollector,
  Judgement,
} from "../../vibe/contract";
import type { EvidenceKind } from "../../vibe/contract";
import { loadVerifyConfig, writeArtifact } from "../common";
import { encodeGif } from "../web/images";
import type { IosAppConfig, IosConfig, IosStep } from "./config";
import { RemoteMacExecutor, assertValidRemotePath, shQuote } from "./remote-mac";

export interface IosCollectorOptions {
  /** ssh alias of the Mac. Default: VIBE_MAC_HOST env, then `ios.host` of verify.json. */
  host?: string;
  /** Default: `ios` section of `<worktree>/.vibe/verify.json`. */
  config?: IosConfig | ((ctx: CollectorContext) => IosConfig);
  sshPath?: string;
  scpPath?: string;
  /** Scratch directory on the Mac (default /tmp/vibe-verify). */
  remoteRoot?: string;
  record?: boolean;
  sleep?: (ms: number) => Promise<void>;
}

interface RunState {
  exec: RemoteMacExecutor;
  device: string;
  bundleId?: string;
  bootedByUs?: boolean;
  recordPid?: string;
}

const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "shot";
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const simctl = (...args: string[]) => ["xcrun", "simctl", ...args];

export function createIosCollector(options: IosCollectorOptions = {}): EvidenceCollector {
  const sleep = options.sleep ?? sleepReal;
  const record = options.record ?? true;
  const remoteRoot = options.remoteRoot ?? "/tmp/vibe-verify";
  const states = new Map<string, RunState>();

  const resolveConfig = (ctx: CollectorContext): IosConfig => {
    if (typeof options.config === "function") return options.config(ctx);
    if (options.config) return options.config;
    const configured = loadVerifyConfig(ctx.worktreePath).ios;
    if (!configured) throw new Error("No ios section in .vibe/verify.json and no config option");
    return configured;
  };
  const resolveHost = (ctx: CollectorContext): string | undefined => {
    let fromConfig: string | undefined;
    try {
      fromConfig =
        typeof options.config === "object"
          ? options.config.host
          : loadVerifyConfig(ctx.worktreePath).ios?.host;
    } catch {
      // an invalid verify.json is reported by collect()
    }
    return options.host ?? process.env.VIBE_MAC_HOST ?? fromConfig;
  };
  const newExec = (ctx: CollectorContext, host: string) =>
    new RemoteMacExecutor(ctx.runner, host, {
      sshPath: options.sshPath,
      scpPath: options.scpPath,
      signal: ctx.signal,
    });

  async function detect(ctx: CollectorContext): Promise<CollectorAvailability> {
    const host = resolveHost(ctx);
    if (!host) {
      return { available: false, reason: "no Mac host configured (set the iOS Mac host, <MAC_HOST>)" };
    }
    let exec: RemoteMacExecutor;
    try {
      exec = newExec(ctx, host);
    } catch (e) {
      return { available: false, reason: msg(e) };
    }
    // Spec probe: `uname && xcodebuild -version`, plus simctl presence.
    const r = await exec.shell("uname && xcodebuild -version && xcrun --find simctl", {
      timeoutMs: 30_000,
    });
    if (r.timedOut) return { available: false, reason: `ssh to ${host} timed out` };
    const out = r.stdout;
    if (r.exitCode === 0) {
      return out.startsWith("Darwin")
        ? { available: true }
        : { available: false, reason: "remote host is not macOS" };
    }
    const detail = (r.stderr || out).trim().split("\n")[0] ?? "";
    if (!out.trim()) {
      return { available: false, reason: `ssh to the Mac failed${detail ? `: ${detail}` : ""}` };
    }
    if (!out.startsWith("Darwin")) {
      return { available: false, reason: "remote host is not macOS" };
    }
    if (!/Xcode/.test(out)) {
      return { available: false, reason: "Xcode is not installed on the Mac (xcodebuild -version failed)" };
    }
    return { available: false, reason: "xcrun simctl not found on the Mac (Xcode command line tools?)" };
  }

  async function collect(ctx: CollectorContext): Promise<CollectResult> {
    const config = resolveConfig(ctx);
    const app: IosAppConfig = config.app;
    const host = resolveHost(ctx);
    if (!host) throw new Error("No Mac host configured for the iOS collector");
    const device = ctx.deviceId ?? config.device;
    if (!device) throw new Error("No simulator: set ios.device or ctx.deviceId");
    if (!/^[A-Za-z0-9 ._()-]+$/.test(device)) throw new Error(`Invalid simulator name/UDID: ${device}`);
    const exec = newExec(ctx, host);
    const state: RunState = { exec, device, bundleId: app.bundleId };
    states.set(ctx.verificationId, state);

    const notes: string[] = [];
    const artifacts: EvidenceArtifact[] = [];
    const failures: string[] = [];
    let degraded = false;
    mkdirSync(ctx.outputDir, { recursive: true });
    const prefix = ctx.check ? slug(ctx.check.id) : "card";
    const workDir = `${remoteRoot}/${slug(ctx.verificationId)}-${Date.now()}`;
    assertValidRemotePath(workDir);

    /** Stamps a file already in outputDir as evidence (simulator => simulated). */
    const add = (kind: EvidenceKind, file: string, label: string): EvidenceArtifact => {
      const a = { ...writeArtifact(ctx, kind, path.basename(file), readFileSync(file), label), simulated: true };
      artifacts.push(a);
      return a;
    };
    const must = async (what: string, p: ReturnType<RemoteMacExecutor["shell"]>) => {
      const r = await p;
      if (r.exitCode !== 0) {
        const why = (r.stderr || r.stdout).trim().slice(0, 500);
        throw new Error(`${what} failed (exit ${r.exitCode}${r.timedOut ? ", timed out" : ""}): ${why}`);
      }
      return r;
    };

    // 1. work dir + crash-log marker
    await must("mkdir", exec.exec(["mkdir", "-p", workDir]));
    await must("marker", exec.exec(["touch", `${workDir}/marker`]));

    // 2. app product: build on the Mac or sync the local build
    let remoteApp: string | undefined;
    if (app.build) {
      const b = app.build;
      ctx.log(`building on ${host}: ${b.command}`);
      await must(
        "remote build",
        exec.shell(`cd ${shQuote(b.cwd)} && ${[b.command, ...b.args].map(shQuote).join(" ")}`, {
          timeoutMs: b.timeoutMs,
        }),
      );
      if (app.appPath) {
        remoteApp = app.appPath.startsWith("/") ? app.appPath : `${b.cwd}/${app.appPath}`;
        notes.push("Built on the Mac.");
      }
    } else if (app.appPath) {
      const local = path.isAbsolute(app.appPath) ? app.appPath : path.join(ctx.worktreePath, app.appPath);
      if (!existsSync(local)) throw new Error(`.app not found: ${local}`);
      remoteApp = `${workDir}/${path.basename(local)}`;
      await must("scp .app", exec.put(local, remoteApp, { recursive: true }));
      notes.push(`Synced ${path.basename(local)} to the Mac.`);
    }

    // 3. simulator boot + install
    const booted = await exec.exec(simctl("list", "devices", "booted"), { timeoutMs: 30_000 });
    const alreadyBooted = booted.stdout.includes(device) && booted.stdout.includes("(Booted)");
    if (!alreadyBooted) {
      const r = await exec.exec(simctl("boot", device), { timeoutMs: 120_000 });
      // "current state: Booted": it was running already.
      if (r.exitCode !== 0 && !/current state: Booted/i.test(r.stderr)) {
        throw new Error(`simctl boot failed: ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
      }
      if (r.exitCode === 0) state.bootedByUs = true;
    }
    await must("simctl bootstatus", exec.exec(simctl("bootstatus", device), { timeoutMs: 240_000 }));
    notes.push(
      `Simulator: ${device} (${alreadyBooted ? "already running" : "booted for this run"}; evidence marked simulated).`,
    );
    if (remoteApp) {
      await must("simctl install", exec.exec(simctl("install", device, remoteApp), { timeoutMs: 180_000 }));
    }

    // 4. recording
    if (record) {
      const rec = simctl("io", device, "recordVideo", "--codec=h264", "--force", `${workDir}/flow.mp4`);
      const r = await exec.shell(
        `nohup ${rec.map(shQuote).join(" ")} </dev/null >${shQuote(`${workDir}/record.log`)} 2>&1 & echo $!`,
        { timeoutMs: 20_000 },
      );
      const pid = r.stdout.trim().split("\n").pop() ?? "";
      if (r.exitCode === 0 && /^\d+$/.test(pid)) {
        state.recordPid = pid;
        await sleep(500);
      } else {
        degraded = true;
        notes.push("Could not start simctl recordVideo: no video, GIF built from screenshots only.");
      }
    }

    // 5. launch + steps
    const frames: Buffer[] = [];
    let seq = 0;
    const shot = async (label: string) => {
      const name = `${prefix}-${String(++seq).padStart(2, "0")}-${slug(label)}.png`;
      const remote = `${workDir}/${name}`;
      const local = path.join(ctx.outputDir, name);
      try {
        await must(
          "screenshot",
          exec.exec(simctl("io", device, "screenshot", "--type=png", remote), { timeoutMs: 60_000 }),
        );
        await must("scp screenshot", exec.get(remote, local));
        add("screenshot", local, ctx.check ? `${ctx.check.text} - ${label}` : label);
        frames.push(readFileSync(local));
      } catch (e) {
        failures.push(`screenshot "${label}" failed: ${msg(e)}`);
      }
    };
    let launched = false;
    const launch = async () => {
      const r = await exec.exec(
        simctl(
          "launch",
          `--stdout=${workDir}/app-stdout.log`,
          `--stderr=${workDir}/app-stderr.log`,
          device,
          app.bundleId,
          ...app.launchArgs,
        ),
        { timeoutMs: 60_000 },
      );
      if (r.exitCode !== 0) {
        failures.push(`launch failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
        return;
      }
      launched = true;
      const pid = /:\s*(\d+)/.exec(r.stdout)?.[1];
      notes.push(`Launched ${app.bundleId}${pid ? ` (pid ${pid})` : ""}.`);
    };
    const runStep = async (step: IosStep) => {
      switch (step.type) {
        case "launch":
          return launch();
        case "openurl":
          return void (await must("openurl", exec.exec(simctl("openurl", device, step.url))));
        case "terminate":
          return void (await exec.exec(simctl("terminate", device, app.bundleId)));
        case "wait":
          return sleep(step.ms);
        case "screenshot":
          return shot(step.label);
      }
    };

    await launch();
    await sleep(app.settleMs ?? 1500);
    await shot("launch");
    if (launched) {
      try {
        for (const step of config.steps ?? []) await runStep(step);
      } catch (e) {
        failures.push(`flow failed: ${msg(e)}`);
      }
      await sleep(app.settleMs ?? 1500);
      await shot(failures.length ? "failure" : "final");
    }

    // 6. stop recording (simctl only finalizes the mp4 on SIGINT), pull video + app logs
    if (state.recordPid) {
      const pid = state.recordPid;
      await exec.shell(
        `kill -INT ${pid} 2>/dev/null; for i in $(seq 1 20); do kill -0 ${pid} 2>/dev/null || break; sleep 0.5; done`,
        { timeoutMs: 30_000 },
      );
      state.recordPid = undefined;
      const mp4 = path.join(ctx.outputDir, `${prefix}-flow.mp4`);
      const r = await exec.get(`${workDir}/flow.mp4`, mp4);
      if (r.exitCode === 0 && existsSync(mp4)) add("video", mp4, "simulator recording");
      else {
        degraded = true;
        notes.push("Recording could not be pulled from the Mac.");
      }
    }
    for (const [remoteName, label] of [
      ["app-stdout.log", "app stdout"],
      ["app-stderr.log", "app stderr"],
    ] as const) {
      const local = path.join(ctx.outputDir, `${prefix}-${remoteName}`);
      const r = await exec.get(`${workDir}/${remoteName}`, local);
      if (r.exitCode === 0 && existsSync(local)) add("log", local, label);
    }

    // 7. crash reports newer than the marker that mention the bundle id
    const found = await exec.shell(
      `find "$HOME/Library/Logs/DiagnosticReports" \\( -name '*.ips' -o -name '*.crash' \\) -newer ${shQuote(`${workDir}/marker`)} -exec grep -l -F -e ${shQuote(app.bundleId)} {} + 2>/dev/null; true`,
      { timeoutMs: 30_000 },
    );
    const crashFiles = found.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("/"));
    let crashIdx = 0;
    for (const remote of crashFiles) {
      const local = path.join(ctx.outputDir, `${prefix}-crash-${++crashIdx}${path.extname(remote) || ".ips"}`);
      try {
        await must("scp crash log", exec.get(remote, local));
        add("log", local, `crash report ${path.basename(remote)}`);
      } catch (e) {
        notes.push(`Crash report ${path.basename(remote)} could not be pulled: ${msg(e)}`);
      }
      failures.push(`crash report on the Mac: ${path.basename(remote)}`);
    }

    // 8. GIF from the step screenshots
    if (frames.length > 1) {
      try {
        const label = ctx.check ? `${ctx.check.text} - flow` : "flow";
        artifacts.push({ ...writeArtifact(ctx, "gif", `${prefix}-flow.gif`, encodeGif(frames), label), simulated: true });
      } catch (e) {
        degraded = true;
        notes.push(`GIF could not be built: ${msg(e)}`);
      }
    }

    let judgement: Judgement | undefined;
    if (failures.length === 0) notes.push("No crash report found for the app during the run.");
    else judgement = "fail";

    // 9. report
    const report = {
      device,
      bundleId: app.bundleId,
      check: ctx.check ?? null,
      commitHash: ctx.commitHash,
      launched,
      degraded,
      failures,
      crashReports: crashFiles.length,
    };
    artifacts.push({
      ...writeArtifact(ctx, "report", `${prefix}-report.json`, JSON.stringify(report, null, 2), "ios run report"),
      simulated: true,
    });
    notes.push(...failures);
    return { artifacts, judgement, notes, degraded };
  }

  async function dispose(ctx: CollectorContext): Promise<void> {
    const state = states.get(ctx.verificationId);
    if (!state) return;
    states.delete(ctx.verificationId);
    const { exec, device } = state;
    // Only what this run started: the recorder, the app, and the simulator if we booted it.
    try {
      if (state.recordPid) await exec.shell(`kill -INT ${state.recordPid} 2>/dev/null; true`, { timeoutMs: 15_000 });
      if (state.bundleId) await exec.exec(simctl("terminate", device, state.bundleId), { timeoutMs: 15_000 });
      if (state.bootedByUs) await exec.exec(simctl("shutdown", device), { timeoutMs: 60_000 });
    } catch {
      // best effort
    }
  }

  return { id: "ios", projectTypes: ["ios"], detect, collect, dispose };
}
