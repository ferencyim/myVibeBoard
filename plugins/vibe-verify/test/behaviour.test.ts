import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { textExcerpt, verificationLine } from "../server/pipeline";
import { VERIFY_PROMPT_DEFS, createVerifyPrompts, defaultPrompts } from "../server/prompts";
import { issueJudgement, reviewVerdict, ReviewSchema } from "../server/review";
import { DEFAULT_TUNING, tuningOf } from "../server/tuning";
import { createNodeServerLauncher } from "../server/collectors/common";
import { createVibeStore, migrateOwner, openVibeDb } from "../server/vibe/db";
import { verifySettings } from "../shared/settings";

describe("原生任务提示词注册表", () => {
  it("仅注册新流程与共用只读系统提示，固定格式保留在覆盖正文之后", () => {
    const db = openVibeDb({ path: ":memory:" });
    try {
      migrateOwner(db, "verify");
      const board = createVibeStore(db);
      const prompts = createVerifyPrompts(board);
      prompts.register();
      expect(
        board.prompts
          .list()
          .map((p) => p.key)
          .sort(),
      ).toEqual(VERIFY_PROMPT_DEFS.map((p) => p.key).sort());
      expect(VERIFY_PROMPT_DEFS.map((p) => p.key)).toEqual([
        "verify.task.evidence_scope",
        "verify.task.setup",
        "verify.task.judge",
        "verify.task.review",
        "verify.task.fix",
        "verify.verifier_system",
        "verify.reviewer_system",
      ]);
      board.prompts.setOverride("verify.task.setup", "当前任务 {{workspaceId}}");
      const setup = prompts.resolve("verify.task.setup", { vars: { workspaceId: "ws-one" } });
      expect(setup.startsWith("当前任务 ws-one")).toBe(true);
      expect(setup).toContain("回复一个 JSON 对象");
      expect(defaultPrompts.resolve("verify.reviewer_system")).toContain(
        "你是任务的独立代码复核者",
      );
    } finally {
      db.close();
    }
  });
  it("复核严重级别和验证摘要仍按当前证据计算", () => {
    expect(
      reviewVerdict(ReviewSchema.parse({ issues: [{ severity: "severe", text: "错误" }] })),
    ).toBe("severe");
    expect(
      verificationLine("doubt", [{ judgement: "pass" }, { judgement: "doubt" }], "abcd1234", false),
    ).toContain("通过 1 / 存疑 1 / 失败 0");
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
    expect(
      tuningOf({ ...unset, maxReviewReturns: 2 }, { VIBE_REVIEW_MAX_RETURNS: "5" })
        .maxReviewReturns,
    ).toBe(2);
    expect(
      tuningOf({ ...unset, maxReviewReturns: 0 }, { VIBE_REVIEW_MAX_RETURNS: "5" })
        .maxReviewReturns,
    ).toBe(0);
  });

  it("maps severities to judgements, and a fail needs return budget", () => {
    expect(issueJudgement("severe", true)).toBe("fail");
    expect(issueJudgement("severe", false)).toBe("doubt");
    expect(issueJudgement("major", true)).toBe("doubt");
    const map = tuningOf(
      { ...verifySettings.schema.parse({}), severityMinor: "pass", severityMajor: "fail" },
      {},
    ).severityMap;
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

  it("the dev-server wait defaults to the setting; verify.json wins", async () => {
    let started = 0;
    const launcher = createNodeServerLauncher({ readyTimeoutMs: () => 1 });
    const spec = {
      command: process.execPath,
      args: ["-e", "setTimeout(()=>{},3000)"],
      readyUrl: "http://127.0.0.1:9/",
    };
    started = Date.now();
    await expect(launcher.start(spec as never, process.cwd())).rejects.toThrow(/within 1ms/);
    expect(Date.now() - started).toBeLessThan(2500);
    await expect(
      launcher.start({ ...spec, readyTimeoutMs: 2 } as never, process.cwd()),
    ).rejects.toThrow(/within 2ms/);
  });
});
