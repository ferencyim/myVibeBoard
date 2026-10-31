/* eslint-disable unicorn/require-post-message-target-origin -- Node Worker, not a browser Window. */
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { Worker } from "node:worker_threads";
import type { ChildProcess } from "node:child_process";
import { createExternalCommandProcessEnv, type ProcessEnvRecord } from "../server/paseo-env.js";

// A persistent worker moves Windows' synchronous CreateProcess cost off the daemon event loop.
// Keep this self-contained so it works in both the compiled daemon and source-mode tests.
const workerSource = `
const { parentPort } = require('node:worker_threads');
const { spawn } = require('node:child_process');
const children = new Map();
parentPort.postMessage({ type: 'ready' });
parentPort.on('message', (message) => {
  const { id } = message;
  if (message.type === 'start') {
    let child;
    try {
      child = spawn('git', message.args, { cwd: message.cwd, env: message.env, shell: false,
        windowsHide: true, stdio: [message.hasInput ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
      children.set(id, child);
      if (child.pid !== undefined) parentPort.postMessage({ id, type: 'spawn', pid: child.pid });
      child.stdout.on('data', data => parentPort.postMessage({ id, type: 'stdout', data }));
      child.stderr.on('data', data => parentPort.postMessage({ id, type: 'stderr', data }));
      child.on('error', error => parentPort.postMessage({ id, type: 'error', message: error.message, code: error.code }));
      if (child.stdin) child.stdin.on('error', error => { if (error.code !== 'EPIPE') parentPort.postMessage({ id, type: 'stdinError', message: error.message, code: error.code }); });
      child.on('exit', (code, signal) => parentPort.postMessage({ id, type: 'exit', code, signal }));
      child.on('close', (code, signal) => { children.delete(id); parentPort.postMessage({ id, type: 'close', code, signal }); });
    } catch (error) {
      parentPort.postMessage({ id, type: 'error', message: error.message, code: error.code });
      parentPort.postMessage({ id, type: 'close', code: null, signal: null });
    }
  } else {
    const child = children.get(id);
    if (!child) return;
    if (message.type === 'kill') child.kill(message.signal);
    if (message.type === 'input') child.stdin.end(message.data);
  }
});`;

interface WorkerMessage {
  id: number;
  type: "spawn" | "stdout" | "stderr" | "error" | "stdinError" | "exit" | "close";
  pid?: number;
  data?: Uint8Array;
  message?: string;
  code?: number | string | null;
  signal?: NodeJS.Signals | null;
}

let worker: Worker | undefined;
let workerReady: Promise<boolean> | undefined;
let workerDisabled = false;
let cancelStartup: (() => void) | undefined;
let nextId = 0;
const children = new Map<number, ChildProcess>();

export function prepareGitWorker(): Promise<boolean> {
  if (workerDisabled) return Promise.resolve(false);
  if (workerReady) return workerReady;
  let instance: Worker;
  try {
    instance = new Worker(workerSource, { eval: true });
  } catch (error) {
    disableWorker(error);
    return Promise.resolve(false);
  }
  worker = instance;
  let resolveReady!: (ready: boolean) => void;
  workerReady = new Promise<boolean>((resolve) => {
    resolveReady = resolve;
  });
  let ready = false;
  instance.on("message", (message: WorkerMessage) => {
    if (worker !== instance) return;
    if ((message.type as string) === "ready") {
      ready = true;
      cancelStartup = undefined;
      resolveReady(true);
      return;
    }
    const child = children.get(message.id);
    if (!child) return;
    if (message.type === "spawn") {
      Object.defineProperty(child, "pid", { value: message.pid, configurable: true });
      child.emit("spawn");
    } else if (message.type === "stdout" || message.type === "stderr") {
      child[message.type]?.emit("data", Buffer.from(message.data!));
    } else if (message.type === "error" || message.type === "stdinError") {
      const error = Object.assign(new Error(message.message), { code: message.code });
      (message.type === "error" ? child : child.stdin)?.emit("error", error);
    } else {
      child.emit(message.type, message.code, message.signal);
      if (message.type === "close") {
        children.delete(message.id);
        if (children.size === 0) instance.unref();
      }
    }
  });
  const fail = (error: Error) => {
    if (worker !== instance) return;
    worker = undefined;
    cancelStartup = undefined;
    disableWorker(error);
    if (!ready) resolveReady(false);
    for (const child of children.values()) {
      if (child.pid !== undefined) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          /* Already exited. */
        }
      }
      child.emit("error", error);
      child.emit("close", null, null);
    }
    children.clear();
  };
  instance.on("error", fail);
  instance.on("exit", (code) => fail(new Error(`Git worker exited (${code})`)));
  cancelStartup = () => {
    fail(new Error("Git worker startup timed out"));
    void instance.terminate().catch(() => {});
  };
  instance.unref();
  return workerReady;
}

export function cancelGitWorkerStartup(): void {
  cancelStartup?.();
}

function disableWorker(error: unknown): void {
  if (workerDisabled) return;
  workerDisabled = true;
  console.warn("Git worker unavailable; falling back to main-thread spawn", error);
}

export function spawnGitInWorker(
  args: string[],
  options: {
    cwd: string;
    envOverlay?: ProcessEnvRecord;
    hasInput: boolean;
  },
): ChildProcess {
  const instance = worker;
  if (!instance || workerDisabled) throw new Error("Git worker is unavailable");
  const id = ++nextId;
  const child = new EventEmitter() as ChildProcess;
  child.stdout = new EventEmitter() as ChildProcess["stdout"];
  child.stderr = new EventEmitter() as ChildProcess["stderr"];
  const inputChunks: Buffer[] = [];
  child.stdin = options.hasInput
    ? (new Writable({
        write(chunk: Buffer, _encoding, callback) {
          inputChunks.push(Buffer.from(chunk));
          callback();
        },
        final(callback) {
          instance.postMessage({ id, type: "input", data: Buffer.concat(inputChunks) });
          callback();
        },
      }) as ChildProcess["stdin"])
    : null;
  child.kill = (signal = "SIGTERM") => {
    instance.postMessage({ id, type: "kill", signal });
    return true;
  };
  const startMessage = {
    id,
    type: "start",
    args,
    cwd: options.cwd,
    env: createExternalCommandProcessEnv(
      "git",
      process.env,
      ...(options.envOverlay ? [options.envOverlay] : []),
    ),
    hasInput: options.hasInput,
  };
  children.set(id, child);
  instance.ref();
  try {
    instance.postMessage(startMessage);
  } catch (error) {
    children.delete(id);
    if (children.size === 0) instance.unref();
    disableWorker(error);
    throw error;
  }
  return child;
}
