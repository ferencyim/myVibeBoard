/**
 * Where the provider/model picker popover goes. Pure so the flip / edge-clamp / height-cap rules
 * can be tested without a renderer.
 *
 * Preferred position is below the trigger, right-aligned. When the content does not fit below and
 * there is more room above, it opens above. The height cap is the smaller of 520, the viewport
 * minus 100, and the room on the chosen side, so the list scrolls instead of leaving the screen.
 */

export interface PickerRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PickerViewport {
  width: number;
  height: number;
}

export interface PickerPlacement {
  side: "bottom" | "top";
  left: number;
  /** Set when side is "bottom": distance from the viewport top. */
  top: number | undefined;
  /** Set when side is "top": distance from the viewport bottom, so the panel grows upward. */
  bottom: number | undefined;
  width: number;
  maxHeight: number;
  minHeight: number;
}

export const PICKER_GAP = 8;
export const PICKER_EDGE = 8;
export const PICKER_MAX_WIDTH = 360;
export const PICKER_MIN_HEIGHT = 226;
export const PICKER_MAX_HEIGHT = 520;
const VIEWPORT_RESERVE = 100;
const SIDE_FLOOR = 120;

export function computePickerPlacement(input: {
  anchor: PickerRect;
  viewport: PickerViewport;
  /** Natural content height when known; defaults to the cap. */
  contentHeight?: number;
  /** Field variant: the popover is exactly as wide as the trigger. */
  matchAnchorWidth?: boolean;
}): PickerPlacement {
  const { anchor, viewport } = input;
  const width = input.matchAnchorWidth
    ? Math.min(Math.max(anchor.width, 1), viewport.width - PICKER_EDGE * 2)
    : Math.min(PICKER_MAX_WIDTH, viewport.width - 24);
  const rightAligned = anchor.x + anchor.width - width;
  const left = Math.max(PICKER_EDGE, Math.min(viewport.width - width - PICKER_EDGE, rightAligned));

  const cap = Math.max(1, Math.min(PICKER_MAX_HEIGHT, viewport.height - VIEWPORT_RESERVE));
  const spaceBelow = viewport.height - (anchor.y + anchor.height) - PICKER_GAP - PICKER_EDGE;
  const spaceAbove = anchor.y - PICKER_GAP - PICKER_EDGE;
  const needed = Math.min(input.contentHeight ?? cap, cap);
  const side = spaceBelow >= needed || spaceAbove <= spaceBelow ? "bottom" : "top";
  const room = Math.max(side === "bottom" ? spaceBelow : spaceAbove, 0);
  const maxHeight = Math.min(cap, Math.max(room, Math.min(SIDE_FLOOR, cap)));
  return {
    side,
    left,
    top: side === "bottom" ? anchor.y + anchor.height + PICKER_GAP : undefined,
    bottom: side === "top" ? viewport.height - anchor.y + PICKER_GAP : undefined,
    width,
    maxHeight,
    minHeight: Math.min(PICKER_MIN_HEIGHT, maxHeight),
  };
}
