// WP-108 client helpers: default models shown on the pickers, the verifier gate of 立即执行, the
// review conversation and the six tabs' unread markers.

import { describe, expect, it } from "vitest";
import { chatItemsOf, defaultChoice, missingVerifier, resolvedPreset, reviewItemsOf } from "../client/planning/logic";
import { isTabUnread, markReadPatch, unreadTabsOf, type CardEvent, type CardView, type Preset } from "../shared/vibe/contract";

const preset = (id: string, name: string) => ({ id, name, provider: "claude", model: "m", roleHints: [] }) as unknown as Preset;
const presets = [preset("a", "A"), preset("b", "B")];
const card = (over: Partial<CardView> = {}) =>
  ({ verifierPresetId: null, plannerPresetId: null, reviewerPresetId: null, presetId: null, ...over }) as CardView;

describe("default models on the card", () => {
  const scope = { project: { defaultPresets: { verifier: "a" } }, global: { verifier: "b", planner: "b" }, presets };

  it("names the default a job falls back to", () => {
    expect(defaultChoice("verifier", scope)).toBe("A（项目默认）");
    expect(defaultChoice("planner", scope)).toBe("B（全局默认）");
    expect(defaultChoice("worker", scope)).toBeNull();
    // On the project form the project's own value is what is edited: show the global one.
    expect(defaultChoice("verifier", scope, "project")).toBe("B（全局默认）");
  });

  it("resolves card -> project -> global and gates 立即执行 on a verification model", () => {
    expect(resolvedPreset("verifier", card({ verifierPresetId: "b" }), scope)?.name).toBe("B");
    expect(resolvedPreset("verifier", card(), scope)?.name).toBe("A");
    expect(missingVerifier(card(), scope)).toBe(false);
    expect(missingVerifier(card(), { project: { defaultPresets: {} }, global: {}, presets })).toBe(true);
    // A deleted preset does not count.
    expect(missingVerifier(card({ verifierPresetId: "gone" }), { project: null, global: {}, presets })).toBe(true);
  });
});

describe("review tab", () => {
  const ev = (over: Partial<CardEvent>): CardEvent =>
    ({ id: String(Math.random()), cardId: "c", type: "chat", authorKind: "user", author: "", body: {}, createdAt: "t", updatedHlc: "", ...over }) as CardEvent;

  it("holds the review conclusions and the returns they caused; the plan reviewer speaks in the plan conversation", () => {
    const verdict = ev({ authorKind: "reviewer", body: { text: "严重问题", kind: "verdict", thread: "review" } });
    const back = ev({ type: "reject", authorKind: "system", body: { text: "复核发现严重问题", reviewReturn: true } });
    const failedCheck = ev({ type: "reject", authorKind: "system", body: { text: "验证未通过" } });
    const planReview = ev({ authorKind: "reviewer", body: { text: "缺少回滚", kind: "verdict", thread: "plan" } });
    const events = [verdict, back, failedCheck, planReview];
    expect(chatItemsOf(events, "review").map((i) => (i.kind === "proposal" ? "" : i.text))).toEqual([
      "严重问题",
      "退回：复核发现严重问题",
    ]);
    expect(reviewItemsOf(events).map((i) => i.text)).toEqual(["严重问题"]);
    const plan = chatItemsOf(events, "plan");
    expect(plan).toMatchObject([{ kind: "message", label: "方案复核", text: "缺少回滚" }]);
  });

  it("the six tabs: four carry unread markers, the review tab among them", () => {
    const c = {
      planActivityAt: "1",
      execActivityAt: null,
      reviewActivityAt: "2",
      verifyActivityAt: "3",
      planSeenAt: "1",
      execSeenAt: null,
      reviewSeenAt: null,
      verifySeenAt: null,
    };
    expect(unreadTabsOf(c)).toEqual(["review", "verify"]);
    expect(isTabUnread(c, "review")).toBe(true);
    expect(markReadPatch(c, "review")).toEqual({ reviewSeenAt: "2" });
    expect(markReadPatch(c, "plan")).toBeNull();
  });
});
