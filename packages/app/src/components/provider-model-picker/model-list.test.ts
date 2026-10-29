import { describe, expect, it } from "vitest";
import type { ProviderSelectionModelRow } from "@/provider-selection/provider-selection";
import {
  cleanModelName,
  filterModelGroups,
  flattenModelGroups,
  groupModelItems,
  moveHighlight,
  resolveEffortControlKind,
  toModelItem,
} from "./model-list";

function row(modelId: string, modelLabel: string, isDefault = false): ProviderSelectionModelRow {
  return {
    favoriteKey: `p:${modelId}`,
    provider: "p",
    providerLabel: "P",
    modelId,
    modelLabel,
    isDefault,
  };
}

describe("model list", () => {
  it("cleans leading noise and falls back to the id", () => {
    expect(cleanModelName("  : - Opus", "opus")).toBe("Opus");
    expect(cleanModelName(" - ", "opus")).toBe("opus");
  });

  it("splits a service prefix off the label", () => {
    expect(toModelItem(row("a", "zai/glm-5"))).toMatchObject({ service: "zai", name: "glm-5" });
    expect(toModelItem(row("a", "Opus 5"))).toMatchObject({ service: null, name: "Opus 5" });
    expect(toModelItem(row("a", "trailing/"))).toMatchObject({ service: null });
  });

  it("groups by service in first-seen order", () => {
    const items = [row("1", "a/x"), row("2", "b/y"), row("3", "a/z")].map(toModelItem);
    const groups = groupModelItems(items);
    expect(groups.map((g) => g.service)).toEqual(["a", "b"]);
    expect(groups[0].items.map((i) => i.name)).toEqual(["x", "z"]);
  });

  it("filters on service plus name and drops empty groups", () => {
    const groups = groupModelItems(
      [row("1", "Alpha/Fast"), row("2", "Beta/Slow"), row("3", "Plain")].map(toModelItem),
    );
    expect(filterModelGroups(groups, "alpha").map((g) => g.service)).toEqual(["Alpha"]);
    expect(flattenModelGroups(filterModelGroups(groups, "SLOW"))).toHaveLength(1);
    expect(filterModelGroups(groups, "zzz")).toEqual([]);
    expect(filterModelGroups(groups, "  ")).toBe(groups);
  });

  it("moves the highlight with wrap-around", () => {
    expect(moveHighlight(-1, 1, 3)).toBe(0);
    expect(moveHighlight(-1, -1, 3)).toBe(2);
    expect(moveHighlight(2, 1, 3)).toBe(0);
    expect(moveHighlight(0, -1, 3)).toBe(2);
    expect(moveHighlight(0, 1, 0)).toBe(-1);
  });

  it("picks segmented only for short option sets", () => {
    expect(resolveEffortControlKind(["低", "中", "高"])).toBe("segmented");
    expect(resolveEffortControlKind(["a", "b", "c", "d", "e", "f"])).toBe("select");
    expect(resolveEffortControlKind(["Low", "Medium", "High", "Extra high", "Maximum"])).toBe(
      "select",
    );
  });
});
