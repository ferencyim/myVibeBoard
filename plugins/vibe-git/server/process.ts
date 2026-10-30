import { spawn } from "node:child_process";

export interface ProcessOptions {
  cwd?: string;
  timeoutMs?: number;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
}

export interface ProcessRunner {
  run(command: string, args: string[], options?: ProcessOptions): Promise<string>;
  cleanup(): void;
}

/** Owns every spawned process so timeouts and plugin shutdown terminate its descendants too. */
export function createProcessRunner(): ProcessRunner {
  const active = new Set<() => void>();
  let closed = false;

  function run(command: string, args: string[], options: ProcessOptions = {}): Promise<string> {
    if (closed) return Promise.reject(new Error("Process runner has been closed"));

    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const maxBuffer = options.maxBuffer ?? 4 * 1024 * 1024;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let failure: Error | null = null;
      let killing = false;
      let settled = false;
      let killFinished: Promise<void> = Promise.resolve();

      const terminate = () => {
        if (killing) return;
        killing = true;
        clearTimeout(timer);
        if (!failure) failure = new Error("Process terminated");
        const pid = child.pid;
        if (!pid) return;
        if (process.platform === "win32") {
          killFinished = new Promise<void>((done) => {
            let completed = false;
            const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
              windowsHide: true,
              stdio: "ignore",
            });
            const finishKill = (success: boolean) => {
              if (completed) return;
              completed = true;
              clearTimeout(killTimer);
              if (!success) child.kill();
              done();
            };
            const killTimer = setTimeout(() => {
              killer.kill();
              finishKill(false);
            }, 2000);
            killer.once("error", () => finishKill(false));
            killer.once("close", (code) => finishKill(code === 0));
          });
        } else {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      };
      active.add(terminate);
      const timer = setTimeout(() => {
        failure = new Error(`Process timed out after ${options.timeoutMs ?? 5000} ms`);
        terminate();
      }, options.timeoutMs ?? 5000);

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxBuffer) {
          failure = new Error("Process stdout exceeded maximum buffer");
          terminate();
        } else {
          stdout.push(chunk);
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes <= maxBuffer) stderr.push(chunk);
      });

      const finish = (error?: Error, code?: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        active.delete(terminate);
        void killFinished.then(() => {
          const stderrText = Buffer.concat(stderr).toString("utf8");
          const reason = failure ?? error ?? (code === 0 ? null : new Error(`Process exited with code ${code}`));
          if (reason) {
            Object.assign(reason, { stderr: stderrText });
            reject(reason);
          } else {
            resolve(Buffer.concat(stdout).toString("utf8").trimEnd());
          }
        });
      };
      child.once("error", (error) => finish(error));
      child.once("close", (code) => finish(undefined, code));
    });
  }

  return {
    run,
    cleanup() {
      closed = true;
      for (const terminate of active) terminate();
    },
  };
}
