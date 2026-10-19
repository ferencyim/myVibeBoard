// Estimated prices in USD per 1M tokens. Best-effort defaults for cost *estimates*; a LiteLLM-format
// file (the dataset ccusage uses) can override them via the `pricingFile` setting.

export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type PriceOverrides = Record<string, Price>;

const p = (input: number, output: number, cacheRead: number, cacheWrite: number): Price => ({
  input,
  output,
  cacheRead,
  cacheWrite,
});

// Models whose price is not known: no entry is better than a made-up one. They show as "unpriced" until
// the user supplies a LiteLLM-format price file (`pricingFile`), which is checked before this list.
const UNPRICED: RegExp[] = [/fable/, /(opus|sonnet|haiku)-5/, /gpt-6/];

// First match wins.
const TABLE: Array<[RegExp, Price]> = [
  [/opus-4-?[01](?!\d)|claude-opus-4$|opus-4-2025/, p(15, 75, 1.5, 18.75)],
  [/opus/, p(5, 25, 0.5, 6.25)],
  [/sonnet/, p(3, 15, 0.3, 3.75)],
  [/haiku-3-5|3-5-haiku/, p(0.8, 4, 0.08, 1)],
  [/haiku/, p(1, 5, 0.1, 1.25)],
  [/gpt-5.*mini/, p(0.25, 2, 0.025, 0)],
  [/gpt-5.*nano/, p(0.05, 0.4, 0.005, 0)],
  [/gpt-5|codex/, p(1.25, 10, 0.125, 0)],
  [/deepseek/, p(0.28, 0.42, 0.028, 0)],
  [/kimi|moonshot/, p(0.6, 2.5, 0.15, 0)],
];

const normalize = (model: string): string => model.toLowerCase().replace(/^[a-z-]+\//, "");

export function priceFor(model: string, overrides: PriceOverrides = {}): Price | null {
  const name = normalize(model);
  const exact = overrides[name] ?? overrides[model];
  if (exact) return exact;
  if (UNPRICED.some((re) => re.test(name))) return null;
  for (const [re, price] of TABLE) if (re.test(name)) return price;
  return null;
}

export interface TokenCounts {
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
}

export function estimateCost(
  model: string,
  t: TokenCounts,
  overrides?: PriceOverrides,
): number | null {
  const price = priceFor(model, overrides);
  if (!price) return null;
  return (
    (t.tokensIn * price.input +
      t.tokensOut * price.output +
      t.tokensCacheRead * price.cacheRead +
      t.tokensCacheWrite * price.cacheWrite) /
    1_000_000
  );
}

/** Convert a LiteLLM `model_prices_and_context_window.json` object into overrides. */
export function parseLiteLlmPrices(json: unknown): PriceOverrides {
  const out: PriceOverrides = {};
  if (!json || typeof json !== "object") return out;
  for (const [name, raw] of Object.entries(json as Record<string, unknown>)) {
    const v = raw as Record<string, unknown> | null;
    if (!v || typeof v.input_cost_per_token !== "number") continue;
    const num = (x: unknown) => (typeof x === "number" ? x * 1_000_000 : 0);
    out[normalize(name)] = {
      input: num(v.input_cost_per_token),
      output: num(v.output_cost_per_token),
      cacheRead: num(v.cache_read_input_token_cost),
      cacheWrite: num(v.cache_creation_input_token_cost),
    };
  }
  return out;
}
