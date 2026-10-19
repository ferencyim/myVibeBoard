// WP-47 acceptance: an artificially slow function (fixture) is recognised from the slow log,
// reproduced, fixed by a (fake) worker in its own git worktree, and the vibe-verify backend collector
// produces the before/after timing evidence; unsure cases become draft cards; call sites are deduped.

import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPerfSlowCheck } from "../server/checks/perf-slow";
import type { FixLauncher } from "../server/types";
import { createBackendCollector } from "../../vibe-verify/server/collectors/backend";
import { createNodeRunner, loadVerifyConfig } from "../../vibe-verify/server/collectors/common";
import { prepareBaseline } from "../../vibe-verify/server/pipeline/git";
import { commit, makeRepo, setup, sh, write } from "./helpers";

const SLOW_JS = `// the "slow query": a blocking 1.2s wait
exports.query = () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200); return 1; };
`;
const FAST_JS = `exports.query = () => 1;\n`;
const BENCH_JS = `require("./slow.js").query();\n`;

const RULE = (repro: string, output = "fix") => `rules:
  - name: perf-slow
    trigger: { kind: time, cron: "0 4 * * *" }
    check:
      type: perf-slow
      sources:
        - { name: api, kind: jsonl, path: logs/access.jsonl, threshold_ms: 200 }
${repro}
    output: ${output}
    dedupe_key: perf-slow
    daily_cap: 5
`;
const REPRO = `      repro: { command: node, args: [bench.js, "{site}"], runs: 3, threshold_ms: 600 }`;

function slowRepo(): string {
  const repo = makeRepo();
  commit(repo, "slow.js", SLOW_JS, "add slow query");
  commit(repo, "bench.js", BENCH_JS, "add bench");
  mkdirSync(join(repo, "logs"), { recursive: true });
  return repo;
}

const logLine = (route: string, ms: number) => `${JSON.stringify({ route, duration_ms: ms, method: "GET" })}\n`;

describe("perf-slow (WP-47 acceptance)", () => {
  it("fixes an artificial slow query and produces before/after evidence", async () => {
    const repo = slowRepo();
    writeFileSync(join(repo, "logs", "access.jsonl"), logLine("/items/1", 900) + logLine("/items/2", 850) + logLine("/health", 3));
    const worktrees = mkdtempSync(join(tmpdir(), "vibe-perf-wt-"));
    const prompts: string[] = [];
    let workerWorktree = "";

    // The fake worker: follows the prompt (reads the verify.json block), fixes the code, commits.
    const fixLauncher: FixLauncher = {
      provider: () => "fake",
      launch: async ({ prompt, cardKey }) => {
        prompts.push(prompt);
        const wt = join(worktrees, cardKey.toLowerCase());
        sh(repo, ["worktree", "add", "-b", `fix/${cardKey.toLowerCase()}`, wt, "main"]);
        const block = /```json\n([\s\S]*?)```/.exec(prompt)![1]!;
        mkdirSync(join(wt, ".vibe"), { recursive: true });
        writeFileSync(join(wt, ".vibe", "verify.json"), block);
        writeFileSync(join(wt, "slow.js"), FAST_JS);
        sh(wt, ["add", "-A"]);
        sh(wt, ["commit", "-m", "make the query fast"]);
        workerWorktree = wt;
        return { workspaceId: "ws", worktree: wt };
      },
    };
    const h = setup({
      repo,
      yml: RULE(REPRO),
      engine: { checks: { "perf-slow": createPerfSlowCheck() }, fixLauncher },
    });
    await h.engine.tick();
    const ruleId = `${h.project.id}:perf-slow`;
    const outcome = await h.engine.runNow(ruleId);
    expect(outcome.status).toBe("fired");

    const [card] = h.maintenanceCards();
    expect(card).toMatchObject({
      column: "in_progress",
      origin: "maintenance",
      needsEvidence: true,
      dedupeKey: "perf-slow:api:get /items/:id",
    });
    expect(card!.title).toContain("GET /items/:id");
    expect(card!.acceptance).toContain("perf-compare.json");
    const findings = JSON.stringify(h.engine.listRuns(ruleId)[0]!.findings);
    expect(findings).toContain("已复现");
    expect(prompts[0]).toContain("PERF-INCONCLUSIVE");

    // ---- verification: baseline worktree (before) vs the fixed worktree (after) ----------------
    const runner = createNodeRunner();
    const baseline = await prepareBaseline(runner, workerWorktree, join(worktrees, "baseline"), ["main"]);
    expect(baseline).toBeDefined();
    const config = loadVerifyConfig(workerWorktree);
    expect(config.backend?.perf).toMatchObject({ label: "GET /items/:id", thresholdMs: 600 });
    config.backend!.perf!.baseline = { path: baseline!.path, commitHash: baseline!.commitHash };
    const outputDir = mkdtempSync(join(tmpdir(), "vibe-perf-evidence-"));
    const collector = createBackendCollector({ loadConfig: () => config });
    const result = await collector.collect({
      cardId: card!.id,
      verificationId: "ver_1",
      projectType: "backend",
      projectPath: repo,
      worktreePath: workerWorktree,
      commitHash: sh(workerWorktree, ["rev-parse", "HEAD"]).trim(),
      outputDir,
      runner,
      now: () => new Date(),
      log: () => undefined,
    });
    const report = JSON.parse(
      readFileSync(result.artifacts.find((a) => a.path.endsWith("perf-compare.json"))!.path, "utf8"),
    );
    expect(report.before.source).toBe("baseline");
    expect(report.before.medianMs).toBeGreaterThanOrEqual(1200);
    expect(report.after.medianMs).toBeLessThan(600);
    expect(report.judgement).toBe("pass");
    expect(result.judgement).toBe("pass");

    // the worker's round ends: the lifecycle moves the card to verifying
    h.store.cards.move(card!.id, { to: "verifying", actor: "lifecycle" });
    expect(h.store.cards.get(card!.id)!.column).toBe("verifying");
  }, 120_000);

  it("dedupes by call site: an open card blocks the same site, other sites still get cards", async () => {
    const repo = slowRepo();
    const log = join(repo, "logs", "access.jsonl");
    writeFileSync(log, logLine("/items/1", 900));
    const fixLauncher: FixLauncher = { provider: () => "fake", launch: async () => ({ workspaceId: "ws", worktree: null }) };
    const h = setup({ repo, yml: RULE(REPRO), engine: { checks: { "perf-slow": createPerfSlowCheck() }, fixLauncher } });
    await h.engine.tick();
    const ruleId = `${h.project.id}:perf-slow`;
    await h.engine.runNow(ruleId);
    expect(h.maintenanceCards()).toHaveLength(1);

    appendFileSync(log, logLine("/items/77", 950)); // same call site after id normalisation
    await h.engine.runNow(ruleId);
    expect(h.maintenanceCards()).toHaveLength(1);

    appendFileSync(log, logLine("/orders", 700));
    await h.engine.runNow(ruleId);
    const cards = h.maintenanceCards();
    expect(cards.map((c) => c.dedupeKey).sort()).toEqual(["perf-slow:api:get /items/:id", "perf-slow:api:get /orders"]);

    // nothing new: no run output at all
    const before = cards.length;
    await h.engine.runNow(ruleId);
    expect(h.maintenanceCards()).toHaveLength(before);
  }, 120_000);

  it("falls back to a draft card with the investigation notes when it cannot reproduce", async () => {
    const repo = slowRepo();
    write(repo, "fast-bench.js", "// nothing slow here\n");
    writeFileSync(join(repo, "logs", "access.jsonl"), logLine("/reports", 1200));
    const launches: string[] = [];
    const fixLauncher: FixLauncher = {
      provider: () => "fake",
      launch: async ({ cardKey }) => {
        launches.push(cardKey);
        return { workspaceId: "ws", worktree: null };
      },
    };
    const h = setup({
      repo,
      yml: RULE('      repro: { command: node, args: [fast-bench.js], runs: 2, threshold_ms: 5000 }'),
      engine: { checks: { "perf-slow": createPerfSlowCheck() }, fixLauncher },
    });
    await h.engine.tick();
    await h.engine.runNow(`${h.project.id}:perf-slow`);
    const [card] = h.maintenanceCards();
    expect(card).toMatchObject({ column: "draft", origin: "maintenance" });
    expect(card!.title).toContain("未复现");
    expect(card!.description).toContain("降级为草稿卡");
    expect(launches).toEqual([]);
  }, 120_000);

  it("is a draft when no repro command is configured, and reads incrementally", async () => {
    const repo = slowRepo();
    const log = join(repo, "logs", "access.jsonl");
    writeFileSync(log, logLine("/a", 5000));
    const h = setup({ repo, yml: RULE("", "suggest"), engine: { checks: { "perf-slow": createPerfSlowCheck() } } });
    await h.engine.tick();
    const ruleId = `${h.project.id}:perf-slow`;
    await h.engine.runNow(ruleId);
    expect(h.maintenanceCards()).toHaveLength(1);
    expect(h.maintenanceCards()[0]!.description).toContain("未配置 `repro`");
    // the same file again: the cursor moved past the old line, nothing is slow any more
    await h.engine.runNow(ruleId);
    expect(h.maintenanceCards()).toHaveLength(1);
    expect(h.store.events.list(h.maintenanceCards()[0]!.id).filter((e) => (e.body as { kind?: string }).kind === "recurrence")).toHaveLength(0);
  }, 120_000);
});
