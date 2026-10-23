// Browser seam for the web collector. Tests inject a fake BrowserDriver; production uses
// Playwright (loaded lazily so the plugin loads without a browser installed).
import type { WebStep } from "../common";
import { loadPlaywright, type PwBrowser } from "../playwright-types";

export interface Viewport {
  width: number;
  height: number;
}

export interface PageSession {
  goto(url: string): Promise<void>;
  /** PNG bytes of the current viewport. */
  screenshot(): Promise<Buffer>;
  step(step: WebStep, baseUrl: string): Promise<void>;
  /** console.error output, uncaught page errors and failed requests seen so far. */
  consoleErrors(): string[];
  close(): Promise<void>;
}

export interface BrowserDriver {
  /** Cheap probe: is the browser engine usable? Returns a reason when not. */
  probe(): Promise<{ ok: true } | { ok: false; reason: string }>;
  open(viewport: Viewport): Promise<PageSession>;
  close(): Promise<void>;
}

export function createPlaywrightDriver(): BrowserDriver {
  let browser: PwBrowser | undefined;

  async function launch(): Promise<PwBrowser> {
    if (!browser) {
      const { chromium } = await loadPlaywright();
      browser = await chromium.launch();
    }
    return browser;
  }

  return {
    async probe() {
      try {
        const { chromium } = await loadPlaywright();
        const { existsSync } = await import("node:fs");
        return existsSync(chromium.executablePath())
          ? { ok: true }
          : {
              ok: false,
              reason: "未安装 Playwright chromium（可运行 npx playwright install chromium）",
            };
      } catch (e) {
        return { ok: false, reason: `Playwright 不可用： ${String(e)}` };
      }
    },
    async open(viewport) {
      const context = await (await launch()).newContext({ viewport, deviceScaleFactor: 1 });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
      });
      page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
      page.on("requestfailed", (r) =>
        errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`),
      );
      return {
        async goto(url) {
          await page.goto(url, { waitUntil: "load" });
        },
        screenshot: () => page.screenshot({ type: "png" }),
        async step(step, baseUrl) {
          switch (step.action) {
            case "goto":
              await page.goto(new URL(step.path, baseUrl).toString(), { waitUntil: "load" });
              break;
            case "click":
              await page.click(step.selector, { timeout: 5_000 });
              break;
            case "fill":
              await page.fill(step.selector, step.value, { timeout: 5_000 });
              break;
            case "press":
              await page.keyboard.press(step.key);
              break;
            case "wait":
              await page.waitForTimeout(step.ms);
              break;
          }
        },
        consoleErrors: () => [...errors],
        close: () => context.close(),
      };
    },
    async close() {
      await browser?.close();
      browser = undefined;
    },
  };
}
