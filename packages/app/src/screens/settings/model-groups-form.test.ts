import { describe, expect, it } from "vitest";
import { sortModelGroupEntries } from "./model-groups-form";

describe("sortModelGroupEntries", () => {
  it("sorts each group's entries by order without mutating the input", () => {
    const groups = [
      {
        id: "a",
        name: "组",
        entries: [
          { order: 3, provider: "p", model: "three" },
          { order: 1, provider: "p", model: "one" },
          { order: 1, provider: "p", model: "also-one" },
        ],
      },
    ];
    expect(sortModelGroupEntries(groups)[0].entries.map((entry) => entry.model)).toEqual([
      "one",
      "also-one",
      "three",
    ]);
    expect(groups[0].entries[0].model).toBe("three");
  });
});
