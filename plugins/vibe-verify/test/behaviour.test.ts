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

// The default (Chinese) system prompts.
const ORIGINAL_VERIFIER_SYSTEM = `你是看板卡片的独立验证者。改动是另一个 agent 写的，不是你。
对仓库你是只读的：不要在工作树里编辑、创建、移动或删除文件，不要运行会改变状态的 git 命令（add、commit、checkout、reset、stash 等），不要安装依赖。你唯一可写的位置是任务里给出的输出目录。要判断改动实际做了什么，而不是它自称做了什么。`;
const ORIGINAL_REVIEWER_SYSTEM = `你是看板卡片的独立代码复核者。改动是另一个 agent 写的，不是你。
对仓库你是只读的：不要在工作树里编辑、创建、移动或删除文件，不要运行会改变状态的 git 命令，不要安装依赖。你可以读任何文件，也可以运行只读命令（git diff、git log、grep）。要复核改动实际做了什么。`;

/** The old buildFailurePrompt, kept here as the reference for the new templates. */
function legacyFailurePrompt(input: {
  source: "verifier" | "user";
  review?: boolean;
  comment?: string;
  failed: Array<{ text: string; note: string; evidenceFiles: string[] }>;
}): string {
  const head =
    input.source === "user"
      ? "你在 DEMO-1 上的工作被主人驳回了。"
      : input.review
        ? "对 DEMO-1（提交 abc123）的独立代码复核发现了严重问题（连同未通过的检查项一并列在下面），所以卡片被退回给你。"
        : "对 DEMO-1（提交 abc123）的独立验证发现有检查项未通过，所以卡片被退回给你。";
  const body = input.failed.length
    ? input.failed
        .map(
          (f) =>
            `- ${f.text}\n  发现：${f.note || "（无说明）"}${
              f.evidenceFiles.length ? `\n  证据：${f.evidenceFiles.join(", ")}` : ""
            }`,
        )
        .join("\n")
    : "";
  return [
    head,
    input.comment ? `主人评论：${input.comment}` : "",
    body ? `未通过的检查：\n${body}` : "",
    "请修复这些问题，运行项目的测试，然后结束本轮；卡片会被重新验证。",
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
    expect(setup).toContain("回复一个 JSON 对象");
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
    expect(setup).toContain("# 验证 DEMO-1（web 项目）- 第一轮：如何运行");
    expect(setup).toContain("基线工作树（改动前的代码，提交 def）：/base");
    expect(setup).toContain("1. page loads  （做法：open it）");
    expect(setup).toContain("请把上面的基线路径写进 web.baseline.path");
    expect(setup).toContain("仓库里已有 .vibe/verify.json");
    const judge = buildJudgePrompt({
      card,
      checks: [{ text: "page loads", method: "" }],
      commitHash: "abc",
      outputDir: "/o",
      evidence: [{ name: "a.log", kind: "log", excerpt: "x\ny" }],
      notes: ["n1"],
    });
    expect(judge).toContain("- a.log [log]\n    | x\n    | y");
    expect(judge).toContain("## 采集器备注\n- n1");
    expect(judge).toContain('要严格；没有证据不要给 "pass"。');
    const review = buildReviewPrompt({ card, worktree: "/w", commitHash: "abc", stat: "1 file", diff: "+x", truncated: true });
    expect(review).toContain("（未找到基线提交：只有未提交的改动）");
    expect(review).toContain("## Diff（已截断；其余部分请直接读文件）\n```diff\n+x\n```");
    expect(review).toContain('- "severe"（严重）：改动是错的或危险的');
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
