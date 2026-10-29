import { describe, expect, it } from "vitest";
import { parseVisualMessage } from "./message";

describe("visual reply messages", () => {
  it("accepts only bounded known messages", () => {
    expect(parseVisualMessage({ type: "height", height: 5000 })).toEqual({
      type: "height",
      height: 2000,
    });
    expect(parseVisualMessage({ type: "height", height: Infinity })).toBeNull();
    expect(parseVisualMessage({ type: "draft", text: "x".repeat(2001) })).toBeNull();
    expect(parseVisualMessage({ type: "draft", text: "ok", extra: true })).toBeNull();
    expect(parseVisualMessage({ type: "navigate", url: "https://example.com" })).toBeNull();
  });
});
