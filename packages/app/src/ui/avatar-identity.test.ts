import { describe, expect, it } from "vitest";
import { avatarHue, avatarIdentity, avatarInitial } from "./avatar-identity";

describe("avatar initials", () => {
  it.each([
    [" 小明", "小"],
    [" alice smith ", "A"],
    ["Bob", "B"],
    ["𠮷野", "𠮷"],
    ["", "?"],
    ["  ", "?"],
  ])("uses the first character of %j", (name, initial) => {
    expect(avatarInitial(name)).toBe(initial);
  });
});

describe("avatar hue", () => {
  it("is deterministic, bounded, and depends on the complete seed", () => {
    expect(avatarHue("alice")).toBe(avatarHue("alice"));
    expect(avatarHue("alice")).not.toBe(avatarHue("alicia"));
    for (const seed of ["", "a", "小明", "𠮷野", "😀"]) {
      expect(avatarHue(seed)).toBeGreaterThanOrEqual(0);
      expect(avatarHue(seed)).toBeLessThan(360);
    }
  });

  it.each([
    [390, 30],
    [-30, 330],
    [720, 0],
    [12.5, 12.5],
  ])("normalizes an explicit hue of %s to %s", (hue, expected) =>
    expect(avatarHue("ignored", hue)).toBe(expected),
  );

  it("uses the seed for non-finite hues", () => {
    expect(avatarHue("alice", Number.NaN)).toBe(avatarHue("alice"));
    expect(avatarHue("alice", Number.POSITIVE_INFINITY)).toBe(avatarHue("alice"));
  });

  it("keeps identity color independent from the display name", () => {
    const first = avatarIdentity({ seed: "bot-1", name: "助手" });
    const renamed = avatarIdentity({ seed: "bot-1", name: "Helper" });
    expect(first.backgroundColor).toBe(renamed.backgroundColor);
    expect(first.initial).toBe("助");
    expect(renamed.initial).toBe("H");
    expect(avatarIdentity({ seed: "bot-1", name: "Helper", hue: 60 }).backgroundColor).toBe(
      "hsl(60, 48%, 32%)",
    );
  });
});
