// Process seam for the desktop collector: start the app, read its output, stop only that process.

import { execFile, spawn } from "node:child_process";

export interface AppProcess {
  pid?: number;
  /** undefined while running. */
  exitCode(): number | null | undefined;
  output(): { stdout: string; stderr: string };
  /** Kills the process tree of this process only. */
  stop(): Promise<void>;
}

export interface AppLauncher {
  start(
    command: string,
    args: readonly string[],
    options: { cwd?: string; env?: Record<string, string> },
  ): AppProcess;
}

const MAX_OUTPUT = 1_000_000;

export function createNodeAppLauncher(): AppLauncher {
  return {
    start(command, args, options) {
      // windowsHide must stay false: it would start GUI apps with a hidden window.
      const child = spawn(command, [...args], {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: false,
      });
      let stdout = "";
      let stderr = "";
      let exit: number | null | undefined;
      const cap = (s: string, d: Buffer) => (s.length < MAX_OUTPUT ? s + d.toString() : s);
      child.stdout?.on("data", (d: Buffer) => (stdout = cap(stdout, d)));
      child.stderr?.on("data", (d: Buffer) => (stderr = cap(stderr, d)));
      child.on("error", (e) => {
        stderr += String(e);
        exit = -1;
      });
      child.on("exit", (code) => (exit = code));
      return {
        pid: child.pid,
        exitCode: () => exit,
        output: () => ({ stdout, stderr }),
        stop() {
          if (exit !== undefined || !child.pid) return Promise.resolve();
          if (process.platform === "win32") {
            return new Promise<void>((resolve) =>
              execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => resolve()),
            );
          }
          try {
            child.kill("SIGTERM");
          } catch {
            // already gone
          }
          return Promise.resolve();
        },
      };
    },
  };
}
