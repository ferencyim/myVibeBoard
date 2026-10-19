import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createBackendCollector, type HttpClient } from "../server/collectors/backend";
import type { VerifyConfig } from "../server/collectors/common";
import { createScriptedRunner } from "../server/vibe/contract/collector";
import { makeCtx } from "./helpers";

const ok: HttpClient = async (r) => ({
  status: r.url.endsWith("/missing") ? 404 : 200,
  headers: { "x-a": "1" },
  body: '{"ok":true}',
});

describe("backend collector", () => {
  const config: VerifyConfig = {
    backend: {
      test: { command: "npm", args: ["test"] },
      baseUrl: "http://127.0.0.1:3000",
      requests: [
        { name: "health", method: "GET", url: "/health", expectStatus: 200 },
        { name: "create", method: "POST", url: "/items", body: { a: 1 }, expectStatus: 200 },
        { name: "chk-only", method: "GET", url: "/x", checkId: "c1" },
      ],
    },
  };

  it("runs tests through the Runner and writes report, log and samples", async () => {
    const runner = createScriptedRunner(() => ({ exitCode: 0, stdout: "5 passed", durationMs: 42 }));
    const c = createBackendCollector({ loadConfig: () => config, http: ok });
    const res = await c.collect(makeCtx({ projectType: "backend", runner }));
    expect(runner.calls[0]).toMatchObject({ command: "npm", args: ["test"] });
    expect(res.judgement).toBe("pass");
    const report = JSON.parse(readFileSync(res.artifacts[0].path, "utf8"));
    expect(report).toMatchObject({ passed: true, durationMs: 42, commitHash: "abc1234" });
    const samples = JSON.parse(readFileSync(res.artifacts.at(-1)!.path, "utf8"));
    expect(samples.map((s: { name: string }) => s.name)).toEqual(["health", "create"]);
    expect(samples[1].request).toMatchObject({
      method: "POST",
      url: "http://127.0.0.1:3000/items",
      body: '{"a":1}',
    });
    expect(res.artifacts.every((a) => a.capturedAt && a.commitHash)).toBe(true);
  });

  it("fails on test failure or unexpected status", async () => {
    const failing = createScriptedRunner(() => ({ exitCode: 1, stderr: "boom" }));
    const res = await createBackendCollector({ loadConfig: () => config, http: ok }).collect(
      makeCtx({ runner: failing }),
    );
    expect(res.judgement).toBe("fail");
    const bad: VerifyConfig = {
      backend: { requests: [{ name: "m", method: "GET", url: "http://h/missing", expectStatus: 200 }] },
    };
    const res2 = await createBackendCollector({ loadConfig: () => bad, http: ok }).collect(makeCtx());
    expect(res2.judgement).toBe("fail");
    expect(res2.notes.join()).toContain("expected 200, got 404");
  });

  it("per-check collection replays only that check's requests and skips tests", async () => {
    const runner = createScriptedRunner(() => undefined);
    const res = await createBackendCollector({ loadConfig: () => config, http: ok }).collect(
      makeCtx({ runner, check: { id: "c1", text: "", method: "" } }),
    );
    expect(runner.calls).toHaveLength(0);
    expect(JSON.parse(readFileSync(res.artifacts[0].path, "utf8"))).toHaveLength(1);
    expect(res.artifacts[0].path).toContain("c1-request-samples.json");
  });

  it("records transport errors as failures", async () => {
    const cfg: VerifyConfig = {
      backend: { requests: [{ name: "r", method: "GET", url: "http://h/" }] },
    };
    const res = await createBackendCollector({
      loadConfig: () => cfg,
      http: async () => {
        throw new Error("ECONNREFUSED");
      },
    }).collect(makeCtx());
    expect(res.judgement).toBe("fail");
  });

  it("detect needs a test command or requests", async () => {
    const ctx = makeCtx({ worktreePath: "/definitely/not/here" });
    expect((await createBackendCollector({ loadConfig: () => ({}) }).detect(ctx)).available).toBe(false);
    expect((await createBackendCollector({ loadConfig: () => config }).detect(ctx)).available).toBe(true);
  });
});
