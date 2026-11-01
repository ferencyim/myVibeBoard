import { describe, expect, it } from "vitest";
import type { ModelGroup, ProviderUsage } from "@getpaseo/protocol/messages";
import { selectModelGroupEntry } from "./model-groups.js";

const group: ModelGroup = {
  id: "g",
  name: "Group",
  entries: [
    { order: 2, provider: "b", model: "b1" },
    { order: 1, provider: "a", model: "a1" },
    { order: 2, provider: "c", model: "c1" },
  ],
};
const available = async () => ({ available: true, error: null });

describe("model group selection", () => {
  it("sorts by order stably and selects the next equal-order entry", async () => {
    expect((await selectModelGroupEntry(group, available, [])).entry?.provider).toBe("a");
    expect(
      (await selectModelGroupEntry(group, available, [], group.entries[0])).entry?.provider,
    ).toBe("c");
  });
  it("skips unavailable providers and exhausted usage, reporting each reason", async () => {
    const usage = [{ providerId: "b", windows: [{ remainingPct: 0 }] }] as ProviderUsage[];
    const result = await selectModelGroupEntry(
      group,
      async (provider) => ({
        available: provider !== "a",
        error: provider === "a" ? "not installed" : null,
      }),
      usage,
    );
    expect(result.entry?.provider).toBe("c");
    expect(result.reasons).toEqual(["a/a1: not installed", "b/b1: usage exhausted"]);
    expect(
      (
        await selectModelGroupEntry(
          { ...group, entries: group.entries.slice(0, 2) },
          async () => ({ available: false, error: "offline" }),
          [],
        )
      ).reasons,
    ).toHaveLength(2);
  });
});
