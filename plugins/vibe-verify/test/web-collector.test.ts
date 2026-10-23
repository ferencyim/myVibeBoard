import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import type { ServerCommand, VerifyConfig } from "../server/collectors/common";
import { createWebCollector } from "../server/collectors/web";
import type { BrowserDriver, PageSession, Viewport } from "../server/collectors/web/driver";
import { compareScreenshots } from "../server/collectors/web/images";
import { makeCtx, solidPng } from "./helpers";

function fakeDriver(
  opts: {
    errors?: string[];
    failStep?: boolean;
    colorFor?: (url: string) => [number, number, number];
  } = {},
) {
  const opened: Viewport[] = [];
  const steps: string[] = [];
  const driver: BrowserDriver = {
    probe: async () => ({ ok: true }),
    async open(viewport) {
      opened.push(viewport);
      let url = "";
      let n = 0;
      const page: PageSession = {
        goto: async (u) => void (url = u),
        screenshot: async () =>
          solidPng(viewport.width, 20, opts.colorFor?.(url) ?? [(n++ * 40) % 256, 0, 0]),
        async step(step) {
          steps.push(step.action);
          if (opts.failStep) throw new Error("selector not found");
        },
        consoleErrors: () => opts.errors ?? [],
        close: async () => {},
      };
      return page;
    },
    close: async () => {},
  };
  return { driver, opened, steps };
}

function launcher() {
  const started: ServerCommand[] = [];
  let stopped = 0;
  return {
    started,
    stoppedCount: () => stopped,
    launcher: {
      async start(spec: ServerCommand) {
        started.push(spec);
        return { stop: async () => void stopped++ };
      },
    },
  };
}

const server: ServerCommand = {
  command: "npm",
  args: ["run", "dev"],
  readyUrl: "http://127.0.0.1:5173/",
  readyTimeoutMs: 1000,
};
const names = (res: { artifacts: { path: string }[] }) =>
  res.artifacts.map((a) => a.path.split(/[\\/]/).pop());

describe("web collector", () => {
  it("takes desktop and mobile screenshots, stamped with time and commit", async () => {
    const { driver, opened } = fakeDriver();
    const l = launcher();
    const config: VerifyConfig = { web: { server, entry: "/", steps: [] } };
    const c = createWebCollector({ driver, launcher: l.launcher, loadConfig: () => config });
    const ctx = makeCtx();
    const res = await c.collect(ctx);
    expect(opened.map((v) => v.width)).toEqual([1280, 390]);
    expect(names(res)).toEqual(["after-desktop.png", "after-mobile.png"]);
    for (const a of res.artifacts) {
      expect(a.commitHash).toBe("abc1234");
      expect(a.capturedAt).toBe("2026-10-19T00:00:00.000Z");
      expect(a.kind).toBe("screenshot");
      expect(a.simulated).toBe(false);
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(res.judgement).toBe("pass");
    expect(res.notes.join()).toContain("未配置基线");
    await c.dispose!(ctx);
    expect(l.stoppedCount()).toBe(1);
  });

  it("records interaction steps as a GIF and prefixes names with the check id", async () => {
    const { driver, steps } = fakeDriver();
    const config: VerifyConfig = {
      web: {
        url: "http://x/",
        entry: "/",
        steps: [
          { action: "click", selector: "#a" },
          { action: "wait", ms: 10 },
        ],
      },
    };
    const c = createWebCollector({
      driver,
      launcher: launcher().launcher,
      loadConfig: () => config,
    });
    const res = await c.collect(makeCtx({ check: { id: "chk1", text: "t", method: "m" } }));
    const gif = res.artifacts.find((a) => a.kind === "gif")!;
    expect(gif.path).toContain("chk1-interaction.gif");
    expect(readFileSync(gif.path).subarray(0, 6).toString()).toBe("GIF89a");
    expect(steps).toEqual(["click", "wait"]);
  });

  it("collects console errors as a log and downgrades to doubt", async () => {
    const { driver } = fakeDriver({ errors: ["console.error: boom"] });
    const c = createWebCollector({
      driver,
      loadConfig: () => ({ web: { url: "http://x/", entry: "/", steps: [] } }),
    });
    const res = await c.collect(makeCtx());
    const log = res.artifacts.find((a) => a.kind === "log")!;
    expect(readFileSync(log.path, "utf8")).toContain("boom");
    expect(res.judgement).toBe("doubt");
  });

  it("fails when an interaction step fails but still returns the GIF", async () => {
    const { driver } = fakeDriver({ failStep: true });
    const config: VerifyConfig = {
      web: { url: "http://x/", entry: "/", steps: [{ action: "click", selector: "#missing" }] },
    };
    const res = await createWebCollector({ driver, loadConfig: () => config }).collect(makeCtx());
    expect(res.judgement).toBe("fail");
    expect(res.artifacts.some((a) => a.kind === "gif")).toBe(true);
  });

  it("produces before/after screenshots and a comparison when a baseline is configured", async () => {
    const { driver } = fakeDriver({
      colorFor: (u) => (u.startsWith("http://before") ? [255, 255, 255] : [0, 0, 0]),
    });
    const config: VerifyConfig = {
      web: {
        url: "http://after/",
        entry: "/",
        steps: [],
        baseline: { path: "/base", url: "http://before/", commitHash: "base000" },
      },
    };
    const res = await createWebCollector({ driver, loadConfig: () => config }).collect(makeCtx());
    expect(names(res)).toEqual(
      expect.arrayContaining(["before-desktop.png", "compare-desktop.png", "compare-mobile.png"]),
    );
    expect(res.notes.join()).toContain("100.00% 的像素相较基线发生变化 base000");
  });

  it("starts the baseline server from the baseline worktree", async () => {
    const { driver } = fakeDriver();
    const l = launcher();
    const config: VerifyConfig = {
      web: { url: "http://after/", entry: "/", steps: [], baseline: { path: "/base", server } },
    };
    await createWebCollector({ driver, launcher: l.launcher, loadConfig: () => config }).collect(
      makeCtx(),
    );
    expect(l.started).toHaveLength(1);
  });

  it("detect reports missing target and unavailable browser", async () => {
    const { driver } = fakeDriver();
    const ctx = makeCtx();
    const cfg: VerifyConfig = { web: { url: "http://x", entry: "/", steps: [] } };
    expect(
      (await createWebCollector({ driver, loadConfig: () => ({}) }).detect(ctx)).available,
    ).toBe(false);
    expect(
      (await createWebCollector({ driver, loadConfig: () => cfg }).detect(ctx)).available,
    ).toBe(true);
    const noBrowser: BrowserDriver = {
      ...driver,
      probe: async () => ({ ok: false, reason: "no chromium" }),
    };
    expect(
      await createWebCollector({ driver: noBrowser, loadConfig: () => cfg }).detect(ctx),
    ).toEqual({ available: false, reason: "no chromium" });
  });
});

describe("compareScreenshots", () => {
  it("reports no change for identical images and tolerates differing sizes", () => {
    const a = solidPng(10, 10, [1, 2, 3]);
    expect(compareScreenshots(a, a).changedRatio).toBe(0);
    const cmp = compareScreenshots(a, solidPng(10, 14, [1, 2, 3]));
    expect(cmp.changedRatio).toBeGreaterThan(0);
    expect(PNG.sync.read(cmp.composite).width).toBe(10 * 3 + 16);
  });
});
