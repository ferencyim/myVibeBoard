/** Replaceable token estimator. Default is a cheap heuristic: CJK ~1 token/char, others ~4 chars/token. */
export type TokenEstimator = (text: string) => number;

const CJK = /[⺀-鿿가-힯豈-﫿＀-￯]/g;

export const estimateTokens: TokenEstimator = (text) => {
  if (!text) return 0;
  const cjk = text.match(CJK)?.length ?? 0;
  return cjk + Math.ceil((text.length - cjk) / 4);
};
