import type { ChildProcess, SpawnOptions } from "node:child_process";
import { extname } from "node:path";
import {
  cancelGitWorkerStartup,
  execInWorker,
  prepareGitWorker,
  WorkerDispatchError,
} from "./run-git-command-worker.js";
import { spawnProcess as spawnCli, execCommand as execCli } from "@getpaseo/plugin/server";
import { createExternalCommandProcessEnv, type ProcessEnvRecord } from "../server/paseo-env.js";

interface ExternalEnvOptions {
  baseEnv?: ProcessEnvRecord;
  envMode?: "external" | "internal";
  env?: ProcessEnvRecord;
  envOverlay?: ProcessEnvRecord;
}

export type SpawnProcessOptions = Omit<SpawnOptions, "env"> & ExternalEnvOptions;

interface ExecCommandOptions extends ExternalEnvOptions {
  cwd?: string;
  encoding?: BufferEncoding;
  killSignal?: NodeJS.Signals;
  timeout?: number;
  maxBuffer?: number;
  shell?: boolean | string;
  signal?: AbortSignal;
}

interface ExecCommandResult {
  stdout: string;
  stderr: string;
}

export function spawnProcess(
  command: string,
  args: string[],
  options?: SpawnProcessOptions,
): ChildProcess {
  const { baseEnv, env, envOverlay, ...spawnOptions } = options ?? {};
  const resolvedBaseEnv = env ?? baseEnv ?? process.env;
  const childEnv =
    options?.envMode === "internal"
      ? ({ ...resolvedBaseEnv, ...envOverlay } as NodeJS.ProcessEnv)
      : createExternalCommandProcessEnv(
          command,
          resolvedBaseEnv,
          ...(envOverlay ? [envOverlay] : []),
        );

  return spawnCli(command, args, {
    ...spawnOptions,
    env: childEnv,
    signal: options?.signal,
  });
}

// Keep shell quoting aligned with @getpaseo/plugin/server's Windows launcher.
function quoteWindowsValue(value: string): string {
  const quoted = value.startsWith('"') && value.endsWith('"');
  const raw = quoted ? value.slice(1, -1) : value;
  const escaped = raw.replace(/([&|^<>()!])/g, "^$1");
  if (!quoted && !/[\s"]/u.test(raw)) return escaped;
  return `"${escaped.replace(/(\\*)"/g, (_match, slashes: string) => `${slashes}${slashes}\\"`).replace(/\\+$/u, (slashes) => `${slashes}${slashes}`)}"`;
}

export async function execCommand(
  command: string,
  args: string[],
  options?: ExecCommandOptions,
): Promise<ExecCommandResult> {
  const { baseEnv, env, envOverlay } = options ?? {};
  const resolvedBaseEnv = env ?? baseEnv ?? process.env;
  const childEnv =
    options?.envMode === "internal"
      ? ({ ...resolvedBaseEnv, ...envOverlay } as NodeJS.ProcessEnv)
      : createExternalCommandProcessEnv(
          command,
          resolvedBaseEnv,
          ...(envOverlay ? [envOverlay] : []),
        );

  const startedAt = Date.now();
  const workerResult = await tryExecInWorker(command, args, childEnv, options, startedAt);
  if (workerResult) {
    try {
      return await workerResult.result;
    } catch (error) {
      if (!(error instanceof WorkerDispatchError)) throw error;
    }
  }

  return execCli(command, args, {
    cwd: options?.cwd,
    env: childEnv,
    shell: options?.shell,
    encoding: options?.encoding ?? "utf8",
    signal: options?.signal,
    killSignal: options?.killSignal,
    timeout: remainingTimeout(options?.timeout, startedAt),
    maxBuffer: options?.maxBuffer,
  }) as Promise<ExecCommandResult>;
}

function remainingTimeout(timeout: number | undefined, startedAt: number): number | undefined {
  if (!timeout || timeout < 0) return timeout;
  const remaining = timeout - (Date.now() - startedAt);
  if (remaining <= 0)
    throw Object.assign(new Error("Command timed out"), {
      killed: true,
      code: null,
      signal: "SIGTERM",
      stdout: "",
      stderr: "",
    });
  return remaining;
}

async function waitForWorker(
  options: ExecCommandOptions | undefined,
  startedAt: number,
): Promise<boolean> {
  const signal = options?.signal;
  if (signal?.aborted)
    throw Object.assign(new Error("The operation was aborted"), {
      name: "AbortError",
      code: "ABORT_ERR",
      cause: signal.reason,
    });
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    const startupLimit = new Promise<false>((resolve) => {
      startupTimer = setTimeout(() => {
        cancelGitWorkerStartup();
        resolve(false);
      }, 5000);
    });
    const cancellation = new Promise<never>((_resolve, reject) => {
      abort = () =>
        reject(
          Object.assign(new Error("The operation was aborted"), {
            name: "AbortError",
            code: "ABORT_ERR",
            cause: signal?.reason,
          }),
        );
      signal?.addEventListener("abort", abort, { once: true });
      const remaining = remainingTimeout(options?.timeout, startedAt);
      if (remaining && remaining > 0)
        timeoutTimer = setTimeout(
          () =>
            reject(
              Object.assign(new Error("Command timed out"), {
                killed: true,
                code: null,
                signal: options?.killSignal ?? "SIGTERM",
                stdout: "",
                stderr: "",
              }),
            ),
          remaining,
        );
      if (signal?.aborted) abort();
    });
    return await Promise.race([prepareGitWorker(), startupLimit, cancellation]);
  } finally {
    clearTimeout(startupTimer);
    clearTimeout(timeoutTimer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}

async function tryExecInWorker(
  command: string,
  args: string[],
  childEnv: NodeJS.ProcessEnv,
  options: ExecCommandOptions | undefined,
  startedAt: number,
): Promise<{ result: Promise<ExecCommandResult> } | undefined> {
  if (process.platform !== "win32" || !(await waitForWorker(options, startedAt))) return undefined;
  const extension = extname(command).toLowerCase();
  const shell =
    extension === ".cmd" || extension === ".bat"
      ? true
      : (options?.shell ?? (!command.includes("/") && !command.includes("\\") && !extension));
  return {
    result: execInWorker(
      shell ? quoteWindowsValue(command) : command,
      shell ? args.map(quoteWindowsValue) : args,
      {
        cwd: options?.cwd,
        env: childEnv,
        shell,
        encoding: options?.encoding ?? "utf8",
        signal: options?.signal,
        killSignal: options?.killSignal,
        timeout: remainingTimeout(options?.timeout, startedAt),
        maxBuffer: options?.maxBuffer,
      },
    ),
  };
}
