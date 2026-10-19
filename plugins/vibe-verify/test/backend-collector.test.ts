import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createBackendCollector, type HttpClient } from "../server/collectors/backend";
import { PerfConfigSchema, type VerifyConfig } from "../server/collectors/common";
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
  describe("perf before/after comparison", () => {
    const perfConfig = (extra: Record<string, unknown> = {}): VerifyConfig => ({
      backend: {
        requests: [],
        perf: PerfConfigSchema.parse({
          label: "GET /items",
          command: "node",
          args: ["bench.js"],
          runs: 3,
          thresholdMs: 100,
          baseline: { path: "/base", commitHash: "base123" },
          ...extra,
        }),
      },
    });
    // 400ms in the baseline directory, 40ms in the worktree
    const timed = createScriptedRunner;

    it("measures baseline and worktree and records the improvement", async () => {
      const runner = timed((call) => ({ durationMs: call.options?.cwd?.toString().includes("base") ? 400 : 40 }));
      const res = await createBackendCollector({ loadConfig: () => perfConfig() }).collect(makeCtx({ runner }));
      expect(runner.calls).toHaveLength(6);
      expect(res.judgement).toBe("pass");
      const report = JSON.parse(readFileSync(res.artifacts.find((a) => a.path.endsWith("perf-compare.json"))!.path, "utf8"));
      expect(report).toMatchObject({
        label: "GET /items",
        before: { source: "baseline", medianMs: 400, runs: [400, 400, 400] },
        after: { medianMs: 40 },
        judgement: "pass",
      });
      expect(report.improvement).toBeCloseTo(0.9);
      expect(res.notes.join()).toContain("before 400ms (baseline) -> after 40ms");
    });

    it("fails when the fixed code is still above the threshold", async () => {
      const runner = timed((call) => ({ durationMs: call.options?.cwd?.toString().includes("base") ? 400 : 300 }));
      const res = await createBackendCollector({ loadConfig: () => perfConfig() }).collect(makeCtx({ runner }));
      expect(res.judgement).toBe("fail");
    });

    it("doubts when nothing got faster, or no before timing exists", async () => {
      const same = timed(() => ({ durationMs: 50 }));
      expect((await createBackendCollector({ loadConfig: () => perfConfig() }).collect(makeCtx({ runner: same }))).judgement).toBe("doubt");
      const noBase = timed(() => ({ durationMs: 50 }));
      const res = await createBackendCollector({ loadConfig: () => perfConfig({ baseline: undefined }) }).collect(makeCtx({ runner: noBase }));
      expect(res.judgement).toBe("doubt");
      const recorded = await createBackendCollector({ loadConfig: () => perfConfig({ baseline: undefined, beforeMs: 500 }) }).collect(makeCtx({ runner: noBase }));
      expect(recorded.judgement).toBe("pass");
    });

    it("falls back to the recorded timing when the baseline command fails", async () => {
      const runner = timed((call) => (call.options?.cwd?.toString().includes("base") ? { exitCode: 2, stderr: "no such file" } : { durationMs: 20 }));
      const res = await createBackendCollector({ loadConfig: () => perfConfig({ beforeMs: 200 }) }).collect(makeCtx({ runner }));
      expect(res.judgement).toBe("pass");
      expect(res.notes.join()).toContain("(recorded)");
    });
  });
});
