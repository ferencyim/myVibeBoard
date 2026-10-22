import { describe, expect, it } from "vitest";
import type { CardView } from "../shared/vibe/contract";
import { applyPending, settle } from "../client/detail/optimistic";

const card = { id: "c", priority: "none", tags: ["a"], presetId: null, reviewerPresetId: null, needsEvidence: false } as unknown as CardView;

describe("optimistic card picks", () => {
  it("lays pending picks over the server card and maps tagIds to tags", () => {
    const view = applyPending(card, {
      presetId: { value: "p1", seq: 1 },
      tagIds: { value: ["a", "b"], seq: 2 },
    });
    expect(view.presetId).toBe("p1");
    expect(view.tags).toEqual(["a", "b"]);
    expect(view.priority).toBe("none");
  });

  it("returns the same object when nothing is pending", () => {
    expect(applyPending(card, {})).toBe(card);
  });

  it("settling an older write keeps a newer pick of the same field", () => {
    const pending = { reviewerPresetId: { value: "p2", seq: 5 }, priority: { value: "high", seq: 3 } };
    const left = settle(pending as never, { reviewerPresetId: 4, priority: 3 });
    expect(left).toEqual({ reviewerPresetId: { value: "p2", seq: 5 } });
  });
});
