import { describe, expect, it } from "vitest";
import { computePickerPlacement } from "./placement";

const viewport = { width: 1200, height: 800 };

describe("computePickerPlacement", () => {
  it("opens below, right-aligned, 8 away from the trigger", () => {
    const result = computePickerPlacement({
      anchor: { x: 900, y: 40, width: 200, height: 28 },
      viewport,
    });
    expect(result.side).toBe("bottom");
    expect(result.top).toBe(76);
    expect(result.bottom).toBeUndefined();
    expect(result.width).toBe(360);
    expect(result.left).toBe(740);
  });

  it("flips above when the room below is smaller than the content and above is larger", () => {
    const result = computePickerPlacement({
      anchor: { x: 100, y: 740, width: 200, height: 28 },
      viewport,
    });
    expect(result.side).toBe("top");
    expect(result.bottom).toBe(68);
    expect(result.top).toBeUndefined();
    expect(result.maxHeight).toBe(520);
  });

  it("stays below when both sides are cramped and below is larger", () => {
    const result = computePickerPlacement({
      anchor: { x: 100, y: 100, width: 100, height: 28 },
      viewport: { width: 600, height: 300 },
    });
    expect(result.side).toBe("bottom");
    expect(result.maxHeight).toBeLessThanOrEqual(300 - 128 - 16);
  });

  it("caps the height at the room on the chosen side", () => {
    const result = computePickerPlacement({
      anchor: { x: 100, y: 500, width: 100, height: 28 },
      viewport,
    });
    expect(result.side).toBe("top");
    expect(result.maxHeight).toBe(484);
    expect(result.minHeight).toBe(226);
  });

  it("caps at the viewport minus 100", () => {
    const result = computePickerPlacement({
      anchor: { x: 100, y: 10, width: 100, height: 28 },
      viewport: { width: 800, height: 500 },
    });
    expect(result.maxHeight).toBe(400);
  });

  it("clamps horizontally to the viewport edge", () => {
    const left = computePickerPlacement({
      anchor: { x: 0, y: 10, width: 60, height: 28 },
      viewport,
    });
    expect(left.left).toBe(8);
    const right = computePickerPlacement({
      anchor: { x: 1180, y: 10, width: 60, height: 28 },
      viewport,
    });
    expect(right.left + right.width).toBe(1192);
  });

  it("narrows to the viewport minus 24 on small screens", () => {
    const result = computePickerPlacement({
      anchor: { x: 200, y: 10, width: 100, height: 28 },
      viewport: { width: 320, height: 640 },
    });
    expect(result.width).toBe(296);
    expect(result.left).toBe(8);
  });

  it("matches the trigger width for the field variant", () => {
    const result = computePickerPlacement({
      anchor: { x: 50, y: 10, width: 240, height: 44 },
      viewport,
      matchAnchorWidth: true,
    });
    expect(result.width).toBe(240);
    expect(result.left).toBe(50);
  });
});
