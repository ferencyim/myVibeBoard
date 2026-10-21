// WP-99: the verification prompts come from the shared registry, their defaults equal the old
// hard-coded texts, and the former constants are settings with unchanged defaults.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { textExcerpt } from "../server/pipeline";
import { buildFailurePrompt, buildJudgePrompt, buildSetupPrompt } from "../server/pipeline/prompts";
import { VERIFY_PROMPT_DEFS, createVerifyPrompts, defaultPrompts } from "../server/prompts";
import { buildReviewPrompt, issueJudgement } from "../server/review";
import { DEFAULT_TUNING, tuningOf } from "../server/tuning";
import { pickProvider, createPaseoVerifierLauncher } from "../server/verifier/agent";
import { createNodeServerLauncher } from "../server/collectors/common";
import { createVibeStore, migrateOwner, openVibeDb } from "../server/vibe/db";
import { verifySettings } from "../shared/settings";

const store = () => {
  const db = openVibeDb({ path: ":memory:" });
  migrateOwner(db, "verify");
  return createVibeStore(db);
};
const card = { id: "c1", key: "DEMO-1", title: "Add greeting", description: "Say hi", acceptance: "works", projectId: "p1" } as never;

// The texts as they were hard-coded before the registry (server/verifier/agent.ts, review/index.ts).
const ORIGINAL_VERIFIER_SYSTEM = `You are an independent verifier for a kanban card. Another agent wrote the change; you did not.
You are READ-ONLY with respect to the repository: never edit, create, move or delete files in the working tree, never run git commands that change state (add, commit, checkout, reset, stash, ...), never install dependencies. Your only writable location is the output directory given in the task. Judge what the change actually does, not what it claims.`;
const ORIGINAL_REVIEWER_SYSTEM = `You are an independent code reviewer for a kanban card. Another agent wrote the change; you did not.
You are READ-ONLY with respect to the repository: never edit, create, move or delete files in the working tree, never run git commands that change state, never install dependencies. You may read any file and run read-only commands (git diff, git log, grep). Review what the change actually does.`;

/** The old buildFailurePrompt, kept here as the reference for the new templates. */
function legacyFailurePrompt(input: {
  source: "verifier" | "user";
  review?: boolean;
  comment?: string;
  failed: Array<{ text: string; note: string; evidenceFiles: string[] }>;
}): string {
  const head =
    input.source === "user"
      ? "Your work on DEMO-1 was rejected by the user."
      : input.review
        ? "Independent code review of DEMO-1 (commit abc123) found severe problems (listed below together with any failing checks), so the card was sent back to you."
        : "Independent verification of DEMO-1 (commit abc123) found failing checks, so the card was sent back to you.";
  const body = input.failed.length
    ? input.failed
        .map(
          (f) =>
            `- ${f.text}\n  Finding: ${f.note || "(no note)"}${
              f.evidenceFiles.length ? `\n  Evidence: ${f.evidenceFiles.join(", ")}` : ""
            }`,
        )
        .join("\n")
    : "";
  return [
    head,
    input.comment ? `User comment: ${input.comment}` : "",
    body ? `Failed checks:\n${body}` : "",
    "Fix the problems, run the project's tests, and finish your round; the card will be verified again.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

describe("prompt registry", () => {
  it("registers every verification prompt with its metadata", () => {
    const board = store();
    createVerifyPrompts(board).register();
    const listed = board.prompts.list();
    expect(listed.map((p) => p.key).sort()).toEqual(
      [
        "verify.judge",
        "verify.review",
        "verify.reviewer_system",
        "verify.send_back.review",
        "verify.send_back.user",
        "verify.send_back.verifier",
        "verify.setup",
        "verify.verifier_system",
      ].sort(),
    );
    for (const p of listed) {
      expect(p.plugin).toBe("vibe-verify");
      expect(p.title && p.description && p.whenSent && p.audience).toBeTruthy();
    }
    expect(VERIFY_PROMPT_DEFS).toHaveLength(8);
  });

  it("the system prompts resolve to the old hard-coded texts", () => {
    const board = store();
    const prompts = createVerifyPrompts(board);
    prompts.register();
    expect(prompts.resolve("verify.verifier_system")).toBe(ORIGINAL_VERIFIER_SYSTEM);
    expect(prompts.resolve("verify.reviewer_system")).toBe(ORIGINAL_REVIEWER_SYSTEM);
    expect(defaultPrompts.resolve("verify.verifier_system")).toBe(ORIGINAL_VERIFIER_SYSTEM);
  });

  it("the send-back messages equal the old builder for every variant", () => {
    const failed = [
      { text: "[severe] login", note: "500", evidenceFiles: ["a.png", "b.log"] },
      { text: "second", note: "", evidenceFiles: [] },
    ];
    const variants = [
      { source: "verifier" as const, failed },
      { source: "verifier" as const, review: true, failed },
      { source: "user" as const, comment: "no good", failed },
      { source: "user" as const, comment: "no good", failed: [] },
      { source: "verifier" as const, failed: [] },
    ];
    for (const v of variants) {
      expect(buildFailurePrompt({ card, commitHash: "abc123", ...v })).toBe(legacyFailurePrompt(v));
    }
  });

  it("the reply formats are fixed: they stay after an overridden body", () => {
    const board = store();
    const prompts = createVerifyPrompts(board);
    prompts.register();
    for (const key of ["verify.setup", "verify.judge", "verify.review"]) {
      board.prompts.setOverride(key, "MY OWN {{card.key}}");
    }
    const setup = buildSetupPrompt({
      card,
      projectType: "web",
      worktree: "/w",
      commitHash: "abc",
      outputDir: "/o",
      checks: [{ text: "page loads", method: "open it" }],
      existingConfig: false,
      prompts,
    });
    expect(setup.startsWith("MY OWN DEMO-1")).toBe(true);
    expect(setup).toContain("Reply with ONE JSON object");
    expect(setup).toContain('"web"'); // the VerifyConfig JSON Schema
    const judge = buildJudgePrompt({ card, checks: [], commitHash: "abc", outputDir: "/o", evidence: [], notes: [], prompts });
    expect(judge.startsWith("MY OWN DEMO-1")).toBe(true);
    expect(judge).toContain('"judgement": "pass|doubt|fail"');
    const review = buildReviewPrompt({ card, worktree: "/w", commitHash: "abc", stat: "", diff: "", truncated: false, prompts });
    expect(review.startsWith("MY OWN DEMO-1")).toBe(true);
    expect(review).toContain('"verdict": "pass|issues|severe"');
  });

  it("a project override applies to that project's cards only", () => {
    const board = store();
    const prompts = createVerifyPrompts(board);
    prompts.register();
    const one = board.projects.create({ name: "One", prefix: "ONE", repoPath: "/r1", projectType: "backend" });
    const two = board.projects.create({ name: "Two", prefix: "TWO", repoPath: "/r2", projectType: "backend" });
    board.prompts.setOverride("verify.verifier_system", "Strict verifier", { projectId: one.id });
    expect(prompts.resolve("verify.verifier_system", { projectId: one.id })).toBe("Strict verifier");
    expect(prompts.resolve("verify.verifier_system", { projectId: two.id })).toBe(ORIGINAL_VERIFIER_SYSTEM);
  });

  it("the default setup / judge / review texts keep their content", () => {
    const setup = buildSetupPrompt({
      card,
      projectType: "web",
      worktree: "/w",
      commitHash: "abc",
      outputDir: "/o",
      checks: [{ text: "page loads", method: "open it" }],
      baselinePath: "/base",
      baselineCommit: "def",
      existingConfig: true,
    });
    expect(setup).toContain("# Verify DEMO-1 (web project) - round 1: how to run it");
    expect(setup).toContain("Baseline worktree (the code before the change, commit def): /base");
    expect(setup).toContain("1. page loads  (how: open it)");
    expect(setup).toContain("Put the baseline path above in web.baseline.path");
    expect(setup).toContain("already contains .vibe/verify.json");
    const judge = buildJudgePrompt({
      card,
      checks: [{ text: "page loads", method: "" }],
      commitHash: "abc",
      outputDir: "/o",
      evidence: [{ name: "a.log", kind: "log", excerpt: "x\ny" }],
      notes: ["n1"],
    });
    expect(judge).toContain("- a.log [log]\n    | x\n    | y");
    expect(judge).toContain("## Collector notes\n- n1");
    expect(judge).toContain('Be strict; do not give "pass" without evidence.');
    const review = buildReviewPrompt({ card, worktree: "/w", commitHash: "abc", stat: "1 file", diff: "+x", truncated: true });
    expect(review).toContain("(no base commit found: uncommitted changes only)");
    expect(review).toContain("## Diff (truncated; read the files for the rest)\n```diff\n+x\n```");
    expect(review).toContain('- "severe": the change is wrong or dangerous');
  });
});

describe("settings", () => {
  it("default settings equal the old constants", () => {
    expect(tuningOf(verifySettings.schema.parse({}), {})).toEqual({
      autoReturnOnFail: true,
      maxReviewReturns: 3,
      severityMap: { severe: "fail", major: "doubt", minor: "doubt" },
      preferDifferentProvider: true,
      roundTimeoutMs: 20 * 60_000,
      excerptChars: 6000,
      readyTimeoutMs: 60_000,
      worktreeRoot: "",
    });
    expect(tuningOf(verifySettings.schema.parse({}), {})).toEqual(DEFAULT_TUNING);
  });

  it("VIBE_REVIEW_MAX_RETURNS is the initial value while the setting is unset", () => {
    const unset = verifySettings.schema.parse({});
    expect(tuningOf(unset, { VIBE_REVIEW_MAX_RETURNS: "5" }).maxReviewReturns).toBe(5);
    expect(tuningOf(unset, { VIBE_REVIEW_MAX_RETURNS: "nope" }).maxReviewReturns).toBe(3);
    expect(tuningOf({ ...unset, maxReviewReturns: 2 }, { VIBE_REVIEW_MAX_RETURNS: "5" }).maxReviewReturns).toBe(2);
    expect(tuningOf({ ...unset, maxReviewReturns: 0 }, { VIBE_REVIEW_MAX_RETURNS: "5" }).maxReviewReturns).toBe(0);
  });

  it("maps severities to judgements, and a fail needs return budget", () => {
    expect(issueJudgement("severe", true)).toBe("fail");
    expect(issueJudgement("severe", false)).toBe("doubt");
    expect(issueJudgement("major", true)).toBe("doubt");
    const map = tuningOf({ ...verifySettings.schema.parse({}), severityMinor: "pass", severityMajor: "fail" }, {}).severityMap;
    expect(issueJudgement("minor", true, map)).toBe("pass");
    expect(issueJudgement("major", true, map)).toBe("fail");
    expect(issueJudgement("major", false, map)).toBe("doubt");
  });

  it("the excerpt length is configurable", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "vibe-excerpt-")), "a.log");
    writeFileSync(file, "a".repeat(100));
    expect(textExcerpt(file, "log", 6000)).toBe("a".repeat(100));
    expect(textExcerpt(file, "log", 40)).toBe(`${"a".repeat(20)}\n...[cut]...\n${"a".repeat(20)}`);
    expect(textExcerpt(file, "screenshot", 40)).toBeUndefined();
  });

  it("the provider policy can prefer the worker's own provider", () => {
    const presets = [
      { provider: "claude", model: "a" },
      { provider: "codex", model: "b" },
    ] as never;
    const input = { card, project: {} as never, workerProvider: "claude", presets };
    expect(pickProvider(() => true)(input)).toEqual({ provider: "codex", model: "b" });
    expect(pickProvider(() => false)(input)).toEqual({ provider: "claude", model: "a" });
    expect(pickProvider(() => true)({ ...input, presets: [presets[0]] })).toEqual({ provider: "claude", model: "a" });
  });

  it("the launcher reads the round timeout and the system prompt at launch time", async () => {
    let timeout = 0;
    const paseo = {
      agents: {
        create: async (options: { config: { systemPrompt: string } }) => {
          created.push(options.config.systemPrompt);
          return {
            run: async (_p: string, o: { timeoutMs: number }) => ((timeout = o.timeoutMs), { status: "idle", lastMessage: "" }),
            archive: async () => {},
          };
        },
      },
    } as never;
    const created: string[] = [];
    const launcher = createPaseoVerifierLauncher({
      getPaseo: () => paseo,
      roundTimeoutMs: () => 5 * 60_000,
      prompts: { resolve: (key) => `text of ${key}` },
    });
    const agent = await launcher.launch({
      card,
      project: { id: "p1" } as never,
      provider: "codex",
      model: "m",
      cwd: "/x",
      workspaceId: null,
      outputDir: "/o",
      role: "reviewer",
    });
    await agent.run("hi");
    expect(timeout).toBe(5 * 60_000);
    expect(created).toEqual(["text of verify.reviewer_system"]);
  });

  it("the dev-server wait defaults to the setting; verify.json wins", async () => {
    let started = 0;
    const launcher = createNodeServerLauncher({ readyTimeoutMs: () => 1 });
    const spec = { command: process.execPath, args: ["-e", "setTimeout(()=>{},3000)"], readyUrl: "http://127.0.0.1:9/" };
    started = Date.now();
    await expect(launcher.start(spec as never, process.cwd())).rejects.toThrow(/within 1ms/);
    expect(Date.now() - started).toBeLessThan(2500);
    await expect(launcher.start({ ...spec, readyTimeoutMs: 2 } as never, process.cwd())).rejects.toThrow(/within 2ms/);
  });
});
