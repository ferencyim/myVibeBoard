import { describe, expect, it } from "vitest";
import {
  defaultStepGroupExpanded,
  isStepGroupExpanded,
  setStepGroupExpanded,
} from "./step-expansion";

describe("step group expansion", () => {
  it("keeps compact sheets closed until explicitly opened", () => {
    const initial = defaultStepGroupExpanded(true, true);
    expect(initial).toBe(false);
    const opened = setStepGroupExpanded(initial, new Set(), "turn", true);
    expect(isStepGroupExpanded(initial, opened, "turn")).toBe(true);
    expect(defaultStepGroupExpanded(true, false)).toBe(true);
  });
  it.each([false, true])("toggles and restores the %s default", (defaultExpanded) => {
    const overrides = new Set<string>();
    expect(isStepGroupExpanded(defaultExpanded, overrides, "turn")).toBe(defaultExpanded);
    const toggled = setStepGroupExpanded(defaultExpanded, overrides, "turn", !defaultExpanded);
    expect(isStepGroupExpanded(defaultExpanded, toggled, "turn")).toBe(!defaultExpanded);
    const restored = setStepGroupExpanded(defaultExpanded, toggled, "turn", defaultExpanded);
    expect(restored.size).toBe(0);
  });
});
