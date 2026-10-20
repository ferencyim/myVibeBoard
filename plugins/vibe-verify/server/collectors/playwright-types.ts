// Minimal structural types for the parts of Playwright the collectors use.
// We must not reference `typeof import("playwright")`: the Paseo plugin bundler follows type
// imports and fails on Playwright's optional `electron` type dependency. Playwright itself is
// loaded at run time through an opaque specifier.

export interface PwConsoleMessage {
  type(): string;
  text(): string;
}

export interface PwPage {
  on(event: "console", listener: (message: PwConsoleMessage) => void): void;
  on(event: "pageerror", listener: (error: Error) => void): void;
  on(
    event: "requestfailed",
    listener: (request: { url(): string; failure(): { errorText: string } | null }) => void,
  ): void;
  goto(url: string, options?: { waitUntil?: "load" | "domcontentloaded" | "networkidle" }): Promise<unknown>;
  screenshot(options?: { type?: "png" | "jpeg" }): Promise<Buffer>;
  click(selector: string, options?: { timeout?: number }): Promise<void>;
  fill(selector: string, value: string, options?: { timeout?: number }): Promise<void>;
  keyboard: { press(key: string): Promise<void> };
  waitForTimeout(ms: number): Promise<void>;
}

export interface PwBrowserContext {
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
}

export interface PwBrowser {
  newContext(options?: {
    viewport?: { width: number; height: number };
    deviceScaleFactor?: number;
    isMobile?: boolean;
    hasTouch?: boolean;
  }): Promise<PwBrowserContext>;
  close(): Promise<void>;
}

export interface PwElectronApp {
  process(): {
    stdout?: { on(event: "data", listener: (chunk: Buffer) => void): void } | null;
    stderr?: { on(event: "data", listener: (chunk: Buffer) => void): void } | null;
  };
  firstWindow(options?: { timeout?: number }): Promise<PwPage>;
  close(): Promise<void>;
}

export interface PlaywrightModule {
  chromium: { launch(): Promise<PwBrowser>; executablePath(): string };
  _electron: {
    launch(options: {
      executablePath: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
      timeout?: number;
    }): Promise<PwElectronApp>;
  };
}

/** Load Playwright at run time without letting the plugin bundler see the specifier. */
export function loadPlaywright(): Promise<PlaywrightModule> {
  return import(["play", "wright"].join("")) as Promise<PlaywrightModule>;
}
