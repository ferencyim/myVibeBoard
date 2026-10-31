import { Worker } from "node:worker_threads";

export interface ProcessOptions {
  cwd?: string;
  timeoutMs?: number;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
}

export interface ProcessRunner {
  run(command: string, args: string[], options?: ProcessOptions): Promise<string>;
  cleanup(): Promise<void>;
}

// Inline source works in both the bundled plugin and source-mode tests. All process
// creation, including taskkill, stays off the plugin's event loop on Windows.
const workerSource = `
const { parentPort } = require('node:worker_threads');
const { spawn } = require('node:child_process');
const active = new Map();
parentPort.on('message', message => {
  if (message.type === 'cleanup') {
    for (const terminate of active.values()) terminate();
    return;
  }
  const { id, command, args, options } = message;
  let child;
  try {
    child = spawn(command, args, { cwd: options.cwd, env: options.env, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    parentPort.postMessage({ id, error: { message: error.message, code: error.code } });
    return;
  }
  const stdout = [], stderr = [];
  const maxBuffer = options.maxBuffer ?? 4 * 1024 * 1024;
  let stdoutBytes = 0, stderrBytes = 0, failure = null, killing = false, settled = false;
  let killFinished = Promise.resolve();
  const terminate = () => {
    if (killing) return;
    killing = true;
    clearTimeout(timer);
    if (!failure) failure = new Error('Process terminated');
    const pid = child.pid;
    if (!pid) return;
    if (process.platform === 'win32') {
      killFinished = new Promise(done => {
        let completed = false;
        let killer;
        try { killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); }
        catch { child.kill(); done(); return; }
        const finishKill = success => {
          if (completed) return;
          completed = true;
          clearTimeout(killTimer);
          if (!success) child.kill();
          done();
        };
        const killTimer = setTimeout(() => { killer.kill(); finishKill(false); }, 2000);
        killer.once('error', () => finishKill(false));
        killer.once('close', code => finishKill(code === 0));
      });
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }
  };
  active.set(id, terminate);
  const timer = setTimeout(() => {
    failure = new Error('Process timed out after ' + (options.timeoutMs ?? 5000) + ' ms');
    terminate();
  }, options.timeoutMs ?? 5000);
  child.stdout.on('data', chunk => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > maxBuffer) { failure = new Error('Process stdout exceeded maximum buffer'); terminate(); }
    else stdout.push(chunk);
  });
  child.stderr.on('data', chunk => {
    stderrBytes += chunk.length;
    if (stderrBytes <= maxBuffer) stderr.push(chunk);
  });
  const finish = (error, code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    active.delete(id);
    killFinished.then(() => {
      const reason = failure ?? error ?? (code === 0 ? null : new Error('Process exited with code ' + code));
      if (reason) parentPort.postMessage({ id, error: { message: reason.message, code: reason.code, stderr: Buffer.concat(stderr).toString('utf8') } });
      else parentPort.postMessage({ id, output: Buffer.concat(stdout).toString('utf8').trimEnd() });
    });
  };
  child.once('error', error => finish(error));
  child.once('close', code => finish(undefined, code));
});`;

interface WorkerResponse {
  id: number;
  output?: string;
  error?: { message: string; code?: string; stderr?: string };
}

/** Owns every spawned process so timeouts and plugin shutdown terminate its descendants too. */
export function createProcessRunner(): ProcessRunner {
  let worker: Worker | undefined;
  let closed = false;
  let nextId = 0;
  let cleanupPromise: Promise<void> | undefined;
  const pending = new Map<number, { resolve: (output: string) => void; reject: (error: Error) => void }>();

  function getWorker(): Worker {
    if (worker) return worker;
    const instance = new Worker(workerSource, { eval: true });
    worker = instance;
    instance.on("message", (message: WorkerResponse) => {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) {
        request.reject(Object.assign(new Error(message.error.message), {
          code: message.error.code,
          stderr: message.error.stderr,
        }));
      } else {
        request.resolve(message.output ?? "");
      }
      if (pending.size === 0) {
        if (closed) void instance.terminate();
        else instance.unref();
      }
    });
    const fail = (error: Error) => {
      if (worker !== instance) return;
      worker = undefined;
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    };
    instance.on("error", fail);
    instance.on("exit", (code) => fail(new Error(`Process worker exited with code ${code}`)));
    instance.unref();
    return instance;
  }

  return {
    run(command, args, options = {}) {
      if (closed) return Promise.reject(new Error("Process runner has been closed"));
      return new Promise((resolve, reject) => {
        const instance = getWorker();
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        instance.ref();
        instance.postMessage({ id, command, args, options });
      });
    },
    cleanup() {
      if (cleanupPromise) return cleanupPromise;
      closed = true;
      const instance = worker;
      if (!instance) return Promise.resolve();
      cleanupPromise = new Promise<void>((resolve) => {
        instance.once("exit", () => resolve());
        if (pending.size === 0) void instance.terminate();
        else instance.postMessage({ type: "cleanup" });
      });
      return cleanupPromise;
    },
  };
}
