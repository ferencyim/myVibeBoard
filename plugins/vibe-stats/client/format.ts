export function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

export const fmtCost = (usd: number): string => `$${usd >= 100 ? usd.toFixed(0) : usd.toFixed(2)}`;

/** Cost with an explicit note for tokens that could not be priced ("price unknown" when none could). */
export function fmtCostNote(usd: number, unpricedTokens: number): string {
  if (unpricedTokens <= 0) return fmtCost(usd);
  const note = `${fmtTokens(unpricedTokens)} tok unpriced`;
  return usd > 0 ? `${fmtCost(usd)} + ${note}` : `price unknown (${note})`;
}

export const fmtRate = (v: number | null): string => (v === null ? "-" : `${v.toFixed(1)} tok/s`);

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export const fmtPct = (fraction: number): string => `${Math.round(fraction * 100)}%`;

/** Width fractions of a stacked bar; empty input yields zeros. */
export function shares(parts: readonly number[]): number[] {
  const total = parts.reduce((a, b) => a + b, 0);
  return parts.map((p) => (total > 0 ? p / total : 0));
}
