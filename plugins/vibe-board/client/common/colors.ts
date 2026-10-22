// Priority and tag color groups. Pure (no React) so it is unit-testable in plain node.
// Priorities run cold -> warm by urgency; tags use a separate cool/neutral-hue palette without
// the red/orange range, so the two never look alike on a card or in a picker.

import type { CardPriority, Tag } from "../../shared/vibe/contract";

export const PRIORITY_COLORS: Record<CardPriority, string> = {
  none: "#94a3b8",
  low: "#38bdf8",
  medium: "#eab308",
  high: "#f97316",
  urgent: "#ef4444",
};

export const TAG_PALETTE = [
  "#8b5cf6",
  "#14b8a6",
  "#ec4899",
  "#6366f1",
  "#06b6d4",
  "#84cc16",
  "#d946ef",
  "#a16207",
];

export const HEX_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** The tag's own color, else a stable palette pick derived from its id. */
export function tagColor(tag: Pick<Tag, "id" | "color">): string {
  const own = tag.color?.trim();
  if (own && HEX_COLOR.test(own)) return own;
  let h = 0;
  for (const ch of tag.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TAG_PALETTE[h % TAG_PALETTE.length]!;
}

/** `#rgb`/`#rrggbb` + alpha (0..1) -> `#rrggbbaa`; non-hex input is returned unchanged. */
export function withAlpha(color: string, alpha: number): string {
  if (!HEX_COLOR.test(color)) return color;
  const full = color.length === 4 ? `#${[...color.slice(1)].map((c) => c + c).join("")}` : color;
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `${full}${a}`;
}
