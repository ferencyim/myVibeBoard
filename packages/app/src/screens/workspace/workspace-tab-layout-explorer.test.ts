import { describe, expect, it } from "vitest";
import { computeWorkspaceTabLayout } from "@/screens/workspace/workspace-tab-layout";

const explorer = {
  rowHorizontalInset: 0,
  actionsReservedWidth: 27,
  rowPaddingHorizontal: 4,
  tabGap: 4,
  minTabWidth: 64,
  maxTabWidth: 160,
  tabIconWidth: 14,
  tabContentGap: 4,
  tabHorizontalPadding: 10,
  closeButtonWidth: 0,
};
const input = { viewportWidth: 218, tabLabelWidths: [32, 32, 32], compact: false };

describe("explorer sidebar tab row", () => {
  it("three tabs scroll with a 64px minimum but all keep their labels with 52px", () => {
    expect(
      computeWorkspaceTabLayout({ ...input, metrics: explorer }).requiresHorizontalScrollFallback,
    ).toBe(true);
    const narrow = computeWorkspaceTabLayout({
      ...input,
      metrics: { ...explorer, minTabWidth: 52 },
    });
    expect(narrow.requiresHorizontalScrollFallback).toBe(false);
    expect(narrow.items.every((item) => item.showLabel)).toBe(true);
  });
});
