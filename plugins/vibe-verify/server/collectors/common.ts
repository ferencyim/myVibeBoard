// Shared plumbing for the web/backend evidence collectors: artifact records, the project-level
// verify config, the real (child_process) Runner and an injectable dev-server launcher.
import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type {
  CollectorContext,
  EvidenceArtifact,
  RunOptions,
  RunResult,
  Runner,
} from "../vibe/contract/collector";
import type { EvidenceKind } from "../vibe/contract/enums";
import { AndroidConfigSchema } from "./android/config";
import { DesktopConfigSchema } from "./desktop/config";
import { IosConfigSchema } from "./ios/config";

// --- artifacts -------------------------------------------------------------------------------

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".gif": "image/gif",
  ".json": "application/json",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".mp4": "video/mp4",
  ".ips": "text/plain",
  ".crash": "text/plain",
};

/** Writes `data` into ctx.outputDir/name and returns the stamped evidence record. */
export function writeArtifact(
  ctx: CollectorContext,
  kind: EvidenceKind,
  name: string,
  data: Buffer | string,
  label?: string,
): EvidenceArtifact {
  mkdirSync(ctx.outputDir, { recursive: true });
  const file = path.join(ctx.outputDir, name);
  writeFileSync(file, data);
  return {
    kind,
    path: file,
    mimeType: MIME[path.extname(name)] ?? "application/octet-stream",
    sha256: createHash("sha256").update(data).digest("hex"),
    label,
    capturedAt: ctx.now().toISOString(),
    commitHash: ctx.commitHash,
    simulated: false,
  };
}

// --- verify config ---------------------------------------------------------------------------

const CommandSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).default([]),
  /** Relative to the worktree. */
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  /** URL polled until it answers (any HTTP status) before the server counts as started. */
  readyUrl: z.string().optional(),
  readyTimeoutMs: z.number().default(60_000),
});
export type ServerCommand = z.infer<typeof CommandSchema>;

export const WebStepSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("goto"), path: z.string() }),
  z.object({ action: z.literal("click"), selector: z.string() }),
  z.object({ action: z.literal("fill"), selector: z.string(), value: z.string() }),
  z.object({ action: z.literal("press"), key: z.string() }),
  z.object({ action: z.literal("wait"), ms: z.number().max(10_000) }),
]);
export type WebStep = z.infer<typeof WebStepSchema>;

export const RequestSampleSchema = z.object({
  name: z.string(),
  method: z.string().default("GET"),
  /** Absolute URL, or a path appended to backend.baseUrl. */
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.unknown().optional(),
  expectStatus: z.number().optional(),
  /** Only run for this check item; omitted = card-wide. */
  checkId: z.string().optional(),
});
export type RequestSample = z.infer<typeof RequestSampleSchema>;

export const VerifyConfigSchema = z.object({
  web: z
    .object({
      /** Already-running URL; otherwise `server` is started. */
      url: z.string().optional(),
      server: CommandSchema.optional(),
      /** Page path opened first, default "/". */
      entry: z.string().default("/"),
      steps: z.array(WebStepSchema).default([]),
      /** Worktree of the pre-change commit; enables before/after screenshots + comparison. */
      baseline: z
        .object({
          path: z.string(),
          commitHash: z.string().optional(),
          url: z.string().optional(),
          server: CommandSchema.optional(),
        })
        .optional(),
    })
    .optional(),
  backend: z
    .object({
      test: z.object({ command: z.string(), args: z.array(z.string()).default([]) }).optional(),
      server: CommandSchema.optional(),
      baseUrl: z.string().optional(),
      requests: z.array(RequestSampleSchema).default([]),
    })
    .optional(),
  android: AndroidConfigSchema.optional(),
  ios: IosConfigSchema.optional(),
  desktop: DesktopConfigSchema.optional(),
});
export type VerifyConfig = z.infer<typeof VerifyConfigSchema>;

/** Reads `<worktree>/.vibe/verify.json`; absent file = empty config. Invalid file throws. */
export function loadVerifyConfig(worktreePath: string): VerifyConfig {
  const file = path.join(worktreePath, ".vibe", "verify.json");
  if (!existsSync(file)) return {};
  return VerifyConfigSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

// --- real Runner -----------------------------------------------------------------------------

const SHELL_SHIMS = /^(npm|npx|pnpm|yarn|maestro)$/;

/** Runs a process to completion. On Windows, `.cmd` shims (npm, npx) are run through a shell. */
export function createNodeRunner(): Runner {
  return {
    run(command, args, options: RunOptions = {}) {
      const started = Date.now();
      return new Promise<RunResult>((resolve) => {
        const child = spawn(command, [...args], {
          cwd: options.cwd,
          env: { ...process.env, ...options.env },
          shell: process.platform === "win32" && SHELL_SHIMS.test(command),
          windowsHide: true,
          signal: options.signal,
        });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const timer = options.timeoutMs
          ? setTimeout(() => {
              timedOut = true;
              killTree(child.pid);
            }, options.timeoutMs)
          : undefined;
        child.stdout?.on("data", (d) => (stdout += d));
        child.stderr?.on("data", (d) => (stderr += d));
        child.on("error", (e) => {
          clearTimeout(timer);
          resolve({
            exitCode: null,
            stdout,
            stderr: stderr + String(e),
            timedOut,
            durationMs: Date.now() - started,
          });
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({
            exitCode: timedOut ? null : code,
            stdout,
            stderr,
            timedOut,
            durationMs: Date.now() - started,
          });
        });
        child.stdin?.end(options.input);
      });
    },
  };
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => {});
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // already gone
  }
}

// --- dev-server launcher ---------------------------------------------------------------------

export interface RunningServer {
  stop(): Promise<void>;
}

export interface ServerLauncher {
  start(spec: ServerCommand, worktreePath: string): Promise<RunningServer>;
}

export async function waitForUrl(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(2_000) });
      return;
    } catch (e) {
      last = String(e);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`Server not ready at ${url} within ${timeoutMs}ms (${last})`);
}

export function createNodeServerLauncher(): ServerLauncher {
  return {
    async start(spec, worktreePath) {
      const child = spawn(spec.command, spec.args, {
        cwd: path.resolve(worktreePath, spec.cwd ?? "."),
        env: { ...process.env, ...spec.env },
        shell: process.platform === "win32" && SHELL_SHIMS.test(spec.command),
        windowsHide: true,
        stdio: "ignore",
      });
      const server: RunningServer = {
        async stop() {
          killTree(child.pid);
        },
      };
      let exited: number | null | undefined;
      child.on("exit", (code) => (exited = code));
      try {
        if (spec.readyUrl) {
          await waitForUrl(spec.readyUrl, spec.readyTimeoutMs);
          if (exited !== undefined) throw new Error(`Server exited early (code ${exited})`);
        }
      } catch (e) {
        await server.stop();
        throw e;
      }
      return server;
    },
  };
}

/** Keeps track of servers a collector started so `dispose` can stop them. */
export class ServerRegistry {
  private byRun = new Map<string, RunningServer[]>();
  add(runId: string, server: RunningServer): void {
    this.byRun.set(runId, [...(this.byRun.get(runId) ?? []), server]);
  }
  async stopAll(runId: string): Promise<void> {
    const servers = this.byRun.get(runId) ?? [];
    this.byRun.delete(runId);
    await Promise.allSettled(servers.map((s) => s.stop()));
  }
}
