import { describe, expect, it } from "vitest";
import { discard, edit, initialDraft, isDirty, reconcileField } from "../client/detail/draft";

describe("detail field drafts", () => {
  it("keeps a dirty field when the server value changes", () => {
    const d = edit(initialDraft("a"), "abc");
    expect(reconcileField(d, "other")).toBe(d);
    expect(isDirty(reconcileField(d, "other"))).toBe(true);
  });

  it("follows the server when not dirty", () => {
    expect(reconcileField(initialDraft("a"), "b")).toEqual({ local: "b", base: "b" });
  });

  it("syncs once a save lands on the server", () => {
    const d = edit(initialDraft("a"), "abc");
    const saved = reconcileField(d, "abc");
    expect(saved).toEqual({ local: "abc", base: "abc" });
    expect(isDirty(saved)).toBe(false);
    expect(reconcileField(saved, "next").local).toBe("next");
  });

  it("syncs after discarding or editing back to the base", () => {
    const d = edit(initialDraft("a"), "abc");
    expect(discard("b")).toEqual({ local: "b", base: "b" });
    const back = edit(d, "a");
    expect(isDirty(back)).toBe(false);
    expect(reconcileField(back, "z").local).toBe("z");
  });

  it("treats fields independently", () => {
    let title = edit(initialDraft("t"), "t2");
    let desc = initialDraft("d");
    title = reconcileField(title, "t-server");
    desc = reconcileField(desc, "d-server");
    expect(title.local).toBe("t2");
    expect(desc.local).toBe("d-server");
  });
});
