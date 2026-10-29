import { describe, expect, it } from "vitest";
import { sortPageRailItems } from "./page-rail-model";

describe("page rail ordering", () => {
  it("orders contributions deterministically without changing registrations", () => {
    const items = [
      { key: "scheduler", order: 30 },
      { key: "bot", order: 0 },
      { key: "routine", order: 10 },
      { key: "prompts", order: 20 },
      { key: "usage", order: 40 },
    ];
    expect(sortPageRailItems(items).map((item) => item.key)).toEqual([
      "bot",
      "routine",
      "prompts",
      "scheduler",
      "usage",
    ]);
    expect(items[0]?.key).toBe("scheduler");
  });
});
