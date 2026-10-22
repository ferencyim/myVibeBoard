import { mkdirSync, mkdtempSync, writeFileSync, readdirSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createPipeline } from "../server/pipeline";
import { splitChecks } from "../server/pipeline/checks";
import { createVerifyStore } from "../server/store";
import type { RunConfigs } from "../server/registry";
import type { VerifierLauncher } from "../server/verifier/agent";
import { decideVerifierPermission, isMutatingShell } from "../server/verifier/policy";
import {
  createCollectorRegistry,
  createScriptedRunner,
  type EvidenceCollector,
  type RunCall,
} from "../server/vibe/contract";
import { createVibeStore, migrateOwner, openVibeDb } from "../server/vibe/db";
import { writeArtifact } from "../server/collectors/common";

const dirs: string[] = [];
const temp = (prefix: string) => {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const dir of dirs) {
    try {
      for (const name of readdirSync(dir)) {
        try {
          unlinkSync(path.join(dir, name));
        } catch {
          // sub-directory: leave it
        }
      }
      rmdirSync(dir);
    } catch {
      // best effort
    }
  }
});

interface Harness {
  board: ReturnType<typeof createVibeStore>;
  verify: ReturnType<typeof createVerifyStore>;
  pipeline: ReturnType<typeof createPipeline>;
  cardId: string;
  sent: Array<{ agentId: string; prompt: string }>;
  launched: number;
  /** Provider of every verifier launch. */
  providers: string[];
  runnerCalls: RunCall[];
  worktree: string;
  seenConfig?: { backend?: { perf?: { baseline?: { path: string; commitHash?: string } } } };
}

function setup(options: {
  needsEvidence: boolean;
  acceptance?: string;
  verdict?: (n: number) => unknown;
  /** status output per git status call (before/after pairs) */
  statuses?: string[];
  testExit?: number;
  hasTestScript?: boolean;
  /** the verifier answers in its reply instead of writing files */
  reply?: boolean;
  /** the worker wrote a backend.perf block into the worktree's .vibe/verify.json */
  perf?: boolean;
  /** WP-108: the card's verification model / the global default one */
  verifierPreset?: "card" | "global";
}): Harness {
  const db = openVibeDb({ path: ":memory:" });
  migrateOwner(db, "verify");
  const board = createVibeStore(db);
  const verify = createVerifyStore(db, { root: temp("vibe-verify-store-") });
  const worktree = temp("vibe-wt-");
  if (options.hasTestScript) {
    writeFileSync(path.join(worktree, "package.json"), JSON.stringify({ scripts: { test: "x" } }));
  }
  if (options.perf) {
    mkdirSync(path.join(worktree, ".vibe"), { recursive: true });
    writeFileSync(
      path.join(worktree, ".vibe", "verify.json"),
      JSON.stringify({ backend: { perf: { label: "GET /x", command: "node", args: ["bench.js"], thresholdMs: 100 } } }),
    );
  }
  const project = board.projects.create({
    name: "P",
    prefix: "PRD",
    repoPath: worktree,
    projectType: "backend",
  });
  const card = board.cards.create({
    projectId: project.id,
    title: "Add greeting endpoint",
    acceptance: "- [ ] GET /hello returns 200\n- [ ] body says hello",
    needsEvidence: options.needsEvidence,
    column: "todo",
  });
  board.cards.dispatch({
    cardId: card.id,
    agentId: "worker-1",
    workspaceId: "ws-1",
    provider: "claude",
    worktree,
  });
  board.cards.move(card.id, { to: "verifying", actor: "lifecycle" });

  const statuses = [...(options.statuses ?? [])];
  const runner = createScriptedRunner((call) => {
    if (call.command === "git" && call.args[0] === "rev-parse") return { stdout: "deadbeefcafe\n" };
    if (call.command === "git" && call.args[0] === "merge-base") return { stdout: "base1111\n" };
    if (call.command === "git" && call.args[0] === "status") return { stdout: statuses.shift() ?? "" };
    if (call.command === "npm") return { exitCode: options.testExit ?? 0, stdout: "tests ran" };
    return undefined;
  });

  const configs: RunConfigs = new Map();
  const harness = { sent: [] as Harness["sent"], launched: 0, providers: [] as string[] } as Harness;
  const collector: EvidenceCollector = {
    id: "fake-backend",
    projectTypes: ["backend"],
    detect: async () => ({ available: true }),
    collect: async (ctx) => {
      harness.seenConfig = configs.get(ctx.verificationId) as Harness["seenConfig"];
      return {
      artifacts: [writeArtifact(ctx, "report", "samples.json", "{}", "request samples")],
      judgement: "pass",
      notes: ["1/1 request sample(s) matched"],
      degraded: false,
      };
    },
  };
  const registry = createCollectorRegistry();
  registry.register(collector);

  if (options.verifierPreset) {
    const preset = board.presets.create({ name: "Verifier", provider: "kimi", model: "k2", roleHints: ["verifier"] });
    if (options.verifierPreset === "card") board.cards.update(card.id, { verifierPresetId: preset.id });
    else board.modelDefaults.setGlobal({ verifier: preset.id });
  }

  const launcher: VerifierLauncher = {
    async launch(input) {
      harness.launched++;
      harness.providers.push(input.provider);
      mkdirSync(input.outputDir, { recursive: true });
      return {
        agentId: "verifier-1",
        provider: input.provider,
        async run(prompt) {
          // The judge round asks for "judgement"s; the setup round (evidence mode only) does not.
          const round = prompt.includes("judgement") ? 2 : 1;
          if (options.reply) {
            const json = round === 1 ? { backend: { requests: [] } } : (options.verdict?.(2) ?? { items: [] });
            return { status: "idle" as const, text: ["Here you go:", "```json", JSON.stringify(json), "```"].join(String.fromCharCode(10)) };
          }
          if (round === 1) {
            writeFileSync(
              path.join(input.outputDir, "verify.json"),
              JSON.stringify({ backend: { requests: [] } }),
            );
          } else {
            writeFileSync(
              path.join(input.outputDir, "verdict.json"),
              JSON.stringify(options.verdict?.(2) ?? { items: [] }),
            );
          }
          return { status: "idle" as const, text: "done" };
        },
        close: async () => {},
      };
    },
  };

  const pipeline = createPipeline({
    board,
    verify,
    registry,
    runner,
    launcher,
    configs,
    notifyWorker: async (agentId, prompt) => {
      harness.sent.push({ agentId, prompt });
      return true;
    },
    worktreeRoot: temp("vibe-base-"),
    log: () => {},
  });
  Object.assign(harness, {
    board,
    verify,
    pipeline,
    cardId: card.id,
    runnerCalls: runner.calls,
    worktree,
  });
  return harness;
}

const passing = {
  items: [
    { check: 1, judgement: "pass", note: "200 seen", evidence: ["samples.json"] },
    { check: 2, judgement: "pass", note: "hello in body", evidence: [] },
  ],
};

describe("verification pipeline", () => {
  it("all checks pass: verification=pass, evidence stamped with commit and time, card stays verifying", async () => {
    const h = setup({ needsEvidence: true, verdict: () => passing });
    const result = await h.pipeline.run(h.cardId);
    expect(result).toMatchObject({ conclusion: "pass", returned: false, voided: false });
    const detail = h.verify.detail(result!.verificationId)!;
    expect(detail.summary).toBe("All checks passed");
    expect(detail.verification.commitHash).toBe("deadbeefcafe");
    expect(detail.items.filter((i) => i.method !== "auto").map((i) => i.judgement)).toEqual([
      "pass",
      "pass",
    ]);
    expect(detail.items[0]!.evidenceIds).toHaveLength(1);
    expect(detail.evidence.length).toBeGreaterThan(0);
    for (const e of detail.evidence) {
      expect(e.commitHash).toBe("deadbeefcafe");
      expect(Date.parse(e.capturedAt)).not.toBeNaN();
    }
    expect(h.board.cards.get(h.cardId)!.column).toBe("verifying");
    expect(h.board.sessions.list({ cardId: h.cardId, role: "verifier" })).toHaveLength(1);
    // the verifier is not the worker session
    expect(detail.verification.verifierAgentId).toBe("verifier-1");
  });

  it("a deliberately wrong task is sent back with the failing evidence as the next prompt", async () => {
    const h = setup({
      needsEvidence: true,
      verdict: () => ({
        items: [
          { check: 1, judgement: "fail", note: "GET /hello returned 404", evidence: ["samples.json"] },
          { check: 2, judgement: "pass", note: "n/a", evidence: [] },
        ],
      }),
    });
    const result = await h.pipeline.run(h.cardId);
    expect(result).toMatchObject({ conclusion: "fail", returned: true });
    expect(h.board.cards.get(h.cardId)!.column).toBe("in_progress");
    const moved = h.board.events.list(h.cardId);
    expect(moved.some((e) => e.type === "reject" && e.author === "verifier")).toBe(true);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.agentId).toBe("worker-1");
    expect(h.sent[0]!.prompt).toContain("GET /hello returns 200");
    expect(h.sent[0]!.prompt).toContain("GET /hello returned 404");
    expect(h.sent[0]!.prompt).toContain("samples.json");
  });

  it("keeps the worker's backend.perf block and adds the baseline worktree to it", async () => {
    const h = setup({ needsEvidence: true, reply: true, perf: true, verdict: () => passing });
    await h.pipeline.run(h.cardId);
    expect(h.seenConfig?.backend?.perf).toMatchObject({
      label: "GET /x",
      thresholdMs: 100,
      baseline: { commitHash: "base1111" },
    });
    expect(h.runnerCalls.some((c) => c.command === "git" && c.args[0] === "worktree" && c.args[1] === "add")).toBe(true);
  });

  it("reads the verdict from the verifier reply when it writes no file", async () => {
    const h = setup({ needsEvidence: true, reply: true, verdict: () => passing });
    const result = await h.pipeline.run(h.cardId);
    expect(result!.conclusion).toBe("pass");
  });

  it("needs_evidence=false: tests and lint, no collectors; the verification model judges the checks on them (WP-108)", async () => {
    const h = setup({
      needsEvidence: false,
      hasTestScript: true,
      verifierPreset: "card",
      verdict: () => ({ items: [{ check: 1, judgement: "pass" }, { check: 2, judgement: "pass" }] }),
    });
    const result = await h.pipeline.run(h.cardId);
    expect(result!.conclusion).toBe("pass");
    expect(h.launched).toBe(1);
    expect(h.providers).toEqual(["kimi"]);
    const detail = h.verify.detail(result!.verificationId)!;
    expect(detail.verification.mode).toBe("tests_only");
    expect(detail.items.map((i) => i.checkText)).toEqual(["GET /hello returns 200", "body says hello", "Tests pass"]);
    expect(detail.notes.join(" ")).toContain("验证模型：Verifier");
    expect(h.runnerCalls.some((c) => c.command === "npm")).toBe(true);
  });

  it("WP-108: evidence mode uses the global default verification model; without any it picks one and says so", async () => {
    const withDefault = setup({ needsEvidence: true, verifierPreset: "global", verdict: () => passing });
    await withDefault.pipeline.run(withDefault.cardId);
    expect(withDefault.providers).toEqual(["kimi"]);
    const without = setup({ needsEvidence: false, hasTestScript: true });
    const result = await without.pipeline.run(without.cardId);
    expect(without.launched).toBe(1);
    expect(without.verify.detail(result!.verificationId)!.notes.join(" ")).toContain("没有选验证模型");
  });

  it("failing tests in tests_only mode send the card back", async () => {
    const h = setup({ needsEvidence: false, hasTestScript: true, testExit: 1, verifierPreset: "card" });
    const result = await h.pipeline.run(h.cardId);
    expect(result).toMatchObject({ conclusion: "fail", returned: true });
    expect(h.board.cards.get(h.cardId)!.column).toBe("in_progress");
    expect(h.sent[0]!.prompt).toContain("Tests pass");
  });

  it("a verifier that changes the tree voids the evidence and is not blamed on the worker", async () => {
    const h = setup({
      needsEvidence: true,
      verdict: () => passing,
      // round 1 before/after identical, round 2 before empty, after dirty
      statuses: ["", "", "", " M src/app.ts"],
    });
    const result = await h.pipeline.run(h.cardId);
    expect(result).toMatchObject({ conclusion: "doubt", voided: true, returned: false });
    expect(h.verify.detail(result!.verificationId)!.notes.join(" ")).toContain("modified the code");
    expect(h.board.cards.get(h.cardId)!.column).toBe("verifying");
  });

  it("user reject and approve", async () => {
    const h = setup({ needsEvidence: true, verdict: () => passing });
    await h.pipeline.run(h.cardId);
    expect(await h.pipeline.reject(h.cardId, "button is the wrong colour")).toBe(true);
    expect(h.board.cards.get(h.cardId)!.column).toBe("in_progress");
    expect(h.sent[0]!.prompt).toContain("button is the wrong colour");
    h.board.cards.move(h.cardId, { to: "verifying", actor: "lifecycle" });
    h.pipeline.approve(h.cardId);
    expect(h.board.cards.get(h.cardId)!.column).toBe("done");
  });
});

describe("check splitting and read-only policy", () => {
  it("splits acceptance criteria per line and strips bullets", () => {
    const h = setup({ needsEvidence: true });
    const card = h.board.cards.get(h.cardId)!;
    expect(splitChecks(card).map((c) => c.text)).toEqual(["GET /hello returns 200", "body says hello"]);
    expect(splitChecks({ ...card, acceptance: "" })[0]!.text).toContain(card.title);
  });

  const req = (detail: unknown, kind = "tool") =>
    ({ id: "r", provider: "claude", name: "x", kind, detail }) as never;
  it("allows reads, denies writes outside the output dir and mutating shell", () => {
    const ctx = { outputDir: path.resolve("/tmp/out") };
    const allowed = (d: unknown, kind?: string) =>
      decideVerifierPermission(req(d, kind), ctx).behavior === "allow";
    expect(allowed({ type: "read", filePath: "/repo/a.ts" })).toBe(true);
    expect(allowed({ type: "edit", filePath: "/repo/a.ts" })).toBe(false);
    expect(allowed({ type: "write", filePath: path.join(ctx.outputDir, "verdict.json") })).toBe(true);
    expect(allowed({ type: "write", filePath: path.join(ctx.outputDir, "..", "evil") })).toBe(false);
    expect(allowed({ type: "shell", command: "git status --porcelain" })).toBe(true);
    expect(allowed({ type: "shell", command: "git checkout -- src" })).toBe(false);
    expect(allowed({ type: "shell", command: "echo hi > file.txt" })).toBe(false);
    expect(allowed({ type: "shell", command: "cat a.ts 2>&1" })).toBe(true);
    expect(allowed(undefined, "question")).toBe(false);
    expect(isMutatingShell("npm test")).toBe(false);
    expect(isMutatingShell("rm -rf x")).toBe(true);
  });
});
