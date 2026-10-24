export const HEX_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** `#rgb`/`#rrggbb` + alpha (0..1) -> `#rrggbbaa`; non-hex input is returned unchanged. */
export function withAlpha(color: string, alpha: number): string {
  if (!HEX_COLOR.test(color)) return color;
  const full =
    color.length === 4
      ? `#${color
          .slice(1)
          .split("")
          .map((c) => c + c)
          .join("")}`
      : color;
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `${full}${a}`;
}
