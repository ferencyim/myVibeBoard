import type { Judgement } from "./vibe/contract";

/** fail beats doubt beats pass; an unjudged item counts as doubt. */
export function aggregate(judgements: ReadonlyArray<Judgement | null>): Judgement {
  if (judgements.includes("fail")) return "fail";
  if (judgements.length === 0 || judgements.some((j) => j === null || j === "doubt"))
    return "doubt";
  return "pass";
}
