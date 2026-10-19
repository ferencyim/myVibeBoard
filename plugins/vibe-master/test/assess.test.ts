import { describe, expect, it } from "vitest";
import { contentHash, createAssessor, lastAssessmentMarker } from "../server/assess/assess";
import { jsonCandidates, parseReply } from "../server/assess/parse";
import { AssessmentSchema } from "../server/assess/schema";
import { createQuotaReader, quotaFromUsage } from "../server/subscription/quota";
import { ManualClock, assessmentJson, setupBoard } from "./helpers";
import type { MasterAsk } from "../server/types";

function assessorFor(board: ReturnType<typeof setupBoard>, replies: string[], quota = {}) {
  const prompts: string[] = [];
  const master: MasterAsk = {
    async ask(prompt) {
      prompts.push(prompt);
      const next = replies.shift();
      if (next === undefined) throw new Error("no more scripted replies");
      return next;
    },
  };
  const clock = new ManualClock();
  const reader = createQuotaReader({
    getPaseo: () => ({
      providers: {
        listModels: async () => ({}),
        listUsage: async () => ({
          providers: Object.entries(quota).map(([providerId, remainingPct]) => ({
            providerId,
            windows: [{ remainingPct: remainingPct as number }],
          })),
        }),
      },
    }),
    tightPct: () => 20,
    clock,
  });
  const assessor = createAssessor({ db: board.db, store: board.store, master, quota: reader });
  return { assessor, prompts };
}

describe("reply parsing", () => {
  it("finds fenced and bare JSON objects", () => {
    expect(jsonCandidates('prose ```json\n{"a":1}\n``` more')).toContain('{"a":1}');
    expect(jsonCandidates('here {"a":{"b":"}"}} tail')[0]).toBe('{"a":{"b":"}"}}');
  });

  it("validates against the assessment schema", () => {
    expect(parseReply(assessmentJson(), AssessmentSchema).ok).toBe(true);
    const bad = parseReply(assessmentJson({ estimate: { size: "HUGE", rationale: "x" } }), AssessmentSchema);
    expect(bad.ok).toBe(false);
    const noChecks = parseReply(assessmentJson({ checks: [] }), AssessmentSchema);
    expect(noChecks.ok).toBe(false);
    const noQuestion = parseReply(
      assessmentJson({ clarity: { status: "needs_clarification", summary: "vague", questions: [] } }),
      AssessmentSchema,
    );
    expect(noQuestion.ok).toBe(false);
  });
});

describe("draft assessment write-back", () => {
  it("writes the evaluation comment, the plan checks and the suggested preset, and moves nothing", async () => {
    const board = setupBoard();
    const card = board.draft("Add dark mode toggle", { priority: "high" });
    const { assessor, prompts } = assessorFor(board, [assessmentJson()]);

    const outcome = await assessor.assess(card.key);
    expect(outcome.status).toBe("assessed");

    const events = board.store.events.list(card.id).filter((e) => e.type === "evaluation");
    expect(events).toHaveLength(1);
    const body = events[0]!.body as { kind: string; text: string; assessment: { estimate: { size: string } }; contentHash: string };
    expect(body.kind).toBe("assessment");
    expect(body.assessment.estimate.size).toBe("M");
    expect(body.text).toContain("Recommended agent: Claude Opus");
    expect(events[0]!.authorKind).toBe("agent");

    // checks go to the latest plan version, which vibe-verify reads
    const plan = board.store.plans.list(card.id).at(-1)!;
    expect(plan.snapshot.checks.map((c) => c.text)).toEqual([
      "The new button is visible on the home screen",
      "Unit tests pass",
    ]);
    expect(plan.snapshot.recommendedPresetId).toBe(board.presets.claude.id);
    expect(board.store.cards.get(card.id)!.suggestedPresetId).toBe(board.presets.claude.id);

    // never moves a card, never touches the owner's fields
    const after = board.store.cards.get(card.id)!;
    expect(after.column).toBe("draft");
    expect(after.title).toBe(card.title);
    expect(board.eventTypes()).not.toContain("card.moved");
    expect(board.eventTypes()).toContain("card.assessed");
    expect(() => board.store.cards.move(card.id, { to: "todo", actor: "master" })).toThrow();

    // static rules live in the system prompt, the wake message carries project + card only
    expect(prompts[0]).toContain("[wake:assess_draft]");
    expect(prompts[0]).toContain("Tag vocabulary:");
    expect(prompts[0]).toContain("Add dark mode toggle");
  });

  it("asks once more for invalid JSON and records a failure when it stays invalid", async () => {
    const board = setupBoard();
    const ok = board.draft("Repairable");
    const first = assessorFor(board, ["not json at all", assessmentJson()]);
    expect((await first.assessor.assess(ok.key)).status).toBe("assessed");
    expect(first.prompts).toHaveLength(2);
    expect(first.prompts[1]).toContain("rejected");

    const hopeless = board.draft("Hopeless");
    const second = assessorFor(board, ["nope", "still nope"]);
    const outcome = await second.assessor.assess(hopeless.key);
    expect(outcome.status).toBe("failed");
    const events = board.store.events.list(hopeless.id);
    expect(events.some((e) => e.type === "evaluation")).toBe(false);
    expect(lastAssessmentMarker(events)).toMatchObject({ failed: true });
    // same content is not retried automatically, an edit is
    const third = assessorFor(board, [assessmentJson()]);
    expect(await third.assessor.assess(hopeless.key)).toEqual({ status: "skipped", reason: "unchanged" });
    board.store.cards.update(hopeless.id, { description: "now with more detail" });
    expect((await third.assessor.assess(hopeless.key)).status).toBe("assessed");
  });

  it("skips unchanged drafts, re-assesses edited ones and ignores non-drafts", async () => {
    const board = setupBoard();
    const card = board.draft("Idempotent");
    const { assessor } = assessorFor(board, [assessmentJson(), assessmentJson()]);
    expect((await assessor.assess(card.key)).status).toBe("assessed");
    expect(await assessor.assess(card.key)).toEqual({ status: "skipped", reason: "unchanged" });
    // the write-back itself (suggested preset) did not change the content hash
    expect(contentHash(board.store.cards.get(card.id)!, [])).toBe(
      lastAssessmentMarker(board.store.events.list(card.id))!.hash,
    );
    board.store.cards.update(card.id, { acceptance: "- it works" });
    expect((await assessor.assess(card.key)).status).toBe("assessed");
    expect(board.store.plans.list(card.id)).toHaveLength(2);

    board.store.cards.move(card.id, { to: "todo", actor: "user" });
    expect(await assessor.assess(card.key)).toEqual({ status: "skipped", reason: "not_draft" });
  });

  it("drops a result when the owner edited the card while the master was thinking", async () => {
    const board = setupBoard();
    const card = board.draft("Moving target");
    const { assessor } = assessorFor(board, [assessmentJson()]);
    const pending = assessor.assess(card.key);
    board.store.cards.update(card.id, { description: "edited during the assessment" });
    expect(await pending).toEqual({ status: "skipped", reason: "stale" });
    expect(board.store.events.list(card.id).some((e) => e.type === "evaluation")).toBe(false);
  });

  it("keeps only known related cards and vocabulary tags", async () => {
    const board = setupBoard();
    const other = board.draft("Existing work");
    const card = board.draft("Needs filtering");
    const { assessor } = assessorFor(board, [
      assessmentJson({
        tags: ["bug", "made-up-tag"],
        related: [
          { card: other.key, relation: "duplicate", note: "same" },
          { card: "DEMO-999", relation: "conflict", note: "imaginary" },
          { card: card.key, relation: "related", note: "itself" },
        ],
      }),
    ]);
    const outcome = await assessor.assess(card.key);
    if (outcome.status !== "assessed") throw new Error("expected an assessment");
    expect(outcome.applied.tags).toEqual(["bug"]);
    expect(outcome.applied.related.map((r) => r.card)).toEqual([other.key]);
  });

  it("applies the quota policy by card priority", async () => {
    // codex recommended, but exhausted: replaced; the replacement is explained
    const board = setupBoard();
    const low = board.draft("Low priority", { priority: "low" });
    const rec = { recommendation: { agent: "codex", preset: "Codex Max", reason: "best at tests" } };
    const exhausted = assessorFor(board, [assessmentJson(rec)], { codex: 0, claude: 80, kimi: 60 });
    const o1 = await exhausted.assessor.assess(low.key);
    if (o1.status !== "assessed") throw new Error("expected an assessment");
    expect(o1.applied.presetName).not.toBe("Codex Max");
    expect(o1.applied.adjustment).toContain("codex quota is exhausted");

    // tight: a low-priority card does not get it, an urgent one keeps it
    const board2 = setupBoard();
    const lowCard = board2.draft("Tight low", { priority: "low" });
    const urgentCard = board2.draft("Tight urgent", { priority: "urgent" });
    const tight = assessorFor(board2, [assessmentJson(rec), assessmentJson(rec)], { codex: 10, claude: 90, kimi: 90 });
    const a = await tight.assessor.assess(lowCard.key);
    const b = await tight.assessor.assess(urgentCard.key);
    if (a.status !== "assessed" || b.status !== "assessed") throw new Error("expected assessments");
    expect(a.applied.presetName).not.toBe("Codex Max");
    expect(b.applied.presetName).toBe("Codex Max");
    expect(b.applied.adjustment).toBeNull();
  });
});

describe("quota helpers", () => {
  it("takes the most constrained window and classifies levels", () => {
    const q = quotaFromUsage(
      [
        { providerId: "Claude", windows: [{ remainingPct: 70 }, { usedPct: 92 }] },
        { providerId: "codex", windows: [{ remainingPct: 1 }] },
        { providerId: "kimi", windows: [] },
      ],
      20,
    );
    expect(q.claude).toMatchObject({ remainingPct: 8, level: "tight" });
    expect(q.codex?.level).toBe("exhausted");
    expect(q.kimi?.level).toBe("unknown");
  });
});
