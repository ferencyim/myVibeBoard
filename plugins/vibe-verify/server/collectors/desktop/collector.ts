import type { CollectorContext } from "../context";
// Desktop application evidence collector (WP-46).
//
// Flow: launch the built app (or drive it via Playwright _electron) -> wait for its window ->
// window screenshots at launch / per step / end -> GIF of those frames -> stdout/stderr log ->
// report. Only the process this collector started is stopped (dispose). Window capture is a
// WindowCapturer (PowerShell on Windows), so unit tests use fakes; VIBE_E2E_DESKTOP=1 runs it for real.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  CollectResult,
  CollectorAvailability,
  EvidenceArtifact,
  EvidenceCollector,
  Judgement,
} from "../../vibe/contract";
import { loadVerifyConfig, writeArtifact } from "../common";
import { encodeGif } from "../web/images";
import type { DesktopAppConfig, DesktopConfig, DesktopStep } from "./config";
import {
  createPlaywrightElectronDriver,
  type ElectronDriver,
  type ElectronSession,
} from "./electron";
import { createNodeAppLauncher, type AppLauncher, type AppProcess } from "./launcher";
import { defaultWindowCapturer, type WindowCapturer } from "./window";

export interface DesktopCollectorOptions {
  /** Default: `desktop` section of `<worktree>/.vibe/verify.json`. */
  config?: DesktopConfig | ((ctx: CollectorContext) => DesktopConfig);
  launcher?: AppLauncher;
  capturer?: WindowCapturer;
  electron?: ElectronDriver;
  platform?: NodeJS.Platform;
  /** Test seams. */
  sleep?: (ms: number) => Promise<void>;
  fileExists?: (p: string) => boolean;
}

interface RunState {
  proc?: AppProcess;
  session?: ElectronSession;
}

const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "shot";
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const POLL_MS = 1000;

export function createDesktopCollector(options: DesktopCollectorOptions = {}): EvidenceCollector {
  const sleep = options.sleep ?? sleepReal;
  const fileExists = options.fileExists ?? existsSync;
  const launcher = options.launcher ?? createNodeAppLauncher();
  const capturer = options.capturer ?? defaultWindowCapturer(options.platform);
  const states = new Map<string, RunState>();

  const resolveConfig = (ctx: CollectorContext): DesktopConfig => {
    if (typeof options.config === "function") return options.config(ctx);
    if (options.config) return options.config;
    const configured = loadVerifyConfig(ctx.worktreePath).desktop;
    if (!configured)
      throw new Error("No desktop section in .vibe/verify.json and no config option");
    return configured;
  };
  // Relative executables with a path separator are worktree-relative; bare names go through PATH.
  const resolveCommand = (ctx: CollectorContext, app: DesktopAppConfig) =>
    path.isAbsolute(app.command) || !/[\\/]/.test(app.command)
      ? app.command
      : path.join(ctx.worktreePath, app.command);

  async function detect(ctx: CollectorContext): Promise<CollectorAvailability> {
    if (!capturer) {
      return {
        available: false,
        reason: `no window capturer for platform ${options.platform ?? process.platform}`,
      };
    }
    const probe = await capturer.probe(ctx.runner);
    if (!probe.ok) return { available: false, reason: probe.reason };
    return probe.degraded
      ? { available: true, degraded: true, reason: probe.degraded }
      : { available: true };
  }

  async function collect(ctx: CollectorContext): Promise<CollectResult> {
    const config = resolveConfig(ctx);
    const app = config.app;
    if (!capturer) throw new Error("No window capturer available on this platform");
    const command = resolveCommand(ctx, app);
    if (command !== app.command && !fileExists(command)) {
      throw new Error(`App executable not found: ${command}`);
    }
    const cwd = app.cwd ? path.join(ctx.worktreePath, app.cwd) : undefined;
    const notes: string[] = [];
    const artifacts: EvidenceArtifact[] = [];
    const failures: string[] = [];
    let degraded = false;
    const state: RunState = {};
    states.set(ctx.verificationId, state);
    mkdirSync(ctx.outputDir, { recursive: true });
    const prefix = ctx.check ? slug(ctx.check.id) : "card";

    // 1. start (Electron automation first when asked, else a plain process)
    if (app.automation === "electron") {
      try {
        state.session = await (options.electron ?? createPlaywrightElectronDriver()).launch({
          executablePath: command,
          args: app.args,
          cwd,
          env: app.env,
          timeoutMs: app.windowTimeoutMs,
        });
        notes.push("Driven through Playwright _electron.");
      } catch (e) {
        degraded = true;
        notes.push(
          `Electron automation unavailable (${msg(e)}): plain launch, click/fill/press steps skipped.`,
        );
      }
    }
    if (!state.session) {
      state.proc = launcher.start(command, app.args, { cwd, env: app.env });
      if (state.proc.pid === undefined) failures.push(`could not start ${command}`);
      else ctx.log(`started ${path.basename(command)} (pid ${state.proc.pid})`);
    }

    // 2. screenshots
    const frames: Buffer[] = [];
    let seq = 0;
    const grabTo = async (
      file: string,
    ): Promise<{ ok: true } | { ok: false; reason: string; windowMissing?: boolean }> => {
      if (state.session) {
        try {
          writeFileSync(file, await state.session.screenshot());
          return { ok: true };
        } catch (e) {
          return { ok: false, reason: msg(e), windowMissing: true };
        }
      }
      return capturer.capture(ctx.runner, { pid: state.proc?.pid, title: app.windowTitle }, file);
    };
    const record = (file: string, label: string) => {
      const data = readFileSync(file);
      frames.push(data);
      artifacts.push(
        writeArtifact(
          ctx,
          "screenshot",
          path.basename(file),
          data,
          ctx.check ? `${ctx.check.text} - ${label}` : label,
        ),
      );
    };
    const shotFile = (label: string) =>
      path.join(ctx.outputDir, `${prefix}-${String(++seq).padStart(2, "0")}-${slug(label)}.png`);

    // 3. wait for the window (each poll is a capture attempt into the "launch" shot)
    const launchFile = shotFile("launch");
    const deadline = Date.now() + app.windowTimeoutMs;
    let windowUp = false;
    let lastReason = "";
    while (state.proc?.pid !== undefined || state.session) {
      const r = await grabTo(launchFile);
      if (r.ok) {
        windowUp = true;
        break;
      }
      lastReason = r.reason;
      if (!r.windowMissing) break; // capture itself is broken; waiting will not help
      const exit = state.proc?.exitCode();
      if (exit !== undefined && !app.windowTitle) {
        failures.push(`app exited (code ${exit}) before a window appeared`);
        break;
      }
      if (Date.now() >= deadline) break;
      await sleep(POLL_MS);
    }
    if (windowUp) {
      await sleep(app.settleMs ?? 1500);
      await grabTo(launchFile); // settled version replaces the first hit
      record(launchFile, "launch");
    } else if (failures.length === 0) {
      failures.push(`no window appeared within ${app.windowTimeoutMs} ms (${lastReason})`);
    }

    // 4. steps
    const shot = async (label: string) => {
      const file = shotFile(label);
      const r = await grabTo(file);
      if (r.ok) record(file, label);
      else failures.push(`screenshot "${label}" failed: ${r.reason}`);
    };
    const runStep = async (step: DesktopStep) => {
      if (step.type === "wait") return sleep(step.ms);
      if (step.type === "screenshot") return shot(step.label);
      if (state.session) return state.session.step(step);
      degraded = true;
      notes.push(`Step "${step.type}" skipped: needs automation "electron".`);
    };
    if (windowUp) {
      try {
        for (const step of config.steps ?? []) await runStep(step);
      } catch (e) {
        failures.push(`flow failed: ${msg(e)}`);
      }
      await sleep(app.settleMs ?? 1500);
      await shot(failures.length ? "failure" : "final");
      const exit = state.proc?.exitCode();
      if (exit !== undefined && exit !== 0 && exit !== null)
        failures.push(`app exited with code ${exit} during the run`);
    }

    // 5. GIF + logs
    if (frames.length > 1) {
      try {
        const label = ctx.check ? `${ctx.check.text} - flow` : "flow";
        artifacts.push(writeArtifact(ctx, "gif", `${prefix}-flow.gif`, encodeGif(frames), label));
      } catch (e) {
        degraded = true;
        notes.push(`GIF could not be built: ${msg(e)}`);
      }
    }
    const out = state.session?.output() ?? state.proc?.output() ?? { stdout: "", stderr: "" };
    artifacts.push(
      writeArtifact(
        ctx,
        "log",
        `${prefix}-app.log`,
        `--- stdout ---\n${out.stdout}\n--- stderr ---\n${out.stderr}\n`,
        "app stdout/stderr",
      ),
    );

    let judgement: Judgement | undefined;
    if (failures.length === 0)
      notes.push("Window appeared and the app stayed up for the whole run.");
    else judgement = "fail";
    const report = {
      command: path.basename(command),
      check: ctx.check ?? null,
      commitHash: ctx.commitHash,
      automation: state.session ? "electron" : "none",
      windowUp,
      degraded,
      failures,
    };
    artifacts.push(
      writeArtifact(
        ctx,
        "report",
        `${prefix}-report.json`,
        JSON.stringify(report, null, 2),
        "desktop run report",
      ),
    );
    notes.push(...failures);
    return { artifacts, judgement, notes, degraded };
  }

  async function dispose(ctx: CollectorContext): Promise<void> {
    const state = states.get(ctx.verificationId);
    if (!state) return;
    states.delete(ctx.verificationId);
    // Only the process (tree) this collector started.
    await state.session?.close();
    await state.proc?.stop();
  }

  return { id: "desktop", projectTypes: ["desktop"], detect, collect, dispose };
}
