import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createPipeline, returnReason, verificationLine } from "../server/pipeline";
import { reviewChatText } from "../server/review";
import { DEFAULT_TUNING, type VerifyTuning } from "../server/tuning";
import { createVerifyStore } from "../server/store";
import type { LaunchInput, VerifierLauncher } from "../server/verifier/agent";
import { createCollectorRegistry, createScriptedRunner } from "../server/vibe/contract";
import { createVibeStore, migrateOwner, openVibeDb } from "../server/vibe/db";

const temp = (prefix: string) => mkdtempSync(path.join(tmpdir(), prefix));

const json = (v: unknown) => ["```json", JSON.stringify(v), "```"].join("\n");
const severe = {
  verdict: "severe",
  summary: "Null deref",
  issues: [{ severity: "severe", file: "src/a.ts", line: 12, text: "user may be undefined" }],
};
const minor = {
  verdict: "issues",
  summary: "Nit",
  issues: [{ severity: "minor", text: "rename x" }],
};
const clean = { verdict: "pass", summary: "Looks fine", issues: [] };

function setup(options: {
  maxReviewReturns?: number;
  replies: unknown[];
  reviewer?: boolean;
  launchNote?: string;
  tuning?: Partial<VerifyTuning>;
}) {
  const db = openVibeDb({ path: ":memory:" });
  migrateOwner(db, "verify");
  const board = createVibeStore(db);
  const verify = createVerifyStore(db, { root: temp("vibe-review-store-") });
  const worktree = temp("vibe-review-wt-");
  writeFileSync(path.join(worktree, "package.json"), JSON.stringify({ scripts: { test: "x" } }));
  const project = board.projects.create({ name: "P", prefix: "RVW", repoPath: worktree, projectType: "backend" });
  const preset = board.presets.create({ name: "Reviewer", provider: "codex", model: "gpt-x", roleHint: "reviewer" });
  const card = board.cards.create({
    projectId: project.id,
    title: "Add greeting",
    acceptance: "- [ ] works",
    needsEvidence: false,
    column: "todo",
    reviewerPresetId: options.reviewer === false ? null : preset.id,
  });
  board.cards.dispatch({ cardId: card.id, agentId: "worker-1", workspaceId: "ws-1", provider: "claude", worktree });
  board.cards.move(card.id, { to: "verifying", actor: "lifecycle" });

  const launched: LaunchInput[] = [];
  const prompts: string[] = [];
  const replies = [...options.replies];
  const launcher: VerifierLauncher = {
    async launch(input) {
      launched.push(input);
      return {
        agentId: `reviewer-${launched.length}`,
        provider: input.provider,
        note: options.launchNote,
        run: async (prompt) => {
          prompts.push(prompt);
          const reply = replies.shift();
          return { status: "idle" as const, text: typeof reply === "string" ? reply : json(reply) };
        },
        close: async () => {},
      };
    },
  };
  const sent: Array<{ agentId: string; prompt: string }> = [];
  const runner = createScriptedRunner((call) => {
    if (call.command === "git" && call.args[0] === "rev-parse") return { stdout: "deadbeef\n" };
    if (call.command === "git" && call.args[0] === "merge-base") return { stdout: "base1111\n" };
    if (call.command === "git" && call.args[0] === "diff") return { stdout: "+const x = user.name;\n" };
    if (call.command === "npm") return { exitCode: 0, stdout: "ok" };
    return undefined;
  });
  const pipeline = createPipeline({
    board,
    verify,
    registry: createCollectorRegistry(),
    runner,
    launcher,
    configs: new Map(),
    notifyWorker: async (agentId, prompt) => {
      sent.push({ agentId, prompt });
      return true;
    },
    worktreeRoot: temp("vibe-review-base-"),
    tuning: () => ({ ...DEFAULT_TUNING, maxReviewReturns: options.maxReviewReturns ?? 3, ...options.tuning }),
    log: () => {},
  });
  /** Worker finishes its fix: back to verifying. */
  const reenter = () => board.cards.move(card.id, { to: "verifying", actor: "lifecycle" });
  const events = (type: string) =>
    (db.prepare("SELECT payload_json FROM vibe_event WHERE type = ? ORDER BY seq").all(type) as Array<{ payload_json: string }>).map(
      (r) => JSON.parse(r.payload_json) as Record<string, unknown>,
    );
  return { board, verify, pipeline, cardId: card.id, launched, prompts, sent, reenter, events, preset };
}

describe("model review", () => {
  it("records the launcher's note about a filled-in default model in the verification notes", async () => {
    const h = setup({ replies: [clean], launchNote: "The preset has no model; using codex's default model gpt-5." });
    const result = await h.pipeline.run(h.cardId);
    expect(h.verify.detail(result!.verificationId)!.notes.join(" ")).toContain("using codex's default model gpt-5");
  });

  it("a severe issue sends the card back to the worker with the review text", async () => {
    const h = setup({ replies: [severe] });
    const result = await h.pipeline.run(h.cardId);
    expect(result).toMatchObject({ conclusion: "fail", returned: true });
    expect(h.board.cards.get(h.cardId)!.column).toBe("in_progress");
    expect(h.launched[0]).toMatchObject({ provider: "codex", model: "gpt-x", role: "reviewer" });
    expect(h.prompts[0]).toContain("+const x = user.name;");
    expect(h.prompts[0]).toContain("diff against base1111");
    expect(h.sent[0]!.agentId).toBe("worker-1");
    expect(h.sent[0]!.prompt).toContain("user may be undefined");
    expect(h.sent[0]!.prompt).toContain("src/a.ts:12");
    const items = h.verify.items(result!.verificationId).filter((i) => i.kind === "review");
    expect(items).toMatchObject([{ method: "review:severe", judgement: "fail", note: "src/a.ts:12" }]);
    expect(h.board.events.list(h.cardId).some((e) => e.type === "reject" && e.author === "verifier")).toBe(true);
    expect(h.events("review.started")).toHaveLength(1);
    expect(h.events("review.finished")[0]).toMatchObject({ verdict: "severe", issues: ["[severe] src/a.ts:12 user may be undefined"] });
  });

  it("major/minor issues only make the verification doubtful and stay with the user", async () => {
    const h = setup({ replies: [minor] });
    const result = await h.pipeline.run(h.cardId);
    expect(result).toMatchObject({ conclusion: "doubt", returned: false });
    expect(h.board.cards.get(h.cardId)!.column).toBe("verifying");
    expect(h.sent).toHaveLength(0);
    expect(h.events("review.finished")[0]).toMatchObject({ verdict: "issues" });
  });

  it("a clean review does not affect the conclusion", async () => {
    const h = setup({ replies: [clean] });
    const result = await h.pipeline.run(h.cardId);
    expect(result).toMatchObject({ conclusion: "pass", returned: false });
    const review = h.verify.items(result!.verificationId).filter((i) => i.kind === "review");
    expect(review).toMatchObject([{ judgement: "pass", note: "Looks fine" }]);
    expect(h.events("review.finished")[0]).toMatchObject({ verdict: "pass" });
  });

  it("no reviewer preset on the card: no review agent", async () => {
    const h = setup({ replies: [], reviewer: false });
    await h.pipeline.run(h.cardId);
    expect(h.launched).toHaveLength(0);
    expect(h.events("review.started")).toHaveLength(0);
  });

  it("after the worker's fix the change is reviewed again", async () => {
    const h = setup({ replies: [severe, clean] });
    await h.pipeline.run(h.cardId);
    h.reenter();
    const second = await h.pipeline.run(h.cardId);
    expect(second).toMatchObject({ conclusion: "pass", returned: false });
    expect(h.launched).toHaveLength(2);
    expect(h.events("review.started")).toHaveLength(2);
    expect(h.board.cards.get(h.cardId)!.column).toBe("verifying");
  });

  it("stops returning after the limit: severe becomes doubtful and an alert is raised", async () => {
    const h = setup({ maxReviewReturns: 2, replies: [severe, severe, severe] });
    expect(await h.pipeline.run(h.cardId)).toMatchObject({ returned: true });
    h.reenter();
    expect(await h.pipeline.run(h.cardId)).toMatchObject({ returned: true });
    h.reenter();
    const third = await h.pipeline.run(h.cardId);
    expect(third).toMatchObject({ conclusion: "doubt", returned: false });
    expect(h.board.cards.get(h.cardId)!.column).toBe("verifying");
    expect(h.sent).toHaveLength(2);
    expect(h.events("master.alert")).toMatchObject([{ kind: "review_loop" }]);
    expect(h.events("review.finished")[2]).toMatchObject({ verdict: "severe" });
  });

  it("autoReturnOnFail off: a severe review stays a failed verification and the card stays in verifying", async () => {
    const h = setup({ replies: [severe], tuning: { autoReturnOnFail: false } });
    const result = await h.pipeline.run(h.cardId);
    expect(result).toMatchObject({ conclusion: "fail", returned: false });
    expect(h.board.cards.get(h.cardId)!.column).toBe("verifying");
    expect(h.sent).toHaveLength(0);
    expect(h.events("master.alert")).toHaveLength(0);
  });

  it("autoReturnOnFail off does not stop the owner's own rejection", async () => {
    const h = setup({ replies: [clean], tuning: { autoReturnOnFail: false } });
    await h.pipeline.run(h.cardId);
    expect(await h.pipeline.reject(h.cardId, "not good")).toBe(true);
    expect(h.board.cards.get(h.cardId)!.column).toBe("in_progress");
    expect(h.sent[0]!.prompt).toContain("rejected by the user");
  });

  it("the severity map decides the judgement: severe -> doubt keeps the card, major -> fail sends it back", async () => {
    const lenient = setup({
      replies: [severe],
      tuning: { severityMap: { severe: "doubt", major: "doubt", minor: "doubt" } },
    });
    expect(await lenient.pipeline.run(lenient.cardId)).toMatchObject({ conclusion: "doubt", returned: false });
    const major = { verdict: "issues", summary: "", issues: [{ severity: "major", text: "edge case" }] };
    const strict = setup({
      replies: [major],
      tuning: { severityMap: { severe: "fail", major: "fail", minor: "doubt" } },
    });
    expect(await strict.pipeline.run(strict.cardId)).toMatchObject({ conclusion: "fail", returned: true });
    expect(strict.sent[0]!.prompt).toContain("edge case");
  });

  it("maxReviewReturns 0: the very first severe review is only doubtful", async () => {
    const h = setup({ maxReviewReturns: 0, replies: [severe] });
    expect(await h.pipeline.run(h.cardId)).toMatchObject({ conclusion: "doubt", returned: false });
  });

  it("writes the reviewer's conclusion and the return reason to the card's group chat, once per verification", async () => {
    const h = setup({ replies: [severe] });
    const result = await h.pipeline.run(h.cardId);
    const chats = h.board.events.list(h.cardId).filter((e) => e.type === "chat");
    expect(chats).toHaveLength(1);
    expect(chats[0]).toMatchObject({
      authorKind: "reviewer",
      author: "Reviewer",
      body: { kind: "verdict", agentId: "reviewer-1", key: `review:${result!.verificationId}` },
    });
    expect((chats[0]!.body as { text: string }).text).toContain("src/a.ts:12");
    // the same verification never writes a second conclusion
    h.board.cards.addChat({ cardId: h.cardId, authorKind: "reviewer", text: "again", key: `review:${result!.verificationId}` });
    expect(h.board.events.list(h.cardId).filter((e) => e.type === "chat")).toHaveLength(1);
    // the automatic return explains itself (system line in the chat), the verification line carries counts
    const events = h.board.events.list(h.cardId);
    expect((events.find((e) => e.type === "reject")!.body as { text: string }).text).toContain("复核发现严重问题");
    expect(JSON.stringify(events.find((e) => (e.body as { kind?: string }).kind === "verification")!.body)).toContain("失败 1");
  });

  it("formats the chat texts", () => {
    expect(reviewChatText("pass", "ok", [])).toBe("复核通过：ok");
    expect(reviewChatText("severe", "", ["[severe] a.ts bug"])).toContain("- [severe] a.ts bug");
    expect(reviewChatText("issues", "", [], "超时")).toBe("复核没有完成：超时");
    expect(returnReason(false, [{ text: "login fails" }])).toBe("验证未通过，已自动退回执行 agent：login fails");
    expect(verificationLine("fail", [{ judgement: "fail" }, { judgement: "pass" }], "abcdef123456", false)).toBe(
      "验证未通过（通过 1 / 存疑 0 / 失败 1）· 提交 abcdef12",
    );
  });

  it("an unparsable review is doubtful, never a return", async () => {
    const h = setup({ replies: ["I could not decide."] });
    const result = await h.pipeline.run(h.cardId);
    expect(result).toMatchObject({ conclusion: "doubt", returned: false });
  });
});
