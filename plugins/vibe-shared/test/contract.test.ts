import { describe, expect, it } from "vitest";
import {
  CollectResultSchema,
  EvidenceArtifactSchema,
  compareHlc,
  createCollectorRegistry,
  createScriptedRunner,
  formatHlc,
  isUlid,
  newId,
  parseHlc,
  tickHlc,
  type CollectorContext,
  type EvidenceCollector,
} from "../contract";

describe("ids", () => {
  it("generates valid, strictly increasing ULIDs even within one millisecond", () => {
    const ids = Array.from({ length: 2000 }, () => newId(1_700_000_000_000));
    expect(ids.every(isUlid)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort());
    expect(newId(1_700_000_001_000) > ids.at(-1)!).toBe(true);
  });
});

describe("hlc", () => {
  it("formats, parses and orders as plain strings", () => {
    const a = formatHlc({ wall: 1_700_000_000_000, counter: 0, node: "dev-a" });
    expect(parseHlc(a)).toEqual({ wall: 1_700_000_000_000, counter: 0, node: "dev-a" });
    expect(() => parseHlc("garbage")).toThrow();
    const b = tickHlc(a, 1_700_000_000_000, "dev-a"); // same ms -> counter
    const c = tickHlc(b, 1_600_000_000_000, "dev-a"); // clock went back -> still increases
    const d = tickHlc(c, 1_800_000_000_000, "dev-a");
    expect([compareHlc(a, b), compareHlc(b, c), compareHlc(c, d)]).toEqual([-1, -1, -1]);
    expect(compareHlc("", a)).toBe(-1);
    // counter ordering must not be lexicographic-by-decimal
    expect(
      compareHlc(
        formatHlc({ wall: 1, counter: 9, node: "x" }),
        formatHlc({ wall: 1, counter: 10, node: "x" }),
      ),
    ).toBe(-1);
  });

  it("rolls the wall component when the counter overflows", () => {
    const max = formatHlc({ wall: 5, counter: 0xffff, node: "n" });
    const next = tickHlc(max, 1, "n");
    expect(compareHlc(max, next)).toBe(-1);
    expect(parseHlc(next)).toMatchObject({ wall: 6, counter: 0 });
  });
});

describe("collector interfaces", () => {
  const ctxBase = (runner: CollectorContext["runner"]): CollectorContext => ({
    cardId: null,
    workspaceId: "w",
    confirmedAt: "confirmed",
    verificationId: "v",
    projectType: "web",
    projectPath: "<repo>",
    worktreePath: "<wt>",
    commitHash: "abc",
    outputDir: "<out>",
    runner,
    now: () => new Date(0),
    log: () => undefined,
  });

  const fake: EvidenceCollector = {
    id: "fake-web",
    projectTypes: ["web", "backend"],
    async detect(ctx) {
      const r = await ctx.runner.run("browser", ["--version"]);
      return r.exitCode === 0 ? { available: true } : { available: false, reason: "no browser" };
    },
    async collect(ctx) {
      await ctx.runner.run("browser", ["shot", ctx.outputDir], {
        cwd: ctx.worktreePath,
        timeoutMs: 1000,
      });
      return {
        artifacts: [
          {
            kind: "screenshot",
            path: `${ctx.outputDir}/a.png`,
            capturedAt: ctx.now().toISOString(),
            commitHash: ctx.commitHash,
            simulated: false,
          },
        ],
        judgement: "pass",
        notes: [],
        degraded: false,
      };
    },
  };

  it("registers collectors, looks them up by project type and rejects duplicates", () => {
    const reg = createCollectorRegistry();
    reg.register(fake);
    expect(() => reg.register(fake)).toThrow(/already registered/);
    expect(reg.forProjectType("web")).toHaveLength(1);
    expect(reg.forProjectType("android")).toHaveLength(0);
    expect(reg.get("fake-web")).toBe(fake);
    expect(reg.list()).toHaveLength(1);
  });

  it("a collector runs against a scripted Runner and its result satisfies the zod contract", async () => {
    const runner = createScriptedRunner((call) =>
      call.args[0] === "--version" ? { exitCode: 127 } : undefined,
    );
    const ctx = ctxBase(runner);
    expect(await fake.detect(ctx)).toEqual({ available: false, reason: "no browser" });
    const result = await fake.collect(ctx);
    expect(runner.calls.map((c) => c.args[0])).toEqual(["--version", "shot"]);
    expect(runner.calls[1]?.options).toMatchObject({ cwd: "<wt>", timeoutMs: 1000 });
    expect(CollectResultSchema.parse(JSON.parse(JSON.stringify(result)))).toEqual(result);
    expect(
      EvidenceArtifactSchema.safeParse({ ...result.artifacts[0], kind: "hologram" }).success,
    ).toBe(false);
  });

  it("scripted runner defaults to a successful empty result", async () => {
    const runner = createScriptedRunner(() => undefined);
    expect(await runner.run("x", [])).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      durationMs: 0,
    });
  });
});
