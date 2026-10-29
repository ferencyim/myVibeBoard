import { describe, expect, it } from "vitest";
import { nativeQuoteOffset } from "./native-quote-position";

describe("native quote navigation", () => {
  it("centers a measured live row when possible", () => {
    expect(nativeQuoteOffset(700, 100, 600)).toBe(500);
  });
  it("does not scroll past the bottom for a nearby row", () => {
    expect(nativeQuoteOffset(20, 50, 600)).toBe(0);
  });
});
