// Optional UI automation for Electron apps through Playwright `_electron` (loaded lazily).

import type { DesktopStep } from "./config";

export interface ElectronSession {
  /** PNG of the first window. */
  screenshot(): Promise<Buffer>;
  step(step: DesktopStep): Promise<void>;
  output(): { stdout: string; stderr: string };
  close(): Promise<void>;
}

export interface ElectronDriver {
  launch(spec: {
    executablePath: string;
    args: string[];
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs: number;
  }): Promise<ElectronSession>;
}

export function createPlaywrightElectronDriver(): ElectronDriver {
  return {
    async launch(spec) {
      // Opaque specifier: the plugin bundler must not inline playwright (resolved at run time).
      const { _electron } = (await import(["play", "wright"].join(""))) as typeof import("playwright");
      const app = await _electron.launch({
        executablePath: spec.executablePath,
        args: spec.args,
        cwd: spec.cwd,
        env: { ...(process.env as Record<string, string>), ...spec.env },
        timeout: spec.timeoutMs,
      });
      let stdout = "";
      let stderr = "";
      app.process().stdout?.on("data", (d: Buffer) => (stdout += d));
      app.process().stderr?.on("data", (d: Buffer) => (stderr += d));
      const page = await app.firstWindow({ timeout: spec.timeoutMs });
      return {
        screenshot: () => page.screenshot(),
        async step(step) {
          if (step.type === "click") await page.click(step.selector, { timeout: 10_000 });
          else if (step.type === "fill") await page.fill(step.selector, step.value, { timeout: 10_000 });
          else if (step.type === "press") await page.keyboard.press(step.key);
          else if (step.type === "wait") await page.waitForTimeout(step.ms);
        },
        output: () => ({ stdout, stderr }),
        close: () => app.close().catch(() => undefined),
      };
    },
  };
}
