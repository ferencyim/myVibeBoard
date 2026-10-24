import type { Judgement } from "../../shared/vibe/contract";
export const JUDGEMENT_LABELS: Record<Judgement, string> = {
  pass: "通过",
  doubt: "存疑",
  fail: "失败",
};
export const SEVERITY_LABELS = { severe: "严重", major: "主要", minor: "次要" };
export const fileName = (path: string) => path.split(/[\\/]/).pop() || path;

export function aggregate(judgements: ReadonlyArray<Judgement | null>): Judgement {
  if (judgements.includes("fail")) return "fail";
  if (judgements.length === 0 || judgements.some((j) => j === null || j === "doubt"))
    return "doubt";
  return "pass";
}

export const dataUri = (mimeType: string, base64: string) => `data:${mimeType};base64,${base64}`;

/** Decode a base64 text file for the excerpt view; cut at `max` characters. */
export function textExcerpt(base64: string, max = 4000): { text: string; truncated: boolean } {
  let text: string;
  try {
    const bin = atob(base64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    text = new TextDecoder("utf-8").decode(bytes);
  } catch {
    return { text: "（无法解码）", truncated: false };
  }
  return text.length > max
    ? { text: text.slice(0, max), truncated: true }
    : { text, truncated: false };
}
