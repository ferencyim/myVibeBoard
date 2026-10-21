// Pure text <-> value helpers of the settings fields (kept free of UI imports so tests can load them).

/** Clamp typed text into [min, max]; text that is not a number keeps `fallback`. */
export function clampNumber(text: string, min: number, max: number, fallback: number, integer: boolean): number {
  const n = Number(text);
  if (text.trim() === "" || !Number.isFinite(n)) return fallback;
  const clamped = Math.min(max, Math.max(min, n));
  return integer ? Math.round(clamped) : clamped;
}

/** "a, b ,c" -> ["a","b","c"]. */
export function parseList(text: string): string[] {
  return text.split(/[,\s]+/).map((w) => w.trim()).filter(Boolean);
}

/** "claude=3600, codex=300" -> record; pairs that do not parse are dropped. */
export function parseMap(text: string, valueType: "string" | "number"): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const pair of text.split(",")) {
    const at = pair.indexOf("=");
    if (at <= 0) continue;
    const key = pair.slice(0, at).trim();
    const raw = pair.slice(at + 1).trim();
    if (!key || !raw) continue;
    if (valueType === "string") out[key] = raw;
    else if (Number.isFinite(Number(raw)) && Number(raw) > 0) out[key] = Number(raw);
  }
  return out;
}

export const formatMap = (value: unknown): string =>
  Object.entries((value ?? {}) as Record<string, unknown>)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(", ");
