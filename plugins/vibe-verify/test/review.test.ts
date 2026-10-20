import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createPipeline } from "../server/pipeline";
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

function setup(options: { maxReviewReturns?: number; replies: unknown[]; reviewer?: boolean }) {
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
    maxReviewReturns: options.maxReviewReturns,
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

  it("an unparsable review is doubtful, never a return", async () => {
    const h = setup({ replies: ["I could not decide."] });
    const result = await h.pipeline.run(h.cardId);
    expect(result).toMatchObject({ conclusion: "doubt", returned: false });
  });
});
