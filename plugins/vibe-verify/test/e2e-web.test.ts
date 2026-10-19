// Real-environment run: VIBE_E2E_WEB=1 npm test  (needs `npx playwright install chromium`).
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { createBackendCollector, createWebCollector } from "../server/collectors";
import { createNodeRunner } from "../server/collectors/common";
import { makeCtx } from "./helpers";

const PAGE = (title: string) => `<!doctype html><meta name=viewport content="width=device-width">
<h1 id=t>${title}</h1><button id=b onclick="document.getElementById('t').textContent='Clicked'">Go</button>
<script>console.error("demo console error")</script>`;

function serve(handler: Parameters<typeof createServer>[1]) {
  return new Promise<{ url: string; close: () => void }>((resolve) => {
    const s = createServer(handler).listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${(s.address() as { port: number }).port}`,
        close: () => s.close(),
      }),
    );
  });
}

describe.skipIf(!process.env.VIBE_E2E_WEB)("e2e: real Playwright + real Runner", () => {
  it("captures screenshots, GIF, console errors and before/after against a local page", async () => {
    const before = await serve((_, res) => res.end(PAGE("Before")));
    const after = await serve((_, res) => res.end(PAGE("After")));
    try {
      const collector = createWebCollector({
        loadConfig: () => ({
          web: {
            url: after.url,
            entry: "/",
            steps: [{ action: "click", selector: "#b" }],
            baseline: { path: "/unused", url: before.url, commitHash: "base" },
          },
        }),
      });
      const ctx = makeCtx({ commitHash: "e2e1234" });
      expect((await collector.detect(ctx)).available).toBe(true);
      const res = await collector.collect(ctx);
      await collector.dispose!(ctx);
      const byName = (n: string) => res.artifacts.find((a) => a.path.endsWith(n))!;
      expect(PNG.sync.read(readFileSync(byName("after-desktop.png").path)).width).toBe(1280);
      expect(PNG.sync.read(readFileSync(byName("after-mobile.png").path)).width).toBe(390);
      expect(readFileSync(byName("interaction.gif").path).subarray(0, 3).toString()).toBe("GIF");
      expect(readFileSync(byName("console-errors.txt").path, "utf8")).toContain("demo console error");
      expect(byName("compare-desktop.png")).toBeTruthy();
      expect(res.judgement).toBe("doubt");
    } finally {
      before.close();
      after.close();
    }
  }, 60_000);

  it("runs a real test command and replays a request against a real server", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vibe-be-"));
    writeFileSync(path.join(dir, "ok.js"), "console.log('1 passed')");
    const api = await serve((_, res) => res.end('{"pong":true}'));
    try {
      const c = createBackendCollector({
        loadConfig: () => ({
          backend: {
            test: { command: "node", args: ["ok.js"] },
            baseUrl: api.url,
            requests: [{ name: "ping", method: "GET", url: "/ping", expectStatus: 200 }],
          },
        }),
      });
      const res = await c.collect(
        makeCtx({ worktreePath: dir, projectType: "backend", runner: createNodeRunner() }),
      );
      expect(res.judgement).toBe("pass");
      expect(readFileSync(res.artifacts[1].path, "utf8")).toContain("1 passed");
    } finally {
      api.close();
    }
  });
});
