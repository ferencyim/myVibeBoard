import { describe, expect, it } from "vitest";
import { effectiveChanges } from "../server/assess/proposal";

describe("effectiveChanges", () => {
  it("drops blank and unchanged fields", () => {
    const card = { title: "T", description: "D\r\n", acceptance: "" };
    expect(effectiveChanges(card, { title: "T", description: "D", rationale: "r" })).toBeNull();
    expect(effectiveChanges(card, { title: " ", acceptance: "A", rationale: "r" })).toEqual({ acceptance: "A" });
    expect(effectiveChanges(card, undefined)).toBeNull();
  });
});
