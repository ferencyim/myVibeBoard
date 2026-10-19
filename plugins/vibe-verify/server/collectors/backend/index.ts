// Backend / CLI / library evidence collector: runs the project's tests through the injected
// Runner and replays configured requests against the (optionally started) service, recording
// request/response samples. Driven by `<worktree>/.vibe/verify.json` (see ../common.ts).
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import type {
  CollectResult,
  CollectorAvailability,
  CollectorContext,
  EvidenceArtifact,
  EvidenceCollector,
} from "../../vibe/contract/collector";
import {
  ServerRegistry,
  type PerfConfig,
  createNodeServerLauncher,
  loadVerifyConfig,
  writeArtifact,
  type RequestSample,
  type ServerLauncher,
  type VerifyConfig,
} from "../common";

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type HttpClient = (req: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}) => Promise<HttpResponse>;

export const fetchHttpClient: HttpClient = async (req) => {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    signal: AbortSignal.timeout(30_000),
  });
  return {
    status: res.status,
    headers: Object.fromEntries(res.headers),
    body: await res.text(),
  };
};

export interface BackendCollectorOptions {
  launcher?: ServerLauncher;
  http?: HttpClient;
  loadConfig?: (ctx: CollectorContext) => VerifyConfig;
  testTimeoutMs?: number;
}

const MAX_LOG_BYTES = 200_000;
const MAX_BODY_CHARS = 20_000;

/** Test command from config, else guessed from the project files. */
export function resolveTestCommand(
  config: VerifyConfig,
  worktreePath: string,
): { command: string; args: string[] } | undefined {
  if (config.backend?.test) return { command: config.backend.test.command, args: config.backend.test.args };
  const has = (f: string) => existsSync(path.join(worktreePath, f));
  if (has("package.json")) {
    const pkg = JSON.parse(readFileSync(path.join(worktreePath, "package.json"), "utf8"));
    if (pkg.scripts?.test) return { command: "npm", args: ["test"] };
  }
  if (has("Cargo.toml")) return { command: "cargo", args: ["test"] };
  if (has("go.mod")) return { command: "go", args: ["test", "./..."] };
  if (has("pyproject.toml") || has("pytest.ini")) return { command: "python", args: ["-m", "pytest"] };
  return undefined;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]`;
}

function tail(text: string, max: number): string {
  return text.length <= max ? text : `[truncated ${text.length - max} chars]...\n${text.slice(-max)}`;
}

const medianOf = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

type Measured = { runs: number[]; medianMs: number } | { error: string };

/** Runs the timing command `runs` times in `cwd`; an error when it failed or timed out. */
async function measure(ctx: CollectorContext, perf: PerfConfig, cwd: string, timeoutMs: number): Promise<Measured> {
  const runs: number[] = [];
  for (let i = 0; i < perf.runs; i++) {
    const res = await ctx.runner.run(perf.command, perf.args, { cwd, timeoutMs, signal: ctx.signal });
    if (res.exitCode !== 0 || res.timedOut) {
      return { error: `${res.timedOut ? "timed out" : `exit ${res.exitCode}`}: ${(res.stderr || res.stdout).trim().slice(-300)}` };
    }
    runs.push(res.durationMs);
  }
  return { runs, medianMs: medianOf(runs) };
}

/** "Before vs after" timing of one command (baseline worktree vs this commit). */
async function comparePerf(ctx: CollectorContext, perf: PerfConfig, timeoutMs: number) {
  const after = await measure(ctx, perf, path.join(ctx.worktreePath, perf.cwd ?? "."), timeoutMs);
  let before: Measured | undefined;
  const copied: string[] = [];
  if (perf.baseline) {
    try {
      for (const rel of perf.copyToBaseline) {
        const from = path.join(ctx.worktreePath, rel);
        const to = path.join(perf.baseline.path, rel);
        if (!existsSync(from) || existsSync(to)) continue;
        mkdirSync(path.dirname(to), { recursive: true });
        copyFileSync(from, to);
        copied.push(to);
      }
      before = await measure(ctx, perf, path.join(perf.baseline.path, perf.cwd ?? "."), timeoutMs);
    } finally {
      for (const file of copied) unlinkSync(file);
    }
  }
  const measuredBefore = before && "medianMs" in before ? before.medianMs : undefined;
  const beforeMs = measuredBefore ?? perf.beforeMs;
  const beforeSource = measuredBefore !== undefined ? "baseline" : perf.beforeMs !== undefined ? "recorded" : "none";
  const afterMs = "medianMs" in after ? after.medianMs : undefined;
  const improvement = beforeMs !== undefined && afterMs !== undefined && beforeMs > 0 ? (beforeMs - afterMs) / beforeMs : undefined;
  let judgement: "pass" | "fail" | "doubt" = "pass";
  const reasons: string[] = [];
  if (afterMs === undefined) {
    judgement = "fail";
    reasons.push(`command failed after the change (${"error" in after ? after.error : ""})`);
  } else if (perf.thresholdMs !== undefined && afterMs > perf.thresholdMs) {
    judgement = "fail";
    reasons.push(`still above the threshold: ${afterMs}ms > ${perf.thresholdMs}ms`);
  }
  if (judgement !== "fail" && improvement !== undefined && improvement < 0.1) {
    judgement = "doubt";
    reasons.push(`less than 10% faster than before (${beforeMs}ms -> ${afterMs}ms)`);
  }
  if (judgement !== "fail" && beforeMs === undefined) {
    judgement = "doubt";
    reasons.push("no baseline timing available, cannot show the improvement");
  }
  return { after, before, beforeMs, beforeSource, afterMs, improvement, judgement, reasons };
}

export function createBackendCollector(options: BackendCollectorOptions = {}): EvidenceCollector {
  const launcher = options.launcher ?? createNodeServerLauncher();
  const http = options.http ?? fetchHttpClient;
  const loadConfig = options.loadConfig ?? ((ctx) => loadVerifyConfig(ctx.worktreePath));
  const servers = new ServerRegistry();

  const selectRequests = (config: VerifyConfig, ctx: CollectorContext): RequestSample[] =>
    (config.backend?.requests ?? []).filter((r) =>
      ctx.check ? r.checkId === ctx.check.id : r.checkId === undefined,
    );

  return {
    id: "backend",
    projectTypes: ["backend", "other"],

    async detect(ctx): Promise<CollectorAvailability> {
      const config = loadConfig(ctx);
      if (
        resolveTestCommand(config, ctx.worktreePath) ||
        selectRequests(config, ctx).length > 0 ||
        config.backend?.perf
      ) {
        return { available: true };
      }
      return { available: false, reason: "No test command found and no requests configured in .vibe/verify.json" };
    },

    async collect(ctx): Promise<CollectResult> {
      const config = loadConfig(ctx);
      const prefix = ctx.check ? `${ctx.check.id}-` : "";
      const artifacts: EvidenceArtifact[] = [];
      const notes: string[] = [];
      const failures: string[] = [];
      const doubts: string[] = [];
      let ran = false;

      // Tests are card-wide evidence; per-check collection only replays that check's requests.
      const testCmd = ctx.check ? undefined : resolveTestCommand(config, ctx.worktreePath);
      if (testCmd) {
        ran = true;
        const result = await ctx.runner.run(testCmd.command, testCmd.args, {
          cwd: ctx.worktreePath,
          timeoutMs: options.testTimeoutMs ?? 600_000,
          signal: ctx.signal,
        });
        const passed = result.exitCode === 0 && !result.timedOut;
        const cmdline = [testCmd.command, ...testCmd.args].join(" ");
        artifacts.push(
          writeArtifact(
            ctx,
            "report",
            `${prefix}test-report.json`,
            JSON.stringify(
              {
                command: cmdline,
                exitCode: result.exitCode,
                timedOut: result.timedOut,
                durationMs: result.durationMs,
                passed,
                commitHash: ctx.commitHash,
                capturedAt: ctx.now().toISOString(),
              },
              null,
              2,
            ),
            `tests: ${passed ? "passed" : "failed"}`,
          ),
          writeArtifact(
            ctx,
            "log",
            `${prefix}test-output.log`,
            tail(`${result.stdout}${result.stderr ? `\n--- stderr ---\n${result.stderr}` : ""}`, MAX_LOG_BYTES),
            "test output",
          ),
        );
        notes.push(`${cmdline}: ${result.timedOut ? "timed out" : `exit ${result.exitCode}`} in ${result.durationMs}ms`);
        if (!passed) failures.push(`tests failed (${cmdline})`);
      } else if (!ctx.check) {
        notes.push("No test command found");
      }

      const requests = selectRequests(config, ctx);
      if (requests.length > 0) {
        ran = true;
        const backend = config.backend!;
        if (backend.server) servers.add(ctx.verificationId, await launcher.start(backend.server, ctx.worktreePath));
        const samples = [];
        for (const req of requests) {
          const url = /^https?:\/\//.test(req.url)
            ? req.url
            : new URL(req.url, backend.baseUrl ?? backend.server?.readyUrl).toString();
          const body = req.body === undefined ? undefined : typeof req.body === "string" ? req.body : JSON.stringify(req.body);
          const headers = { ...(body !== undefined && typeof req.body !== "string" ? { "content-type": "application/json" } : {}), ...req.headers };
          const started = Date.now();
          try {
            const res = await http({ method: req.method, url, headers, body });
            const ok = req.expectStatus === undefined || res.status === req.expectStatus;
            if (!ok) failures.push(`${req.name}: expected ${req.expectStatus}, got ${res.status}`);
            samples.push({
              name: req.name,
              request: { method: req.method, url, headers, body },
              response: { status: res.status, headers: res.headers, body: truncate(res.body, MAX_BODY_CHARS) },
              expectStatus: req.expectStatus,
              ok,
              durationMs: Date.now() - started,
            });
          } catch (e) {
            failures.push(`${req.name}: request failed (${String(e)})`);
            samples.push({ name: req.name, request: { method: req.method, url, headers, body }, error: String(e), ok: false });
          }
        }
        artifacts.push(
          writeArtifact(ctx, "report", `${prefix}request-samples.json`, JSON.stringify(samples, null, 2), "request/response samples"),
        );
        notes.push(`${samples.filter((s) => s.ok).length}/${samples.length} request sample(s) matched expectations`);
      }

      const perf = ctx.check ? undefined : config.backend?.perf;
      if (perf) {
        ran = true;
        const cmp = await comparePerf(ctx, perf, options.testTimeoutMs ?? 600_000);
        const pct = cmp.improvement === undefined ? "" : ` (${(cmp.improvement * 100).toFixed(1)}% faster)`;
        const line = `perf ${perf.label}: before ${cmp.beforeMs ?? "n/a"}ms (${cmp.beforeSource}) -> after ${cmp.afterMs ?? "failed"}ms${pct}`;
        artifacts.push(
          writeArtifact(
            ctx,
            "report",
            "perf-compare.json",
            JSON.stringify(
              {
                label: perf.label,
                command: [perf.command, ...perf.args].join(" "),
                thresholdMs: perf.thresholdMs,
                before: {
                  source: cmp.beforeSource,
                  medianMs: cmp.beforeMs,
                  runs: cmp.before && "runs" in cmp.before ? cmp.before.runs : undefined,
                  baseline: perf.baseline,
                },
                after: { medianMs: cmp.afterMs, runs: "runs" in cmp.after ? cmp.after.runs : undefined, commitHash: ctx.commitHash },
                improvement: cmp.improvement,
                judgement: cmp.judgement,
                reasons: cmp.reasons,
                capturedAt: ctx.now().toISOString(),
              },
              null,
              2,
            ),
            `before/after: ${line}`,
          ),
        );
        notes.push(line, ...cmp.reasons);
        if (cmp.judgement === "fail") failures.push(`${perf.label}: ${cmp.reasons.join("; ")}`);
        else if (cmp.judgement === "doubt") doubts.push(`${perf.label}: ${cmp.reasons.join("; ")}`);
      }

      if (!ran) {
        return { artifacts, judgement: "doubt", notes: [...notes, "Nothing to run for this collection"], degraded: false };
      }
      return {
        artifacts,
        judgement: failures.length ? "fail" : doubts.length ? "doubt" : "pass",
        notes: [...notes, ...failures],
        degraded: false,
      };
    },

    async dispose(ctx) {
      await servers.stopAll(ctx.verificationId);
    },
  };
}
