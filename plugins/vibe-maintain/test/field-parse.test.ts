import { describe, expect, it } from "vitest";
import { clampNumber, formatMap, parseList, parseMap } from "../client/field-parse";

describe("settings field parsing", () => {
  it("clamps numbers and keeps the fallback for junk", () => {
    expect(clampNumber("50", 1, 20, 3, true)).toBe(20);
    expect(clampNumber("0.2", 1, 20, 3, false)).toBe(1);
    expect(clampNumber("4.6", 1, 20, 3, true)).toBe(5);
    expect(clampNumber("abc", 1, 20, 3, true)).toBe(3);
    expect(clampNumber("", 1, 20, 3, true)).toBe(3);
  });

  it("parses lists and key=value maps", () => {
    expect(parseList("claude, codex  kimi,")).toEqual(["claude", "codex", "kimi"]);
    expect(parseMap("claude=3600, codex=300, bad, x=, y=-1, z=abc", "number")).toEqual({ claude: 3600, codex: 300 });
    expect(parseMap("claude=/compact, kimi = /summarize", "string")).toEqual({ claude: "/compact", kimi: "/summarize" });
    expect(formatMap({ claude: 3600, codex: 300 })).toBe("claude=3600, codex=300");
    expect(formatMap(undefined)).toBe("");
  });
});
